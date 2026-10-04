package ru.zhiv.db

import com.zaxxer.hikari.HikariDataSource
import io.ktor.client.request.*
import io.ktor.http.*
import io.ktor.server.testing.testApplication
import kotlinx.coroutines.*
import kotlinx.serialization.encodeToString
import org.flywaydb.core.Flyway
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.BeforeAll
import org.junit.jupiter.api.AfterAll
import org.junit.jupiter.api.TestInstance
import org.testcontainers.containers.PostgreSQLContainer
import org.testcontainers.junit.jupiter.Container
import org.testcontainers.junit.jupiter.Testcontainers
import ru.zhiv.auth.AuthFailure
import ru.zhiv.config.AppConfig
import ru.zhiv.economy.*
import ru.zhiv.installZhivApi
import ru.zhiv.security.TokenCodec
import ru.zhiv.world.*
import java.time.Instant
import java.util.UUID
import kotlin.test.*

@Testcontainers(disabledWithoutDocker = true)
@TestInstance(TestInstance.Lifecycle.PER_CLASS)
class JdbcEconomyRepositoryIntegrationTest {
    private class Postgres(image: String) : PostgreSQLContainer<Postgres>(image)
    companion object { @Container private val postgres = Postgres("postgres:18-alpine") }
    private lateinit var source: HikariDataSource
    private lateinit var identities: JdbcZhivRepository
    private lateinit var economy: JdbcEconomyRepository
    private lateinit var config: AppConfig
    private val tokens = TokenCodec()
    private data class Player(val id: UUID, val publicId: String, val hash: ByteArray, val raw: String)

    @BeforeAll fun setup() {
        config = AppConfig(postgres.jdbcUrl, postgres.username, postgres.password, false, setOf("http://localhost"))
        source = DatabaseFactory.create(config)
        DatabaseFactory.migrate(source)
        identities = JdbcZhivRepository(source)
        economy = JdbcEconomyRepository(source)
    }
    @AfterAll fun close() { source.close() }
    private fun execute(sql: String, vararg values: Any?) = source.connection.use { c -> c.economyUpdate(sql, *values).also { c.commit() } }
    private fun scalar(sql: String, vararg values: Any?): String = source.connection.use { c -> c.economyRows(sql, *values) { it.getString(1) }.single() }
    private suspend fun player(): Player {
        val token = tokens.issue()
        val user = identities.bootstrap("Мохлик", tokens.issue().hash, token.hash, 365)
        return Player(user.id, user.publicId, token.hash, token.raw)
    }
    private fun command(p: Player, state: EconomyView, action: String, target: String, quantity: Long = 1) =
        EconomyCommand(UUID.randomUUID().toString(), p.publicId, state.revision, action, target, quantity)
    private fun finish(p: Player, state: EconomyView) {
        val persisted = source.connection.use { readEconomyProfile(it, p.id).state }
        val finishedAt = Instant.parse("2000-01-01T00:00:00Z")
        val ready = persisted.copy(jobs = state.jobs.map { job -> job.copy(finishesAt = finishedAt.toString(),
            collection = job.collection?.let { collection -> if (collection.startedAt == null) collection
                else collection.copy(startedAt = finishedAt.minusSeconds(collection.seconds).toString(), finishesAt = finishedAt.toString()) }) })
        execute("UPDATE economy_profiles SET state=?::jsonb WHERE user_id=?", economyJson.encodeToString(ready), p.id)
    }

    @Test fun `retries return current snapshot while concurrent starts and claims have one effect`() = runBlocking<Unit> {
        val p = player()
        val initial = economy.snapshot(p.hash)
        val start = command(p, initial, "start_production", "grow_berries")
        val started = economy.command(p.hash, start)
        assertEquals(1L, started.acceptedRevision)
        assertEquals(1, started.state.jobs.size)
        assertTrue(economy.command(p.hash, start).replayed)
        assertEquals("ECONOMY_REQUEST_CONFLICT", assertFailsWith<AuthFailure> { economy.command(p.hash, start.copy(targetId = "gather_wood")) }.code)
        finish(p, started.state)
        val collecting = economy.command(p.hash, command(p, started.state, "start_collection", started.state.jobs.single().id)).state
        finish(p, collecting)
        val claim = command(p, collecting, "claim_job", collecting.jobs.single().id)
        val results = coroutineScope { listOf(claim, claim.copy(requestId = UUID.randomUUID().toString())).map {
            async(Dispatchers.IO) { runCatching { JdbcEconomyRepository(source).command(p.hash, it) } }
        }.awaitAll() }
        assertEquals(1, results.count { it.isSuccess })
        assertEquals("ECONOMY_REVISION_CONFLICT", (results.single { it.isFailure }.exceptionOrNull() as AuthFailure).code)
        val current = economy.snapshot(p.hash)
        val berryCount = started.state.jobs.single().rewards.getValue("berries")
        assertEquals(berryCount, current.inventory["berries"])
        val sold = economy.command(p.hash, command(p, current, "sell", "berries", berryCount)).state
        val acknowledged = economy.command(p.hash, start)
        assertTrue(acknowledged.replayed)
        assertEquals(1L, acknowledged.acceptedRevision)
        assertEquals(sold.revision, acknowledged.state.revision)
        assertEquals(berryCount * EconomyRules.catalog.items.single { it.id == "berries" }.baseSellPrice, acknowledged.state.wallet.coins)
        assertEquals("4", scalar("SELECT count(*) FROM economy_ledger WHERE user_id=? AND source_key LIKE 'command:%'", p.id))
    }

