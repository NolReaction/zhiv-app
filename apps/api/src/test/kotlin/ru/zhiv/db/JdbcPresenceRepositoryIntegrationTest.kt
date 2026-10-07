package ru.zhiv.db

import com.zaxxer.hikari.HikariConfig
import com.zaxxer.hikari.HikariDataSource
import io.ktor.client.request.*
import io.ktor.client.statement.bodyAsText
import io.ktor.http.*
import io.ktor.server.testing.testApplication
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import org.junit.jupiter.api.AfterAll
import org.junit.jupiter.api.BeforeAll
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.TestInstance
import org.testcontainers.containers.PostgreSQLContainer
import org.testcontainers.junit.jupiter.Container
import org.testcontainers.junit.jupiter.Testcontainers
import ru.zhiv.auth.AuthFailure
import ru.zhiv.config.AppConfig
import ru.zhiv.installZhivApi
import ru.zhiv.presence.*
import ru.zhiv.security.TokenCodec
import java.time.Instant
import java.util.UUID
import kotlin.test.*

@Testcontainers(disabledWithoutDocker = true)
@TestInstance(TestInstance.Lifecycle.PER_CLASS)
class JdbcPresenceRepositoryIntegrationTest {
    private class Postgres(image: String) : PostgreSQLContainer<Postgres>(image)
    companion object { @Container private val postgres = Postgres("postgres:18-alpine") }
    private lateinit var source: HikariDataSource
    private lateinit var config: AppConfig
    private lateinit var identities: JdbcZhivRepository
    private val tokens = TokenCodec()
    private val base = Instant.parse("2026-01-01T12:00:00Z")
    private data class Player(val id: UUID, val publicId: String, val raw: String, val hash: ByteArray)

    @BeforeAll fun setup() {
        config = AppConfig(postgres.jdbcUrl, postgres.username, postgres.password, false, setOf("http://localhost"))
        source = DatabaseFactory.create(config)
        DatabaseFactory.migrate(source)
        identities = JdbcZhivRepository(source)
    }
    @AfterAll fun close() { source.close() }
    private fun execute(sql: String, vararg values: Any?) = source.connection.use { c ->
        c.economyUpdate(sql, *values).also { c.commit() }
    }
    private fun scalar(sql: String, vararg values: Any?): Long = source.connection.use { c ->
        c.economyRows(sql, *values) { it.getLong(1) }.single()
    }
    private suspend fun player(): Player {
        val token = tokens.issue()
        val user = identities.bootstrap("Присутствие", tokens.issue().hash, token.hash, 365)
        return Player(user.id, user.publicId, token.raw, token.hash)
    }
    private fun resume() = PresenceRequest("resume", UUID.randomUUID().toString(), 0, true)
    private fun PresenceRequest.beat(sequence: Long, active: Boolean = false) = copy(kind = "heartbeat", sequence = sequence, active = active)

    @Test fun `heartbeats cannot keep an idle player active and replay cannot revive an expired session`() = runBlocking<Unit> {
        val p = player(); var now = base
        val repository = JdbcPresenceRepository(source) { now }
        val opened = resume()
        assertEquals("active", repository.update(p.hash, opened).status)
        for (index in 1L..9L) {
            now = base.plusSeconds(index * 30)
            assertEquals("active", repository.update(p.hash, opened.beat(index)).status)
        }
        now = base.plusSeconds(300)
        val idle = repository.update(p.hash, opened.beat(10, active = true))
        assertEquals("idle", idle.status)
        assertEquals(300L, idle.onlineTodaySeconds)
        assertEquals("idle", repository.update(p.hash, opened).status)
        assertEquals("idle", repository.update(p.hash, opened.beat(11, active = true)).status)
        assertEquals("GAME_SESSION_INACTIVE", assertFailsWith<AuthFailure> { repository.requireActive(p.hash, UUID.fromString(opened.presenceId)) }.code)
        assertNotNull(identities.findBySession(p.hash), "AFK keeps account authentication")
        val returned = resume()
        assertEquals("active", repository.update(p.hash, returned).status)
        repository.requireActive(p.hash, UUID.fromString(returned.presenceId))
    }

