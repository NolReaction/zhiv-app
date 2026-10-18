package ru.zhiv.db

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.runBlocking
import org.junit.jupiter.api.Test
import org.testcontainers.containers.PostgreSQLContainer
import org.testcontainers.junit.jupiter.Container
import org.testcontainers.junit.jupiter.Testcontainers
import ru.zhiv.auth.AuthFailure
import ru.zhiv.config.AppConfig
import ru.zhiv.economy.EconomyCommand
import ru.zhiv.economy.EconomyJob
import ru.zhiv.security.TokenCodec
import java.time.Duration
import java.time.Instant
import java.util.UUID
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertIs
import kotlin.test.assertTrue

/** Exercises account locking and durable tutorial aid rather than local lesson state. */
@Testcontainers(disabledWithoutDocker = true)
class JdbcFirstHarvestIntegrationTest {
    private class Postgres : PostgreSQLContainer<Postgres>("postgres:18-alpine")
    @Container private val postgres = Postgres()
    private fun duration(job: EconomyJob): Duration = Duration.between(Instant.parse(job.startedAt), Instant.parse(job.finishesAt))

    @Test fun `identical simultaneous first harvest starts share one job receipt and durable aid marker`() = runBlocking<Unit> {
        val config = AppConfig(postgres.jdbcUrl, postgres.username, postgres.password, false, setOf("http://localhost"))
        DatabaseFactory.create(config).use { source ->
            DatabaseFactory.migrate(source)
            val tokens = TokenCodec(); val token = tokens.issue()
            val player = JdbcZhivRepository(source).bootstrap("Первый урожай", tokens.issue().hash, token.hash, 365)
            val repository = JdbcEconomyRepository(source)
            val before = repository.snapshot(token.hash)
            assertFalse(before.tutorialOrder.firstHarvestPrepared)
            val request = EconomyCommand(UUID.randomUUID().toString(), player.publicId, before.revision, "start_production", "grow_berries")
            val results = coroutineScope {
                List(2) { async(Dispatchers.IO) { JdbcEconomyRepository(source).command(token.hash, request) } }.awaitAll()
            }
            assertEquals(1, results.count { it.replayed })
            assertEquals(setOf(before.revision + 1), results.map { it.acceptedRevision }.toSet())
            val after = repository.snapshot(token.hash)
            assertEquals(before.revision + 1, after.revision)
            assertTrue(after.tutorialOrder.firstHarvestPrepared)
            assertEquals(request.requestId, after.jobs.single().id)
            assertEquals(Duration.ofMillis(1), duration(after.jobs.single()))
            assertEquals(before.wallet, after.wallet); assertEquals(before.inventory, after.inventory)
            source.connection.use { connection ->
                assertTrue(readEconomyProfile(connection, player.id).state.tutorialOrder.firstHarvestPrepared)
                assertEquals(1L, connection.economyRows(
                    "SELECT count(*) FROM economy_ledger WHERE user_id=? AND kind='start_production'", player.id,
                ) { it.getLong(1) }.single())
            }
            val replay = repository.command(token.hash, request)
            assertTrue(replay.replayed)
            assertEquals(before.revision + 1, replay.acceptedRevision)
            assertEquals(after.jobs, replay.state.jobs)
        }
    }

    @Test fun `different simultaneous request IDs prepare only one harvest and removing its job cannot renew aid`() = runBlocking<Unit> {
        val config = AppConfig(postgres.jdbcUrl, postgres.username, postgres.password, false, setOf("http://localhost"))
        DatabaseFactory.create(config).use { source ->
            DatabaseFactory.migrate(source)
            val tokens = TokenCodec(); val token = tokens.issue()
            val player = JdbcZhivRepository(source).bootstrap("Повтор урока", tokens.issue().hash, token.hash, 365)
            val repository = JdbcEconomyRepository(source)
            val before = repository.snapshot(token.hash)
            val requests = List(2) { EconomyCommand(UUID.randomUUID().toString(), player.publicId, before.revision,
                "start_production", "grow_berries") }
            val results = coroutineScope {
                requests.map { request -> async(Dispatchers.IO) {
                    runCatching { JdbcEconomyRepository(source).command(token.hash, request) }
                } }.awaitAll()
            }
            assertEquals(1, results.count { it.isSuccess })
            assertEquals("ECONOMY_REVISION_CONFLICT", assertIs<AuthFailure>(results.single { it.isFailure }.exceptionOrNull()).code)
            val prepared = repository.snapshot(token.hash)
            assertEquals(before.revision + 1, prepared.revision)
            assertEquals(Duration.ofMillis(1), duration(prepared.jobs.single()))
            assertTrue(prepared.tutorialOrder.firstHarvestPrepared)
            source.connection.use { connection ->
                val stored = readEconomyProfile(connection, player.id).state
                // Model a recovered/removed job while leaving authoritative history intact.
                saveEconomyProfile(connection, player.id, stored.copy(jobs = emptyList()))
                connection.commit()
            }
            val recovered = repository.snapshot(token.hash)
            assertTrue(recovered.tutorialOrder.firstHarvestPrepared)
            val next = repository.command(token.hash, requests.first().copy(requestId = UUID.randomUUID().toString(),
                expectedRevision = recovered.revision)).state
            assertEquals(Duration.ofSeconds(60), duration(next.jobs.single()))
            assertTrue(next.tutorialOrder.firstHarvestPrepared)
            assertEquals(before.wallet, next.wallet); assertEquals(before.inventory, next.inventory)
        }
    }
}