    @Test fun `collection retries persist one server timer and concurrent claims deliver the locked harvest once`() = runBlocking<Unit> {
        val p = player()
        val growing = economy.command(p.hash, command(p, economy.snapshot(p.hash), "start_production", "grow_berries")).state
        val job = growing.jobs.single()
        finish(p, growing)
        val start = command(p, growing, "start_collection", job.id)
        val retries = coroutineScope { List(2) { async(Dispatchers.IO) { JdbcEconomyRepository(source).command(p.hash, start) } }.awaitAll() }
        assertEquals(1, retries.count { it.replayed })
        val collecting = economy.snapshot(p.hash)
        assertEquals(growing.revision + 1, collecting.revision)
        assertEquals(growing.inventory, collecting.inventory)
        assertEquals(growing.wallet, collecting.wallet)
        val collection = checkNotNull(collecting.jobs.single().collection)
        assertEquals(8L, java.time.Duration.between(Instant.parse(collection.startedAt), Instant.parse(collection.finishesAt)).seconds)
        assertEquals(collection, JdbcEconomyRepository(source).snapshot(p.hash).jobs.single().collection, "timer survives a fresh repository and JSONB read")
        assertEquals("ECONOMY_COLLECTION_NOT_READY", assertFailsWith<AuthFailure> {
            economy.command(p.hash, command(p, collecting, "claim_job", job.id))
        }.code)
        assertEquals("ECONOMY_REQUEST_CONFLICT", assertFailsWith<AuthFailure> {
            economy.command(p.hash, start.copy(targetId = UUID.randomUUID().toString()))
        }.code)
        assertEquals("1", scalar("SELECT count(*) FROM economy_ledger WHERE user_id=? AND kind='start_collection'", p.id))
        assertEquals("{}", scalar("SELECT items FROM economy_ledger WHERE user_id=? AND kind='start_collection'", p.id))
        finish(p, collecting)
        val claim = command(p, collecting, "claim_job", job.id)
        val claimed = coroutineScope { List(2) { async(Dispatchers.IO) { JdbcEconomyRepository(source).command(p.hash, claim) } }.awaitAll() }
        assertEquals(1, claimed.count { it.replayed })
        val delivered = economy.snapshot(p.hash)
        assertEquals(job.rewards, delivered.inventory)
        assertTrue(delivered.jobs.isEmpty())
        assertEquals(collecting.revision + 1, delivered.revision)
        val replayedStart = economy.command(p.hash, start)
        assertTrue(replayedStart.replayed)
        assertEquals(delivered.inventory, replayedStart.state.inventory)
        assertTrue(replayedStart.state.jobs.isEmpty(), "an old start receipt cannot restart collection after delivery")
        assertEquals("1", scalar("SELECT count(*) FROM economy_ledger WHERE user_id=? AND kind='claim_job'", p.id))
    }

    @Test fun `collection preflight includes escrow and rolls back timer receipt revision and inventory when storage is full`() = runBlocking<Unit> {
        val p = player()
        val growing = economy.command(p.hash, command(p, economy.snapshot(p.hash), "start_production", "grow_berries")).state
        finish(p, growing)
        val persisted = source.connection.use { readEconomyProfile(it, p.id).state }
        execute("UPDATE economy_profiles SET state=?::jsonb WHERE user_id=?", economyJson.encodeToString(persisted.copy(inventory = mapOf("wood" to 190L))), p.id)
        execute("INSERT INTO economy_market_listings(id,seller_id,item_id,quantity,total_price) VALUES (?,?,?,?,?)",
            UUID.randomUUID(), p.id, "stone", 10L, 10L)
        val full = economy.snapshot(p.hash)
        val start = command(p, full, "start_collection", full.jobs.single().id)
        assertEquals("ECONOMY_STORAGE_FULL", assertFailsWith<AuthFailure> { economy.command(p.hash, start) }.code)
        assertEquals(full, economy.snapshot(p.hash).copy(serverTime = full.serverTime))
        assertEquals("0", scalar("SELECT count(*) FROM economy_commands WHERE user_id=? AND request_id=?", p.id, UUID.fromString(start.requestId)))
        assertEquals("0", scalar("SELECT count(*) FROM economy_ledger WHERE user_id=? AND kind='start_collection'", p.id))
        val quantity = full.jobs.single().rewards.values.sum()
        val freed = economy.command(p.hash, command(p, full, "sell", "wood", quantity)).state
        val collecting = economy.command(p.hash, start.copy(expectedRevision = freed.revision)).state
        assertNotNull(collecting.jobs.single().collection?.startedAt)
        assertEquals(freed.inventory, collecting.inventory)
        assertEquals(10L, collecting.storage.reserved)
    }