    @Test fun `input extends inactivity only through a new accepted request`() = runBlocking<Unit> {
        val p = player(); var now = base
        val repository = JdbcPresenceRepository(source) { now }; val opened = resume()
        repository.update(p.hash, opened)
        now = base.plusSeconds(30)
        val input = opened.beat(1, true)
        val first = repository.update(p.hash, input)
        now = base.plusSeconds(60)
        assertEquals(first.idleExpiresAt, repository.update(p.hash, input).idleExpiresAt)
        assertEquals(first.leaseExpiresAt, repository.update(p.hash, input).leaseExpiresAt)
        assertEquals(30L, repository.update(p.hash, opened).onlineTodaySeconds)
        assertEquals("PRESENCE_CONFLICT", assertFailsWith<AuthFailure> { repository.update(p.hash, input.copy(active = false)) }.code)
        val second = repository.update(p.hash, opened.beat(2, true))
        assertEquals(base.plusSeconds(360).toString(), second.idleExpiresAt)
        assertEquals(60L, second.onlineTodaySeconds)
    }

    @Test fun `disconnect gaps and suspend tails never accrue and new presence is bound to its login`() = runBlocking<Unit> {
        val p = player(); var now = base
        val repository = JdbcPresenceRepository(source) { now }; val opened = resume()
        repository.update(p.hash, opened)
        now = base.plusSeconds(30)
        repository.update(p.hash, opened.beat(1))
        now = base.plusSeconds(150)
        val lost = repository.update(p.hash, opened.beat(2, true))
        assertEquals("disconnected", lost.status)
        assertEquals(30L, lost.onlineTodaySeconds)
        assertEquals("disconnected", repository.update(p.hash, opened).status)
        val returned = resume(); repository.update(p.hash, returned)
        now = base.plusSeconds(180)
        val suspended = repository.update(p.hash, returned.copy(kind = "suspend", sequence = 1, active = false))
        assertEquals("suspended", suspended.status)
        assertEquals(60L, suspended.onlineTodaySeconds)
        now = base.plusSeconds(190)
        assertEquals("suspended", repository.update(p.hash, returned).status)
        val stranger = player()
        assertEquals("PRESENCE_CONFLICT", assertFailsWith<AuthFailure> { repository.update(stranger.hash, returned) }.code)
        assertEquals("GAME_SESSION_INACTIVE", assertFailsWith<AuthFailure> { repository.requireActive(stranger.hash, UUID.fromString(returned.presenceId)) }.code)
        execute("UPDATE app_sessions SET revoked_at=clock_timestamp() WHERE token_hash=?", p.hash)
        assertEquals("UNAUTHORIZED", assertFailsWith<AuthFailure> { repository.update(p.hash, resume()) }.code)
    }

    @Test fun `concurrent tabs and devices credit the union of confirmed intervals`() = runBlocking<Unit> {
        val p = player(); var now = base
        val repository = JdbcPresenceRepository(source) { now }; val a = resume(); val b = resume()
        val device = tokens.issue()
        execute("INSERT INTO app_sessions(user_id,token_hash,expires_at) VALUES (?,?,clock_timestamp()+interval '1 year')", p.id, device.hash)
        repository.update(p.hash, a)
        now = base.plusSeconds(10); repository.update(device.hash, b)
        now = base.plusSeconds(30)
        coroutineScope { listOf(async { repository.update(p.hash, a.beat(1, true)) }, async { repository.update(device.hash, b.beat(1, true)) }).awaitAll() }
        now = base.plusSeconds(60)
        coroutineScope { listOf(async { repository.update(p.hash, a.beat(2, true)) }, async { repository.update(device.hash, b.beat(2, true)) }).awaitAll() }
        assertEquals(60_000L, scalar("SELECT online_millis FROM game_presence_daily WHERE user_id=?", p.id))
        assertEquals("GAME_SESSION_INACTIVE", assertFailsWith<AuthFailure> { repository.requireActive(device.hash, UUID.fromString(a.presenceId)) }.code)
    }

