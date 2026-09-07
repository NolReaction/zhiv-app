package ru.zhiv.db

import com.zaxxer.hikari.HikariDataSource
import io.ktor.client.request.*
import io.ktor.client.statement.bodyAsText
import io.ktor.http.*
import io.ktor.server.testing.testApplication
import kotlinx.coroutines.*
import kotlinx.serialization.json.*
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
import ru.zhiv.security.TokenCodec
import java.time.OffsetDateTime
import java.time.ZoneOffset
import java.util.UUID
import kotlin.test.*

@Testcontainers(disabledWithoutDocker = true)
@TestInstance(TestInstance.Lifecycle.PER_CLASS)
class JdbcGameRepositoryIntegrationTest {
    private class Postgres(image: String) : PostgreSQLContainer<Postgres>(image)
    companion object { @Container private val postgres = Postgres("postgres:18-alpine") }
    private lateinit var source: HikariDataSource
    private lateinit var identities: JdbcZhivRepository
    private lateinit var games: JdbcGameRepository
    private lateinit var config: AppConfig
    private val tokens = TokenCodec()
    private data class Player(val id: UUID, val publicId: String, val hash: ByteArray, val raw: String)
    @BeforeAll fun setup() {
        config = AppConfig(postgres.jdbcUrl, postgres.username, postgres.password, false, setOf("http://localhost"))
        source = DatabaseFactory.create(config)
        DatabaseFactory.migrate(source)
        identities = JdbcZhivRepository(source)
        games = JdbcGameRepository(source)
    }
    @AfterAll fun close() { source.close() }
    private fun execute(sql: String, vararg values: Any?) = source.connection.use { c ->
        c.prepareStatement(sql).use { s -> values.forEachIndexed { i, v -> s.setObject(i + 1, v) }; s.executeUpdate() }.also { c.commit() }
    }
    private suspend fun player(name: String = "Игрок"): Player {
        val token = tokens.issue()
        val user = identities.bootstrap(name, tokens.issue().hash, token.hash, 365)
        return Player(user.id, user.publicId, token.hash, token.raw)
    }
    private fun secondDevice(player: Player): ByteArray {
        val token = tokens.issue()
        execute("INSERT INTO app_sessions(user_id,token_hash,expires_at) VALUES (?,?,clock_timestamp()+interval '1 year')", player.id, token.hash)
        return token.hash
    }
    private suspend fun session(player: Player, hash: ByteArray = player.hash) = games.openSession(hash, UUID.randomUUID(), player.publicId)
    private suspend fun score(player: Player, count: Int): Long {
        val session = session(player)
        return games.submitBatch(player.hash, UUID.fromString(session.sessionId), 1, count, UUID.randomUUID()).progress.monthlyTaps
    }

    @Test fun `new accounts start private and exact batch retries never increase accepted totals`() = runBlocking<Unit> {
        val p = player()
        val empty = games.progress(p.hash)
        assertEquals(0L, empty.lifetimeTaps)
        assertFalse(empty.leaderboardOptIn)
        val key = UUID.randomUUID()
        val session = games.openSession(p.hash, key, p.publicId)
        assertEquals(session.sessionId, games.openSession(p.hash, key, p.publicId).sessionId)
        val id = UUID.fromString(session.sessionId); val run = UUID.randomUUID()
        val first = games.submitBatch(p.hash, id, 1, 12, run)
        assertEquals(12, first.acceptedTaps)
        val replay = games.submitBatch(p.hash, id, 1, 12, run)
        assertTrue(replay.replayed)
        assertEquals(12L, replay.progress.lifetimeTaps)
        assertEquals("GAME_SEQUENCE_CONFLICT", assertFailsWith<AuthFailure> { games.submitBatch(p.hash, id, 1, 13, run) }.code)
        assertEquals("GAME_SEQUENCE_CONFLICT", assertFailsWith<AuthFailure> { games.submitBatch(p.hash, id, 3, 1, run) }.code)
        val second = games.submitBatch(p.hash, id, 2, 8, run)
        assertEquals(20L, second.progress.bestSeries)
        assertEquals(20L, second.progress.lifetimeTaps)
        assertEquals(3L, games.openSession(p.hash, key, p.publicId).nextSequence)
        assertEquals("GAME_SEQUENCE_CONFLICT", assertFailsWith<AuthFailure> { games.submitBatch(p.hash, id, 1, 12, run) }.code)
        assertEquals(0L, identities.findBySession(p.hash)!!.checkInCount, "game taps must never write check-ins")
    }