    @Test fun `failed costs and premature claims roll back and keep revision and escrow inputs`() = runBlocking<Unit> {
        val p = player()
        val initialRaw = economy.snapshot(p.hash)
        val homeUpgrade = EconomyRules.catalog.buildings.single { it.id == "home" }.levels.single { it.level == 2 }
        val stored = source.connection.use { readEconomyProfile(it, p.id).state }
        execute("UPDATE economy_profiles SET state=?::jsonb WHERE user_id=?", economyJson.encodeToString(stored.copy(
            buildings = initialRaw.buildings + homeUpgrade.requiredBuildings + ("home" to homeUpgrade.requiredHomeLevel))), p.id)
        val initial = economy.snapshot(p.hash)
        assertEquals("ECONOMY_RESOURCES", assertFailsWith<AuthFailure> { economy.command(p.hash, command(p, initial, "start_construction", "home")) }.code)
        assertEquals(initial.revision, economy.snapshot(p.hash).revision)
        val started = economy.command(p.hash, command(p, initial, "start_exploration", "forest")).state
        assertEquals("ECONOMY_JOB_NOT_READY", assertFailsWith<AuthFailure> { economy.command(p.hash, command(p, started, "claim_job", started.jobs.single().id)) }.code)
        assertEquals(started.jobs, economy.snapshot(p.hash).jobs)
        assertEquals(started.revision, economy.snapshot(p.hash).revision)
    }

    private suspend fun constructionFixture(pearls: Long = 20, ready: Boolean = false): Pair<Player, EconomyView> {
        val p = player()
        execute("INSERT INTO world_profiles(user_id,state) VALUES (?,?::jsonb)", p.id, worldJson.encodeToString(WorldState()))
        economy.snapshot(p.hash)
        val stored = source.connection.use { readEconomyProfile(it, p.id).state }
        val job = EconomyJob(UUID.randomUUID().toString(), "construction", "home", targetLevel = 2,
            startedAt = Instant.now().minusSeconds(300).toString(),
            finishesAt = if (ready) "2000-01-01T00:00:00Z" else Instant.now().plusSeconds(1190).toString(),
            cost = EconomyCost(150, mapOf("wood" to 20L)), catalogVersion = 2)
        execute("UPDATE economy_profiles SET state=?::jsonb WHERE user_id=?", economyJson.encodeToString(stored.copy(
            wallet = EconomyWallet(71, pearls), inventory = mapOf("berries" to 8L), jobs = listOf(job))), p.id)
        return p to economy.snapshot(p.hash)
    }

    @Test fun `concurrent speedup retries charge once record pearls and synchronise world geometry atomically`() = runBlocking<Unit> {
        val (p, before) = constructionFixture()
        val speedup = command(p, before, "speedup_construction", before.jobs.single().id).copy(totalPrice = 4)
        val retries = coroutineScope { List(2) { async(Dispatchers.IO) { JdbcEconomyRepository(source).command(p.hash, speedup) } }.awaitAll() }
        assertEquals(1, retries.count { it.replayed })
        val after = economy.snapshot(p.hash)
        assertEquals(EconomyWallet(71, 16), after.wallet)
        assertEquals(before.inventory, after.inventory)
        assertEquals(2, after.buildings["home"])
        assertTrue(after.jobs.isEmpty())
        assertEquals(before.revision + 1, after.revision)
        assertEquals("2", scalar("SELECT state->>'houseLevel' FROM world_profiles WHERE user_id=?", p.id))
        assertEquals("-4", scalar("SELECT pearls FROM economy_ledger WHERE user_id=? AND source_key=?", p.id, "command:${speedup.requestId}"))
        assertEquals("1", scalar("SELECT count(*) FROM economy_ledger WHERE user_id=? AND kind='speedup_construction'", p.id))
        assertEquals("ECONOMY_REVISION_CONFLICT", assertFailsWith<AuthFailure> {
            economy.command(p.hash, speedup.copy(requestId = UUID.randomUUID().toString()))
        }.code)
        assertEquals("ECONOMY_REQUEST_CONFLICT", assertFailsWith<AuthFailure> {
            economy.command(p.hash, speedup.copy(totalPrice = 5))
        }.code)
    }

    @Test fun `separate concurrent speedup commands spend one balance and reject the stale revision`() = runBlocking<Unit> {
        val (p, before) = constructionFixture()
        val commands = List(2) { command(p, before, "speedup_construction", before.jobs.single().id).copy(totalPrice = 4) }
        val attempts = coroutineScope { commands.map { request -> async(Dispatchers.IO) {
            runCatching { JdbcEconomyRepository(source).command(p.hash, request) }
        } }.awaitAll() }
        assertEquals(1, attempts.count { it.isSuccess })
        assertEquals("ECONOMY_REVISION_CONFLICT", (attempts.single { it.isFailure }.exceptionOrNull() as AuthFailure).code)
        assertEquals(16L, economy.snapshot(p.hash).wallet.pearls)
        assertEquals("1", scalar("SELECT count(*) FROM economy_ledger WHERE user_id=? AND kind='speedup_construction'", p.id))
    }

