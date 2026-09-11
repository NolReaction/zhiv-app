package ru.zhiv.db

import com.zaxxer.hikari.HikariDataSource
import io.ktor.client.request.*
import io.ktor.client.statement.bodyAsText
import io.ktor.http.*
import io.ktor.server.testing.testApplication
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.*
import org.junit.jupiter.api.AfterAll
import org.junit.jupiter.api.BeforeAll
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.TestInstance
import org.testcontainers.containers.PostgreSQLContainer
import org.testcontainers.junit.jupiter.Container
import org.testcontainers.junit.jupiter.Testcontainers
import ru.zhiv.admin.AdminConfig
import ru.zhiv.admin.AdminPlayerCommand
import ru.zhiv.auth.AuthFailure
import ru.zhiv.config.AppConfig
import ru.zhiv.installZhivApi
import ru.zhiv.security.TokenCodec
import ru.zhiv.world.WorldRules
import java.time.OffsetDateTime
import java.time.temporal.ChronoUnit
import java.util.UUID
import kotlin.test.*

@Testcontainers(disabledWithoutDocker = true)
@TestInstance(TestInstance.Lifecycle.PER_CLASS)
class JdbcTapHistoryIntegrationTest {
    private class Postgres(image: String) : PostgreSQLContainer<Postgres>(image)
    companion object { @Container private val postgres = Postgres("postgres:18-alpine") }
    private lateinit var source: HikariDataSource
    private lateinit var identities: JdbcZhivRepository
    private lateinit var config: AppConfig
    private val tokens = TokenCodec()
    private data class User(val id: UUID, val publicId: String, val hash: ByteArray, val raw: String)
    @BeforeAll fun setup() {
        config = AppConfig(postgres.jdbcUrl, postgres.username, postgres.password, false, setOf("http://localhost"))
        source = DatabaseFactory.create(config)
        DatabaseFactory.migrate(source)
        identities = JdbcZhivRepository(source)
    }
    @AfterAll fun close() { source.close() }
    @BeforeEach fun clear() { execute("TRUNCATE app_users CASCADE") }
    private fun execute(sql: String, vararg values: Any?): Int = source.connection.use { c ->
        c.prepareStatement(sql).use { s ->
            values.forEachIndexed { i, value -> s.setObject(i + 1, value) }; s.executeUpdate()
        }.also { c.commit() }
    }
    private fun scalar(sql: String, vararg values: Any?): String? = source.connection.use { c ->
        c.prepareStatement(sql).use { s ->
            values.forEachIndexed { i, value -> s.setObject(i + 1, value) }
            s.executeQuery().use { r -> if (r.next()) r.getString(1) else null }
        }
    }
    private suspend fun user(): User {
        val token = tokens.issue()
        val snapshot = identities.bootstrap("History tester", tokens.issue().hash, token.hash, 365)
        return User(snapshot.id, snapshot.publicId, token.hash, token.raw)
    }
    private fun repository(admin: User) = JdbcAdminRepository(source, AdminConfig(setOf(admin.publicId)))

    @Test fun `month history counts accepted batches once and isolates target and authorization`() = runBlocking<Unit> {
        val admin = user(); val target = user(); val other = user()
        val repo = repository(admin); val games = JdbcGameRepository(source)
        val session = UUID.fromString(games.openSession(target.hash, UUID.randomUUID(), target.publicId).sessionId)
        val run = UUID.randomUUID()
        assertEquals(3, games.submitBatch(target.hash, session, 1, 3, run, null).acceptedTaps)
        assertTrue(games.submitBatch(target.hash, session, 1, 3, run, null).replayed)
        val history = repo.tapHistory(admin.hash, target.publicId)
        assertEquals(target.publicId, history.publicId)
        assertEquals(3L, history.minutes.sumOf { it.receivedTaps })
        assertEquals(3L, history.minutes.sumOf { it.legacyTaps })
        assertEquals(0L, history.minutes.sumOf { it.eventTaps })
        assertTrue(history.minutes.size <= 43201)
        assertTrue(repo.tapHistory(admin.hash, other.publicId).minutes.isEmpty())
        assertEquals(403, assertFailsWith<AuthFailure> { repo.tapHistory(other.hash, target.publicId) }.status)
        assertEquals(401, assertFailsWith<AuthFailure> { repo.tapHistory(tokens.issue().hash, target.publicId) }.status)
        execute("UPDATE app_sessions SET revoked_at=clock_timestamp() WHERE token_hash=?", admin.hash)
        assertEquals(401, assertFailsWith<AuthFailure> { repo.tapHistory(admin.hash, target.publicId) }.status)
    }