    @Test fun `concurrent devices and new repository instances share a persistent user budget`() = runBlocking<Unit> {
        val p = player(); val otherHash = secondDevice(p)
        val a = session(p); val b = session(p, otherHash)
        execute("UPDATE game_profiles SET bucket_tokens=60,bucket_updated_at=clock_timestamp()+interval '1 minute' WHERE user_id=?", p.id)
        val results = coroutineScope {
            listOf(
                async(Dispatchers.IO) { games.submitBatch(p.hash, UUID.fromString(a.sessionId), 1, 60, UUID.randomUUID()) },
                async(Dispatchers.IO) { JdbcGameRepository(source).submitBatch(otherHash, UUID.fromString(b.sessionId), 1, 60, UUID.randomUUID()) },
            ).awaitAll()
        }
        assertEquals(60, results.sumOf { it.acceptedTaps })
        assertEquals(60, results.sumOf { it.rejectedTaps })
        assertEquals(60L, games.progress(p.hash).lifetimeTaps)
        val next = session(p)
        assertEquals(0, games.submitBatch(p.hash, UUID.fromString(next.sessionId), 1, 60, UUID.randomUUID()).acceptedTaps)
        assertEquals("GAME_SESSION_CONFLICT", assertFailsWith<AuthFailure> {
            games.submitBatch(otherHash, UUID.fromString(a.sessionId), 2, 1, UUID.randomUUID())
        }.code)
    }

    @Test fun `only server receipts extend a record and timezone changes cannot choose scoring month`() = runBlocking<Unit> {
        val p = player(); val session = session(p); val id = UUID.fromString(session.sessionId); val run = UUID.randomUUID()
        val first = games.submitBatch(p.hash, id, 1, 10, run)
        val second = games.submitBatch(p.hash, id, 2, 4, UUID.randomUUID())
        assertEquals(10L, second.progress.bestSeries)
        val third = games.submitBatch(p.hash, id, 3, 6, UUID.randomUUID())
        assertEquals(10L, third.progress.bestSeries)
        identities.updateTimeZone(p.hash, "Pacific/Kiritimati", UUID.randomUUID())
        identities.updateTimeZone(p.hash, "Etc/GMT+12", UUID.randomUUID())
        val progress = games.progress(p.hash)
        assertEquals(first.progress.month, progress.month)
        assertEquals(20L, progress.monthlyTaps)
        assertEquals(20L, progress.lifetimeTaps)
    }

    @Test fun `expired previous month sessions cannot carry a new batch into this month`() = runBlocking<Unit> {
        val p = player(); val session = session(p); val id = UUID.fromString(session.sessionId)
        val currentMonth = OffsetDateTime.parse(session.progress.serverTime).withOffsetSameInstant(ZoneOffset.UTC).toLocalDate().withDayOfMonth(1)
        val boundary = currentMonth.atStartOfDay().atOffset(ZoneOffset.UTC)
        execute("UPDATE game_sessions SET month=?,created_at=?,expires_at=? WHERE id=?", currentMonth.minusMonths(1), boundary.minusMinutes(5), boundary, id)
        assertEquals("GAME_SESSION_EXPIRED", assertFailsWith<AuthFailure> { games.submitBatch(p.hash, id, 1, 60, UUID.randomUUID()) }.code)
        assertEquals(0L, games.progress(p.hash).monthlyTaps)
        val newSession = session(p)
        assertEquals(currentMonth.toString().take(7), newSession.progress.month)
        assertTrue(OffsetDateTime.parse(newSession.expiresAt) <= currentMonth.plusMonths(1).atStartOfDay().atOffset(ZoneOffset.UTC))
    }

    @Test fun `visibility requires opt in and stale or different owner writes cannot republish`() = runBlocking<Unit> {
        val p = player(); val other = player()
        score(p, 20)
        assertFalse(games.leaderboard(other.hash).entries.any { it.isMe })
        val yes = games.setVisibility(p.hash, true, 0, p.publicId)
        assertEquals(1L, yes.visibilityVersion)
        assertEquals(yes.visibilityVersion, games.setVisibility(p.hash, true, 0, p.publicId).visibilityVersion)
        assertNotNull(games.leaderboard(p.hash).myRank)
        val no = games.setVisibility(p.hash, false, 1, p.publicId)
        assertEquals(2L, no.visibilityVersion)
        assertEquals("GAME_VISIBILITY_CONFLICT", assertFailsWith<AuthFailure> { games.setVisibility(p.hash, true, 0, p.publicId) }.code)
        assertNull(games.leaderboard(p.hash).myRank)
        assertEquals("GAME_OWNER_CHANGED", assertFailsWith<AuthFailure> { games.setVisibility(other.hash, true, 0, p.publicId) }.code)
        assertEquals("GAME_OWNER_CHANGED", assertFailsWith<AuthFailure> { games.openSession(other.hash, UUID.randomUUID(), p.publicId) }.code)
        assertFalse(games.progress(other.hash).leaderboardOptIn)
    }

    @Test fun `leaderboard is top 100 but returns own rank outside it without contact identifiers`() = runBlocking<Unit> {
        val p = player(); score(p, 1); games.setVisibility(p.hash, true, 0, p.publicId)
        execute("""
            INSERT INTO app_users(public_id,display_name)
            SELECT 'RANK-0000-' || lpad(i::text,4,'0'),'Игрок ' || i FROM generate_series(1,105) i
        """.trimIndent())
        execute("INSERT INTO game_profiles(user_id,lifetime_taps,leaderboard_opt_in) SELECT id,1000,true FROM app_users WHERE public_id LIKE 'RANK-0000-%'")
        execute("""
            INSERT INTO game_monthly_scores(user_id,month,taps)
            SELECT id,date_trunc('month',clock_timestamp() AT TIME ZONE 'UTC')::date,1000 FROM app_users WHERE public_id LIKE 'RANK-0000-%'
        """.trimIndent())
        val board = games.leaderboard(p.hash)
        assertEquals(100, board.entries.size)
        assertTrue(assertNotNull(board.myRank) > 100)
        assertTrue(board.entries.zipWithNext().all { (a,b) -> a.rank + 1 == b.rank && a.taps >= b.taps })
        assertEquals(p.publicId, board.ownerPublicId)
        assertEquals(1L, board.monthlyTaps)
    }