    @Test fun `speedup rejection rolls back currency job revision renderer and audit`() = runBlocking<Unit> {
        val (p, before) = constructionFixture(pearls = 3)
        val speedup = command(p, before, "speedup_construction", before.jobs.single().id).copy(totalPrice = 4)
        assertEquals("ECONOMY_PEARLS", assertFailsWith<AuthFailure> { economy.command(p.hash, speedup) }.code)
        assertEquals("ECONOMY_SPEEDUP_PRICE_CHANGED", assertFailsWith<AuthFailure> { economy.command(p.hash, speedup.copy(totalPrice = 3)) }.code)
        val stranger = player()
        assertEquals("ECONOMY_OWNER_CHANGED", assertFailsWith<AuthFailure> { economy.command(stranger.hash, speedup) }.code)
        assertEquals(before, economy.snapshot(p.hash).copy(serverTime = before.serverTime))
        assertEquals("1", scalar("SELECT state->>'houseLevel' FROM world_profiles WHERE user_id=?", p.id))
        assertEquals("0", scalar("SELECT count(*) FROM economy_commands WHERE user_id=?", p.id))
        assertEquals("0", scalar("SELECT count(*) FROM economy_ledger WHERE user_id=? AND kind='speedup_construction'", p.id))
    }

    @Test fun `ready speedup racing a free claim never charges pearls and accepts only one completion`() = runBlocking<Unit> {
        val (p, before) = constructionFixture(pearls = 0, ready = true)
        val commands = listOf(command(p, before, "claim_job", before.jobs.single().id),
            command(p, before, "speedup_construction", before.jobs.single().id).copy(totalPrice = 4))
        val attempts = coroutineScope { commands.map { request -> async(Dispatchers.IO) {
            runCatching { JdbcEconomyRepository(source).command(p.hash, request) }
        } }.awaitAll() }
        assertEquals(1, attempts.count { it.isSuccess })
        assertEquals("ECONOMY_REVISION_CONFLICT", (attempts.single { it.isFailure }.exceptionOrNull() as AuthFailure).code)
        val after = economy.snapshot(p.hash)
        assertEquals(0L, after.wallet.pearls)
        assertEquals(2, after.buildings["home"])
        assertTrue(after.jobs.isEmpty())
        assertEquals("0", scalar("SELECT sum(pearls) FROM economy_ledger WHERE user_id=?", p.id))
    }

    @Test fun `new legacy account lazy conversion matches immutable SQL and never repeats after reopening`() = runBlocking<Unit> {
        val p = player()
        val legacy = WorldState(resources = WorldResources(900, 81, 49), houseLevel = 4, workshop = true, workshopLevel = 2,
            inventory = listOf("moss", "amber_scarf", "explorer_cap"), collection = listOf("acorn"))
        execute("INSERT INTO world_profiles(user_id,state) VALUES (?,?::jsonb)", p.id, worldJson.encodeToString(legacy))
        val result = economy.snapshot(p.hash)
        assertEquals(76L, result.wallet.coins)
        assertEquals(mapOf("wood" to 9L, "stone" to 7L), result.inventory)
        assertEquals(4, result.buildings["home"])
        assertEquals(2, result.buildings["workshop"])
        assertEquals(1, result.buildings["warehouse"])
        assertEquals(0, result.buildings["kiln"])
        assertEquals(EconomyStorage(200, 16, 0, 184, 0), result.storage)
        assertEquals("900", scalar("SELECT legacy_sparks FROM economy_conversion_audit WHERE user_id=?", p.id))
        assertEquals("0", scalar("SELECT state->'resources'->>'sparks' FROM world_profiles WHERE user_id=?", p.id))
        assertEquals(legacy.inventory, JdbcWorldRepository(source).snapshot(p.hash).state.inventory)
        assertEquals(result.wallet, JdbcEconomyRepository(source).snapshot(p.hash).wallet)
        // An administrative gameplay reset cannot make old savings redeemable again.
        execute("DELETE FROM economy_profiles WHERE user_id=?", p.id)
        assertEquals(0L, economy.snapshot(p.hash).wallet.coins)
        assertEquals("1", scalar("SELECT count(*) FROM economy_conversion_audit WHERE user_id=?", p.id))
    }