    @Test fun `late delivery from an earlier tab credits a missing prefix exactly once`() = runBlocking<Unit> {
        val p = player(); var now = base
        val repository = JdbcPresenceRepository(source) { now }; val a = resume(); val b = resume()
        repository.update(p.hash, a)
        now = base.plusSeconds(10); repository.update(p.hash, b)
        now = base.plusSeconds(40); repository.update(p.hash, b.beat(1, true))
        now = base.plusSeconds(50); repository.update(p.hash, a.beat(1, true))
        assertEquals(50_000L, scalar("SELECT online_millis FROM game_presence_daily WHERE user_id=?", p.id))
        now = base.plusSeconds(70); repository.update(p.hash, b.beat(2, true))
        assertEquals(70_000L, scalar("SELECT online_millis FROM game_presence_daily WHERE user_id=?", p.id))
        now = base.plusSeconds(100); repository.update(p.hash, a.beat(2, true))
        now = base.plusSeconds(130); repository.update(p.hash, b.beat(3, true))
        assertEquals(130_000L, scalar("SELECT online_millis FROM game_presence_daily WHERE user_id=?", p.id))
    }

    @Test fun `UTC midnight divides confirmed time into distinct days`() = runBlocking<Unit> {
        val p = player(); var now = Instant.parse("2026-01-01T23:59:45Z")
        val repository = JdbcPresenceRepository(source) { now }; val opened = resume()
        repository.update(p.hash, opened)
        now = now.plusSeconds(30)
        assertEquals(15L, repository.update(p.hash, opened.beat(1, true)).onlineTodaySeconds)
        assertEquals(15_000L, scalar("SELECT online_millis FROM game_presence_daily WHERE user_id=? AND day='2026-01-01'", p.id))
        assertEquals(15_000L, scalar("SELECT online_millis FROM game_presence_daily WHERE user_id=? AND day='2026-01-02'", p.id))
    }

    @Test fun `strictly more than twenty hours adds an observation note once without banning`() = runBlocking<Unit> {
        val p = player(); var now = base
        val repository = JdbcPresenceRepository(source) { now }; val opened = resume()
        repository.update(p.hash, opened)
        execute("INSERT INTO game_presence_daily(user_id,day,online_millis) VALUES (?,'2026-01-01',71970000)", p.id)
        now = base.plusSeconds(30); repository.update(p.hash, opened.beat(1, true))
        assertEquals(0L, scalar("SELECT count(*) FROM game_presence_daily WHERE user_id=? AND flagged_at IS NOT NULL", p.id))
        now = base.plusSeconds(60); repository.update(p.hash, opened.beat(2, true))
        assertEquals(1L, scalar("SELECT count(*) FROM app_users WHERE id=? AND tap_watchlisted AND banned_at IS NULL", p.id))
        assertEquals(1L, scalar("SELECT count(*) FROM game_presence_daily WHERE user_id=? AND flagged_at IS NOT NULL", p.id))
        execute("UPDATE app_users SET tap_watchlisted=false WHERE id=?", p.id)
        now = base.plusSeconds(90); repository.update(p.hash, opened.beat(3, true))
        assertEquals(0L, scalar("SELECT count(*) FROM app_users WHERE id=? AND tap_watchlisted", p.id), "manual review is respected for the already flagged day")
        assertNotNull(identities.findBySession(p.hash))
    }

    @Test fun `runtime role can account time and flag observation without migration metadata access`() = runBlocking<Unit> {
        val p = player(); var now = base
        execute("CREATE ROLE presence_runtime NOLOGIN")
        execute("GRANT USAGE ON SCHEMA public TO presence_runtime")
        execute("GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO presence_runtime")
        execute("REVOKE ALL ON TABLE flyway_schema_history FROM presence_runtime")
        HikariDataSource(HikariConfig().apply {
            jdbcUrl = postgres.jdbcUrl; username = postgres.username; password = postgres.password
            maximumPoolSize = 2; isAutoCommit = false; connectionInitSql = "SET ROLE presence_runtime"
        }).use { runtime ->
            val repository = JdbcPresenceRepository(runtime) { now }; val opened = resume()
            repository.update(p.hash, opened)
            execute("INSERT INTO game_presence_daily(user_id,day,online_millis) VALUES (?,'2026-01-01',72000000)", p.id)
            now = base.plusSeconds(30)
            assertEquals(72030L, repository.update(p.hash, opened.beat(1, true)).onlineTodaySeconds)
            repository.requireActive(p.hash, UUID.fromString(opened.presenceId))
            assertEquals(1L, scalar("SELECT count(*) FROM app_users WHERE id=? AND tap_watchlisted", p.id))
        }
    }