    @Test fun `HTTP guards reject anonymous writes untrusted origins and invented totals`() = testApplication {
        application { installZhivApi(identities, identities, config, games = games) }
        val p = player()
        val cookie = "${config.cookieName}=${p.raw}"
        assertEquals(HttpStatusCode.Unauthorized, client.get("/api/v1/game/leaderboard").status)
        val body = """{"requestId":"${UUID.randomUUID()}","ownerPublicId":"${p.publicId}"}"""
        val forbidden = client.post("/api/v1/game/sessions") {
            contentType(ContentType.Application.Json); header(HttpHeaders.Cookie,cookie); header(HttpHeaders.Origin,"https://other.example"); setBody(body)
        }
        assertEquals(HttpStatusCode.Forbidden, forbidden.status)
        val opened = client.post("/api/v1/game/sessions") {
            contentType(ContentType.Application.Json); header(HttpHeaders.Cookie,cookie); setBody(body)
        }
        assertEquals(HttpStatusCode.OK, opened.status)
        assertEquals("no-store", opened.headers[HttpHeaders.CacheControl])
        val id = Json.parseToJsonElement(opened.bodyAsText()).jsonObject.getValue("sessionId").jsonPrimitive.content
        val invented = client.post("/api/v1/game/batches") {
            contentType(ContentType.Application.Json); header(HttpHeaders.Cookie,cookie)
            setBody("""{"sessionId":"$id","sequence":1,"tapCount":10,"runId":"${UUID.randomUUID()}","lifetimeTaps":999999}""")
        }
        assertEquals(HttpStatusCode.BadRequest, invented.status)
        assertEquals(0L, games.progress(p.hash).lifetimeTaps)
        execute("UPDATE app_sessions SET revoked_at=clock_timestamp() WHERE token_hash=?",p.hash)
        assertEquals(HttpStatusCode.Unauthorized, client.get("/api/v1/game/progress") { header(HttpHeaders.Cookie,cookie) }.status)
    }

    @Test fun `session renewal carries a recent run once without combining active parallel games`() = runBlocking<Unit> {
        val p = player(); val run = UUID.randomUUID()
        val original = session(p); val originalId = UUID.fromString(original.sessionId)
        games.submitBatch(p.hash, originalId, 1, 20, run)
        val parallel = session(p)
        val independent = games.submitBatch(p.hash, UUID.fromString(parallel.sessionId), 1, 5, run)
        assertEquals(20L, independent.progress.bestSeries, "active sessions must not borrow each other's run")
        // Deterministically expire the predecessor with a recent receipt. Clamp at its
        // month's end so this fixture also works during the first seconds of a month.
        val instant = OffsetDateTime.parse(games.progress(p.hash).serverTime)
        val created = instant.minusSeconds(5)
        val scoreMonth = created.withOffsetSameInstant(ZoneOffset.UTC).toLocalDate().withDayOfMonth(1)
        val expiry = minOf(instant.minusNanos(1_000_000), scoreMonth.plusMonths(1).atStartOfDay().atOffset(ZoneOffset.UTC))
        val acceptedAt = expiry.minusNanos(1_000_000)
        execute("UPDATE game_sessions SET month=?,created_at=?,expires_at=?,last_batch_at=?,run_updated_at=? WHERE id=?", scoreMonth, created, expiry, acceptedAt, acceptedAt, originalId)
        val renewed = session(p); val renewedId = UUID.fromString(renewed.sessionId)
        val continued = games.submitBatch(p.hash, renewedId, 1, 5, run)
        assertEquals(25L, continued.progress.bestSeries)
        assertEquals(30L, continued.progress.lifetimeTaps)
        val replay = games.submitBatch(p.hash, renewedId, 1, 5, run)
        assertTrue(replay.replayed)
        assertEquals(25L, replay.progress.bestSeries)
        assertEquals(30L, replay.progress.lifetimeTaps)
        val extra = session(p)
        val noSecondClaim = games.submitBatch(p.hash, UUID.fromString(extra.sessionId), 1, 7, run)
        assertEquals(25L, noSecondClaim.progress.bestSeries, "an expired predecessor can be inherited only once")
        val more = games.submitBatch(p.hash, renewedId, 2, 10, run)
        assertEquals(35L, more.progress.bestSeries)
        assertEquals(47L, more.progress.lifetimeTaps)
        val restarted = games.submitBatch(p.hash, renewedId, 3, 3, UUID.randomUUID())
        assertEquals(35L, restarted.progress.bestSeries, "a fresh runId begins a separate run")
    }
}