    @Test fun `claimed construction updates legacy renderer levels in the same transaction`() = runBlocking<Unit> {
        val p = player()
        execute("INSERT INTO world_profiles(user_id,state) VALUES (?,?::jsonb)", p.id, worldJson.encodeToString(WorldState(resources = WorldResources(1_000_000, 100_000, 100_000))))
        economy.snapshot(p.hash)
        val homeUpgrade = EconomyRules.catalog.buildings.single { it.id == "home" }.levels.single { it.level == 2 }
        val stored = source.connection.use { readEconomyProfile(it, p.id).state }
        val supplied = stored.copy(wallet = EconomyWallet(10_000), inventory = homeUpgrade.cost.items,
            buildings = stored.buildings + homeUpgrade.requiredBuildings + ("home" to 1))
        execute("UPDATE economy_profiles SET state=?::jsonb WHERE user_id=?", economyJson.encodeToString(supplied), p.id)
        val initial = economy.snapshot(p.hash)
        val started = economy.command(p.hash, command(p, initial, "start_construction", "home")).state
        assertEquals("1", scalar("SELECT state->>'houseLevel' FROM world_profiles WHERE user_id=?", p.id))
        finish(p, started)
        val completed = economy.command(p.hash, command(p, started, "claim_job", started.jobs.single().id)).state
        assertEquals(2, completed.buildings["home"])
        assertEquals("2", scalar("SELECT state->>'houseLevel' FROM world_profiles WHERE user_id=?", p.id))
        assertEquals(10_000 - homeUpgrade.cost.coins, completed.wallet.coins)
    }

    @Test fun `warehouse rejection rolls back claim while a sale makes the same pending result deliverable`() = runBlocking<Unit> {
        val p = player()
        val initial = economy.snapshot(p.hash)
        val started = economy.command(p.hash, command(p, initial, "start_production", "grow_berries")).state
        finish(p, started)
        val collecting = economy.command(p.hash, command(p, started, "start_collection", started.jobs.single().id)).state
        finish(p, collecting)
        val persisted = source.connection.use { readEconomyProfile(it, p.id).state }
        execute("UPDATE economy_profiles SET state=?::jsonb WHERE user_id=?", economyJson.encodeToString(persisted.copy(inventory = mapOf("wood" to 200L))), p.id)
        val full = economy.snapshot(p.hash)
        val claim = command(p, full, "claim_job", full.jobs.single().id)
        assertEquals("ECONOMY_STORAGE_FULL", assertFailsWith<AuthFailure> { economy.command(p.hash, claim) }.code)
        assertEquals(full, economy.snapshot(p.hash).copy(serverTime = full.serverTime))
        assertEquals("0", scalar("SELECT count(*) FROM economy_commands WHERE user_id=? AND request_id=?", p.id, UUID.fromString(claim.requestId)))
        val quantity = full.jobs.single().rewards.values.sum()
        val sold = economy.command(p.hash, command(p, full, "sell", "wood", quantity)).state
        val claimed = economy.command(p.hash, command(p, sold, "claim_job", claim.targetId)).state
        assertTrue(claimed.jobs.isEmpty())
        assertEquals(EconomyStorage(200, 200, 0, 0, 0), claimed.storage)
    }

    @Test fun `owner fences banned accounts and old journeys cannot be bypassed`() = runBlocking<Unit> {
        val p = player()
        val stranger = player()
        val oldTrip = WorldJourney(UUID.randomUUID().toString(), "first_path", Instant.now().toString(), Instant.now().plusSeconds(600).toString(), WorldResources(), emptyList(), true, 3)
        execute("INSERT INTO world_profiles(user_id,state) VALUES (?,?::jsonb)", p.id, worldJson.encodeToString(WorldState(journeys = listOf(oldTrip))))
        val initial = economy.snapshot(p.hash)
        val start = command(p, initial, "start_exploration", "forest")
        assertEquals("ECONOMY_EXPLORER_BUSY", assertFailsWith<AuthFailure> { economy.command(p.hash, start) }.code)
        assertEquals("ECONOMY_OWNER_CHANGED", assertFailsWith<AuthFailure> { economy.command(stranger.hash, start) }.code)
        val berries = economy.command(p.hash, command(p, initial, "start_production", "grow_berries")).state
        finish(p, berries)
        val collection = command(p, berries, "start_collection", berries.jobs.single().id)
        assertEquals("ECONOMY_EXPLORER_BUSY", assertFailsWith<AuthFailure> { economy.command(p.hash, collection) }.code)
        assertEquals("ECONOMY_OWNER_CHANGED", assertFailsWith<AuthFailure> { economy.command(stranger.hash, collection) }.code)
        assertNull(economy.snapshot(p.hash).jobs.single().collection?.startedAt)
        execute("UPDATE app_users SET banned_at=clock_timestamp(),ban_reason='Economy test account ban' WHERE id=?", p.id)
        assertEquals("UNAUTHORIZED", assertFailsWith<AuthFailure> { economy.snapshot(p.hash) }.code)
    }