    @Test fun `merging takes conservative daily maximum and suspends both existing capabilities`() = runBlocking<Unit> {
        val a = player(); val b = player(); val repository = JdbcPresenceRepository(source) { base }
        val ar = resume(); val br = resume(); repository.update(a.hash, ar); repository.update(b.hash, br)
        execute("INSERT INTO game_presence_daily(user_id,day,online_millis) VALUES (?,'2026-01-01',40000),(?,'2026-01-01',60000)", a.id, b.id)
        source.connection.use { c -> mergeGamePresence(c, a.id, b.id); c.commit() }
        assertEquals(60_000L, scalar("SELECT online_millis FROM game_presence_daily WHERE user_id=?", a.id))
        assertEquals(0L, scalar("SELECT count(*) FROM game_presence_daily WHERE user_id=?", b.id))
        assertEquals("suspended", repository.update(a.hash, ar).status)
        assertEquals("suspended", repository.update(b.hash, br).status)
    }

    @Test fun `every gameplay writer requires live presence while reads and account access remain available`() = testApplication {
        val p = runBlocking { player() }; var now = base
        val repository = JdbcPresenceRepository(source) { now }
        application { installZhivApi(identities, identities, config, presence = repository,
            worlds = JdbcWorldRepository(source), games = JdbcGameRepository(source), economy = JdbcEconomyRepository(source),
            economyMarket = JdbcEconomyMarketRepository(source), economyBarter = JdbcEconomyBarterRepository(source),
            forestMemory = JdbcForestMemoryRepository(source), progressionRewards = JdbcProgressionRewardsRepository(source)) }
        for (path in listOf("/api/v1/economy/commands", "/api/v1/economy/market/commands", "/api/v1/economy/barter/commands",
            "/api/v1/world/commands", "/api/v1/world/forest-memory/commands", "/api/v1/game/sessions", "/api/v1/game/batches", "/api/v1/game/rewards/claims")) {
            val response = client.post(path) { cookie(config.cookieName, p.raw); header(HttpHeaders.Origin, "http://localhost"); contentType(ContentType.Application.Json); setBody("{}") }
            assertEquals(HttpStatusCode.Conflict, response.status, path)
            assertTrue(response.bodyAsText().contains("GAME_SESSION_INACTIVE"), path)
        }
        assertEquals(HttpStatusCode.OK, client.get("/api/v1/economy") { cookie(config.cookieName, p.raw) }.status)
        assertEquals(HttpStatusCode.Unauthorized, client.post("/api/v1/presence") { header(HttpHeaders.Origin, "http://localhost"); contentType(ContentType.Application.Json); setBody("{}") }.status)
        assertEquals(HttpStatusCode.Forbidden, client.post("/api/v1/presence") { cookie(config.cookieName, p.raw); header(HttpHeaders.Origin, "https://untrusted.invalid"); contentType(ContentType.Application.Json); setBody("{}") }.status)
        val opened = resume()
        val initial = client.post("/api/v1/presence") { cookie(config.cookieName, p.raw); header(HttpHeaders.Origin, "http://localhost"); contentType(ContentType.Application.Json); setBody(Json.encodeToString(opened)) }
        assertEquals(HttpStatusCode.OK, initial.status)
        assertEquals("no-store", initial.headers[HttpHeaders.CacheControl])
        now = base.plusSeconds(301)
        val expired = client.post("/api/v1/game/sessions") { cookie(config.cookieName, p.raw); header(HttpHeaders.Origin, "http://localhost"); header(PRESENCE_HEADER, opened.presenceId); contentType(ContentType.Application.Json); setBody("{}") }
        assertEquals(HttpStatusCode.Conflict, expired.status)
        val replay = client.post("/api/v1/presence") { cookie(config.cookieName, p.raw); header(HttpHeaders.Origin, "http://localhost"); contentType(ContentType.Application.Json); setBody(Json.encodeToString(opened)) }
        assertTrue(replay.bodyAsText().contains("\"status\":\"idle\""))
    }
}
