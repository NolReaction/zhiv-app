package ru.zhiv.db

import com.zaxxer.hikari.HikariDataSource
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.encodeToString
import org.junit.jupiter.api.AfterAll
import org.junit.jupiter.api.BeforeAll
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.TestInstance
import org.testcontainers.containers.PostgreSQLContainer
import org.testcontainers.junit.jupiter.Container
import org.testcontainers.junit.jupiter.Testcontainers
import ru.zhiv.config.AppConfig
import ru.zhiv.economy.*
import ru.zhiv.security.TokenCodec
import java.time.Instant
import java.util.UUID
import kotlin.test.*

/** The new book rule is committed with delivery, and cannot be farmed with receipt retries. */
@Testcontainers(disabledWithoutDocker = true)
@TestInstance(TestInstance.Lifecycle.PER_CLASS)
class JdbcCollectionV12IntegrationTest {
    private class Postgres(image: String) : PostgreSQLContainer<Postgres>(image)
    companion object { @Container private val postgres = Postgres("postgres:18-alpine") }
    private lateinit var source: HikariDataSource
    private lateinit var economy: JdbcEconomyRepository
    private val tokens = TokenCodec()
    @BeforeAll fun setup() {
        source = DatabaseFactory.create(AppConfig(postgres.jdbcUrl, postgres.username, postgres.password, false, setOf("http://localhost")))
        DatabaseFactory.migrate(source)
        economy = JdbcEconomyRepository(source)
    }
    @AfterAll fun close() { source.close() }

    @Test fun `v12 long claim yields one page and exact retry none while two short claims sum to one additional page`() = runBlocking<Unit> {
        val session = tokens.issue()
        val user = JdbcZhivRepository(source).bootstrap("Книголюб", tokens.issue().hash, session.hash, 365)
        economy.snapshot(session.hash)
        suspend fun deliver(seconds: Long): Pair<EconomyCommand, EconomyResult> {
            val finished = Instant.parse("2020-01-01T00:00:00Z")
            val id = UUID.randomUUID().toString()
            val job = EconomyJob(id, "exploration", "forest", startedAt = finished.minusSeconds(seconds).toString(),
                finishesAt = finished.toString(), rewards = mapOf("wood" to 1L), catalogVersion = 12, actorId = "mochlik")
            source.connection.use { c ->
                val initial = readEconomyProfile(c, user.id).state
                c.economyUpdate("UPDATE economy_profiles SET state=?::jsonb WHERE user_id=?", economyJson.encodeToString(initial.copy(jobs = listOf(job))), user.id)
                c.commit()
            }
            val before = economy.snapshot(session.hash)
            val request = EconomyCommand(UUID.randomUUID().toString(), user.publicId, before.revision, "claim_job", id, 1, 0)
            return request to economy.command(session.hash, request)
        }
        val (longRequest, long) = deliver(8 * 3600)
        assertEquals(1, long.state.progression.collections.finds.size)
        assertEquals(7200L, long.state.progression.collections.travelSeconds)
        val replay = economy.command(session.hash, longRequest)
        assertTrue(replay.replayed)
        assertEquals(long.acceptedRevision, replay.acceptedRevision)
        assertEquals(long.state.progression, replay.state.progression)
        assertEquals(long.state.inventory, replay.state.inventory)
        val (_, short) = deliver(3600)
        assertEquals(1, short.state.progression.collections.finds.size)
        assertEquals(10800L, short.state.progression.collections.travelSeconds)
        val (_, next) = deliver(3600)
        assertEquals(2, next.state.progression.collections.finds.size)
        assertEquals(14400L, next.state.progression.collections.travelSeconds)
        assertEquals((long.state.inventory["wood"] ?: 0) + 2, next.state.inventory["wood"])
        val oldReplay = economy.command(session.hash, longRequest)
        assertTrue(oldReplay.replayed)
        assertEquals(next.state.progression, oldReplay.state.progression)
        assertEquals(next.state.inventory, oldReplay.state.inventory)
        assertEquals("1", source.connection.use { c -> c.economyRows("SELECT count(*) FROM economy_commands WHERE user_id=? AND request_id=?", user.id, UUID.fromString(longRequest.requestId)) { it.getString(1) }.single() })
    }
}