    @Test fun `concurrent exploration cancellation retries persist one forfeiture and cannot affect a later trip`() = runBlocking<Unit> {
        for (ready in listOf(false, true)) {
            val p = player()
            economy.snapshot(p.hash)
            val stored = source.connection.use { readEconomyProfile(it, p.id).state }
            val route = EconomyRules.catalog.explorations.single { it.id == "deep_cave" }
            execute("UPDATE economy_profiles SET state=?::jsonb WHERE user_id=?", economyJson.encodeToString(stored.copy(
                wallet = EconomyWallet(73, 2), inventory = route.cost.items + ("fish" to 3L),
                buildings = stored.buildings + ("home" to route.requiredHomeLevel))), p.id)
            val started = economy.command(p.hash, command(p, economy.snapshot(p.hash), "start_exploration", route.id)).state
            assertNotEquals(route.cost.items + ("fish" to 3L), started.inventory)
            if (ready) finish(p, started)
            val before = economy.snapshot(p.hash)
            val trip = before.jobs.single()
            val cancel = command(p, before, "cancel_exploration", trip.id)
            val responses = coroutineScope { List(2) {
                async(Dispatchers.IO) { JdbcEconomyRepository(source).command(p.hash, cancel) }
            }.awaitAll() }
            assertEquals(1, responses.count { it.replayed })
            val cancelled = JdbcEconomyRepository(source).snapshot(p.hash)
            assertTrue(cancelled.jobs.isEmpty(), "removal survives a fresh repository and JSONB read")
            assertEquals(before.inventory, cancelled.inventory)
            assertEquals(before.wallet, cancelled.wallet)
            assertEquals(before.completedExplorations, cancelled.completedExplorations)
            assertEquals(before.revision + 1, cancelled.revision)
            assertEquals("1", scalar("SELECT count(*) FROM economy_ledger WHERE user_id=? AND kind='cancel_exploration'", p.id))
            assertEquals("0", scalar("SELECT coins FROM economy_ledger WHERE user_id=? AND kind='cancel_exploration'", p.id))
            assertEquals("0", scalar("SELECT pearls FROM economy_ledger WHERE user_id=? AND kind='cancel_exploration'", p.id))
            assertEquals("{}", scalar("SELECT items FROM economy_ledger WHERE user_id=? AND kind='cancel_exploration'", p.id))
            assertEquals("ECONOMY_JOB_GONE", assertFailsWith<AuthFailure> {
                economy.command(p.hash, command(p, cancelled, "claim_job", trip.id))
            }.code)
            val next = economy.command(p.hash, command(p, cancelled, "start_exploration", "shore")).state
            val replay = economy.command(p.hash, cancel)
            assertTrue(replay.replayed)
            assertEquals(cancelled.revision, replay.acceptedRevision)
            assertEquals(next.jobs, replay.state.jobs)
            assertEquals(next.revision, replay.state.revision)
            assertEquals("ECONOMY_REQUEST_CONFLICT", assertFailsWith<AuthFailure> {
                economy.command(p.hash, cancel.copy(targetId = next.jobs.single().id))
            }.code)
            assertEquals("ECONOMY_REVISION_CONFLICT", assertFailsWith<AuthFailure> {
                economy.command(p.hash, cancel.copy(requestId = UUID.randomUUID().toString()))
            }.code)
        }
    }

    @Test fun `claim racing cancellation commits exactly one terminal outcome with one receipt and ledger entry`() = runBlocking<Unit> {
        val p = player()
        val started = economy.command(p.hash, command(p, economy.snapshot(p.hash), "start_exploration", "shore")).state
        finish(p, started)
        val before = economy.snapshot(p.hash)
        val trip = before.jobs.single()
        val requests = listOf(command(p, before, "claim_job", trip.id), command(p, before, "cancel_exploration", trip.id))
        val responses = coroutineScope { requests.map { request ->
            async(Dispatchers.IO) { request to runCatching { JdbcEconomyRepository(source).command(p.hash, request) } }
        }.awaitAll() }
        assertEquals(1, responses.count { it.second.isSuccess })
        val winner = responses.single { it.second.isSuccess }.first
        val loser = responses.single { it.second.isFailure }
        assertEquals("ECONOMY_REVISION_CONFLICT", (loser.second.exceptionOrNull() as AuthFailure).code)
        val after = economy.snapshot(p.hash)
        assertTrue(after.jobs.isEmpty())
        assertEquals(before.revision + 1, after.revision)
        assertEquals(before.wallet, after.wallet)
        assertEquals(if (winner.action == "claim_job") trip.rewards else before.inventory, after.inventory)
        assertEquals(if (winner.action == "claim_job") 1L else 0L, after.completedExplorations)
        assertEquals("1", scalar("SELECT count(*) FROM economy_ledger WHERE user_id=? AND kind IN ('claim_job','cancel_exploration')", p.id))
        assertEquals("0", scalar("SELECT count(*) FROM economy_commands WHERE user_id=? AND request_id=?", p.id, UUID.fromString(loser.first.requestId)))
        assertEquals("ECONOMY_JOB_GONE", assertFailsWith<AuthFailure> {
            economy.command(p.hash, loser.first.copy(expectedRevision = after.revision))
        }.code)
        val retry = economy.command(p.hash, winner)
        assertTrue(retry.replayed)
        assertEquals(after.inventory, retry.state.inventory)
        assertEquals(after.revision, retry.state.revision)
    }