    @Test fun `late delivery preserves old event minutes separately from receipt and captures watch status`() = runBlocking<Unit> {
        val admin = user(); val target = user(); val repo = repository(admin)
        execute("UPDATE app_users SET tap_watchlisted=true WHERE id=?", target.id)
        val now = source.connection.use { c -> c.createStatement().use { statement ->
            statement.executeQuery("SELECT clock_timestamp()").use { row -> row.next(); row.getObject(1, OffsetDateTime::class.java) }
        } }
        val first = now.truncatedTo(ChronoUnit.MINUTES).minusHours(3).plusSeconds(10).toInstant().toEpochMilli()
        source.connection.use { c ->
            c.prepareStatement("SELECT id FROM app_users WHERE id=? FOR NO KEY UPDATE").use { s ->
                s.setObject(1, target.id); s.executeQuery().use { assertTrue(it.next()) }
            }
            recordTapActivity(c, target.id, now, accepted=2, rejected=1, times=listOf(first, first+500), previous=first-500)
            c.commit()
        }
        val history = repo.tapHistory(admin.hash, target.publicId)
        val events = history.minutes.single { it.eventTaps > 0 }
        val receipt = history.minutes.single { it.receivedTaps > 0 }
        assertEquals(2L, events.eventTaps)
        assertEquals(2L, events.intervalCount)
        assertEquals(1000.0, events.intervalSumMs)
        assertEquals(500000.0, events.intervalSquaredSumMs)
        assertEquals(0L, events.receivedTaps)
        assertTrue(events.complete)
        assertEquals(2L, receipt.receivedTaps)
        assertEquals(2L, receipt.delayedTaps)
        assertEquals(1L, receipt.rejectedTaps)
        assertEquals(0L, receipt.eventTaps)
        assertTrue(receipt.watchlisted)
        assertFalse(receipt.reviewSignal)
        assertEquals("0", scalar("SELECT sum(event_taps) FROM game_tap_activity_seconds WHERE user_id=?", target.id))
        assertEquals("2", scalar("SELECT sum(received_taps) FROM game_tap_activity_seconds WHERE user_id=?", target.id))
        execute("UPDATE app_users SET tap_watchlisted=false WHERE id=?", target.id)
        assertTrue(repo.tapHistory(admin.hash, target.publicId).minutes.single { it.receivedTaps > 0 }.watchlisted)
        assertNull(repo.player(admin.hash, target.publicId).bannedAt)
    }

    @Test fun `retention removes old seconds and month history independently without requiring new taps`() = runBlocking<Unit> {
        val admin = user(); val target = user(); val repo = repository(admin)
        execute("INSERT INTO game_tap_activity_seconds(user_id,bucket_at,received_taps) VALUES (?,clock_timestamp()-interval '3 hours',7)", target.id)
        execute("""INSERT INTO game_tap_activity_minutes(user_id,bucket_at,received_taps) VALUES
            (?,date_trunc('minute',clock_timestamp())-interval '31 days',11),
            (?,date_trunc('minute',clock_timestamp())-interval '29 days',13),
            (?,date_trunc('minute',clock_timestamp()),17)""", target.id, target.id, target.id)
        assertEquals(30L, repo.tapHistory(admin.hash, target.publicId).minutes.sumOf { it.receivedTaps })
        assertEquals(1, purgeTapActivity(source))
        assertEquals("0", scalar("SELECT count(*) FROM game_tap_activity_seconds WHERE user_id=?", target.id))
        assertEquals("2", scalar("SELECT count(*) FROM game_tap_activity_minutes WHERE user_id=?", target.id))
        assertEquals(30L, repo.tapHistory(admin.hash, target.publicId).minutes.sumOf { it.receivedTaps })
        assertEquals(0, purgeTapActivity(source))
    }

    @Test fun `month history HTTP remains private and cannot be cached`() = testApplication {
        val admin = user(); val target = user(); val visitor = user()
        application { installZhivApi(identities, identities, config, admin=repository(admin)) }
        val path = "/api/v1/admin/users/${target.publicId}/tap-history"
        assertEquals(HttpStatusCode.Unauthorized, client.get(path).status)
        assertEquals(HttpStatusCode.Forbidden, client.get(path) { cookie(config.cookieName, visitor.raw) }.status)
        val response = client.get(path) { cookie(config.cookieName, admin.raw) }
        assertEquals(HttpStatusCode.OK, response.status)
        assertEquals("no-store", response.headers[HttpHeaders.CacheControl])
        val body = Json.parseToJsonElement(response.bodyAsText()).jsonObject
        assertEquals(target.publicId, body.getValue("publicId").jsonPrimitive.content)
        assertTrue(body.getValue("minutes").jsonArray.isEmpty())
    }

    @Test fun `granting all catalog finds awards each collection item and medal exactly once`() = runBlocking<Unit> {
        val admin = user(); val target = user(); val repo = repository(admin)
        val finds = WorldRules.catalog.finds
        for ((index, find) in finds.withIndex()) {
            val id = UUID.randomUUID()
            val request = AdminPlayerCommand(id.toString(), target.publicId, "Verify collection reward", "grant_find", find.id)
            val receipt = repo.managePlayer(admin.hash, target.publicId, id, request)
            assertTrue(receipt.changed)
            assertEquals(receipt, repo.managePlayer(admin.hash, target.publicId, id, request))
            val count = scalar("SELECT count(*) FROM game_achievements WHERE user_id=? AND achievement_id='full_collection'", target.id)
            assertEquals(if (index == finds.lastIndex) "1" else "0", count)
        }
        val world = repo.player(admin.hash, target.publicId).world
        assertEquals(finds.map { it.id }.toSet(), world.collection.toSet())
        assertEquals(1, world.inventory.count { it == "explorer_cap" })
        assertEquals(1, world.inventory.count { it == "willow_rod" })
        val medal = JdbcGameRepository(source).achievements(target.hash).achievements.single { it.id == "full_collection" }
        assertEquals(12L, medal.progress)
        assertNotNull(medal.unlockedAt)
        assertEquals(medal, JdbcGameRepository(source).achievements(target.hash).achievements.single { it.id == "full_collection" })
    }
}