    @Test fun `cancellation rejects foreign and production jobs without changing owner state or recording receipts`() = runBlocking<Unit> {
        val p = player()
        val stranger = player()
        val grown = economy.command(p.hash, command(p, economy.snapshot(p.hash), "start_production", "grow_berries")).state
        val before = economy.command(p.hash, command(p, grown, "start_exploration", "shore")).state
        val job = before.jobs.single { it.kind == "exploration" }
        val ownCancel = command(p, before, "cancel_exploration", job.id)
        assertEquals("ECONOMY_OWNER_CHANGED", assertFailsWith<AuthFailure> { economy.command(stranger.hash, ownCancel) }.code)
        assertEquals("ECONOMY_JOB_GONE", assertFailsWith<AuthFailure> {
            economy.command(stranger.hash, command(stranger, economy.snapshot(stranger.hash), "cancel_exploration", job.id))
        }.code)
        assertEquals("ECONOMY_CANCEL_KIND", assertFailsWith<AuthFailure> {
            economy.command(p.hash, command(p, before, "cancel_exploration", grown.jobs.single().id))
        }.code)
        assertEquals(before, economy.snapshot(p.hash).copy(serverTime = before.serverTime))
        assertEquals("0", scalar("SELECT count(*) FROM economy_ledger WHERE user_id=? AND kind='cancel_exploration'", p.id))
        val cancelled = economy.command(p.hash, ownCancel).state
        assertEquals(grown.jobs, cancelled.jobs)
        assertEquals(before.inventory, cancelled.inventory)
    }

    @Test fun `HTTP cancellation forfeits a fishing trip and repeats its acknowledgement without minting rewards`() = testApplication {
        application { installZhivApi(identities, identities, config, tokens, economy = economy) }
        val p = player()
        val started = economy.command(p.hash, command(p, economy.snapshot(p.hash), "start_exploration", "shore")).state
        val cancel = command(p, started, "cancel_exploration", started.jobs.single().id)
        suspend fun post(body: String, origin: String = "http://localhost") = client.post("/api/v1/economy/commands") {
            cookie(config.cookieName, p.raw); header(HttpHeaders.Origin, origin); contentType(ContentType.Application.Json); setBody(body)
        }
        val body = economyJson.encodeToString(cancel)
        assertEquals(HttpStatusCode.Forbidden, post(body, "https://foreign.example").status)
        assertEquals(HttpStatusCode.BadRequest, post(body.dropLast(1) + ",\"refund\":true}").status)
        assertEquals(HttpStatusCode.OK, post(body).status)
        assertEquals(HttpStatusCode.OK, post(body).status)
        val cancelled = economy.snapshot(p.hash)
        assertTrue(cancelled.jobs.isEmpty())
        assertEquals(started.inventory, cancelled.inventory)
        assertEquals(started.wallet, cancelled.wallet)
        assertEquals(started.completedExplorations, cancelled.completedExplorations)
        assertEquals(started.revision + 1, cancelled.revision)
        assertEquals("1", scalar("SELECT count(*) FROM economy_ledger WHERE user_id=? AND kind='cancel_exploration'", p.id))
    }

    @Test fun `HTTP rejects foreign origins forged fields quoted quantities and large requests`() = testApplication {
        application { installZhivApi(identities, identities, config, tokens, economy = economy) }
        val p = player()
        assertEquals(HttpStatusCode.Unauthorized, client.get("/api/v1/economy").status)
        val response = client.get("/api/v1/economy") { cookie(config.cookieName, p.raw) }
        assertEquals(HttpStatusCode.OK, response.status)
        assertEquals("no-store", response.headers[HttpHeaders.CacheControl])
        assertEquals(HttpStatusCode.BadRequest, client.get("/api/v1/economy?ownerPublicId=${p.publicId}") { cookie(config.cookieName, p.raw) }.status)
        val initial = economy.snapshot(p.hash)
        val command = command(p, initial, "start_production", "grow_berries")
        suspend fun post(body: String, origin: String = "http://localhost") = client.post("/api/v1/economy/commands") {
            cookie(config.cookieName, p.raw); header(HttpHeaders.Origin, origin); contentType(ContentType.Application.Json); setBody(body)
        }
        val body = economyJson.encodeToString(command)
        assertEquals(HttpStatusCode.Forbidden, post(body, "https://foreign.example").status)
        assertEquals(HttpStatusCode.BadRequest, post(body.dropLast(1) + ",\"wallet\":{\"coins\":10000}}").status)
        assertEquals(HttpStatusCode.BadRequest, post(body.replace("\"quantity\":1", "\"quantity\":\"1\"")).status)
        assertEquals(HttpStatusCode.PayloadTooLarge, post(" ".repeat(4097) + body).status)
        assertEquals(HttpStatusCode.OK, post(body).status)
    }

    @Test fun `V35 adds zero pearl deltas to historical ledger without changing populated profiles or receipts`() = runBlocking<Unit> {
        val database = "pearl_upgrade_${UUID.randomUUID().toString().replace("-", "")}"
        source.connection.use { c -> c.autoCommit = true; c.economyUpdate("CREATE DATABASE $database") }
        try {
            val isolatedConfig = config.copy(databaseUrl = "jdbc:postgresql://${postgres.host}:${postgres.getMappedPort(5432)}/$database")
            DatabaseFactory.create(isolatedConfig).use { isolated ->
                Flyway.configure().dataSource(isolated).locations("classpath:db/migration").target("34").load().migrate()
                val token = tokens.issue()
                val user = JdbcZhivRepository(isolated).bootstrap("Старый строитель", tokens.issue().hash, token.hash, 365)
                val repo = JdbcEconomyRepository(isolated)
                repo.snapshot(token.hash)
                val job = EconomyJob(UUID.randomUUID().toString(), "construction", "home", targetLevel = 2,
                    startedAt = Instant.now().toString(), finishesAt = Instant.now().plusSeconds(1190).toString())
                val requestId = UUID.randomUUID()
                isolated.connection.use { c ->
                    val stored = readEconomyProfile(c, user.id).state
                    c.economyUpdate("UPDATE economy_profiles SET state=?::jsonb WHERE user_id=?", economyJson.encodeToString(stored.copy(
                        wallet = EconomyWallet(123, 20), jobs = listOf(job))), user.id)
                    c.economyUpdate("INSERT INTO economy_ledger(user_id,source_key,kind,coins) VALUES (?,'historic','sell',123)", user.id)
                    c.economyUpdate("INSERT INTO economy_commands(user_id,request_id,signature,message,accepted_revision) VALUES (?,?,'preserved','Готово',0)", user.id, requestId)
                    c.commit()
                }
                val before = repo.snapshot(token.hash)
                DatabaseFactory.migrate(isolated)
                DatabaseFactory.migrate(isolated)
                assertEquals(before, repo.snapshot(token.hash).copy(serverTime = before.serverTime))
                isolated.connection.use { c ->
                    assertEquals(123L to 0L, c.economyRows("SELECT coins,pearls FROM economy_ledger WHERE user_id=? AND source_key='historic'", user.id) {
                        it.getLong(1) to it.getLong(2)
                    }.single())
                    assertEquals("preserved", c.economyRows("SELECT signature FROM economy_commands WHERE user_id=? AND request_id=?", user.id, requestId) { it.getString(1) }.single())
                }
                val speedup = EconomyCommand(UUID.randomUUID().toString(), user.publicId, before.revision, "speedup_construction", job.id, totalPrice = 4)
                assertEquals(16L, repo.command(token.hash, speedup).state.wallet.pearls)
            }
        } finally {
            source.connection.use { c -> c.autoCommit = true; c.economyUpdate("DROP DATABASE $database WITH (FORCE)") }
        }
    }

    @Test fun `populated V31 database migrates once preserving possessions and auditable capped conversion`() = runBlocking<Unit> {
        val database = "economy_upgrade_${UUID.randomUUID().toString().replace("-", "")}"
        source.connection.use { c -> c.autoCommit = true; c.economyUpdate("CREATE DATABASE $database") }
        try {
            val isolatedConfig = config.copy(databaseUrl = "jdbc:postgresql://${postgres.host}:${postgres.getMappedPort(5432)}/$database")
            DatabaseFactory.create(isolatedConfig).use { isolated ->
                Flyway.configure().dataSource(isolated).locations("classpath:db/migration").target("31").load().migrate()
                val token = tokens.issue()
                val user = JdbcZhivRepository(isolated).bootstrap("Старый житель", tokens.issue().hash, token.hash, 365)
                val legacy = WorldState(resources = WorldResources(ECONOMY_MAX_REVISION, ECONOMY_MAX_REVISION, ECONOMY_MAX_REVISION), houseLevel = 5, workshop = true, workshopLevel = 3,
                    inventory = listOf("moss", "amber_scarf", "explorer_cap"), collection = listOf("acorn"))
                isolated.connection.use { c -> c.economyUpdate("INSERT INTO world_profiles(user_id,state) VALUES (?,?::jsonb)", user.id, worldJson.encodeToString(legacy)); c.commit() }
                DatabaseFactory.migrate(isolated)
                val converted = JdbcEconomyRepository(isolated).snapshot(token.hash)
                assertEquals(500L, converted.wallet.coins)
                assertEquals(0L, converted.wallet.pearls)
                assertEquals(mapOf("wood" to 30L, "stone" to 30L), converted.inventory)
                assertEquals(5, converted.buildings["home"])
                assertEquals(3, converted.buildings["workshop"])
                val restored = JdbcWorldRepository(isolated).snapshot(token.hash).state
                assertEquals(legacy.copy(resources = WorldResources()), restored)
                DatabaseFactory.migrate(isolated)
                assertEquals(converted.wallet, JdbcEconomyRepository(isolated).snapshot(token.hash).wallet)
                val audit = isolated.connection.use { c -> c.economyRows("SELECT legacy_sparks,coins_granted FROM economy_conversion_audit WHERE user_id=?", user.id) { it.getLong(1) to it.getLong(2) }.single() }
                assertEquals(ECONOMY_MAX_REVISION to 500L, audit)
            }
        } finally {
            source.connection.use { c -> c.autoCommit = true; c.economyUpdate("DROP DATABASE $database WITH (FORCE)") }
        }
    }
}
