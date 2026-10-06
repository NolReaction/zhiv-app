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
        val selected = state.jobs.map { it.id }.toSet()
        val ready = persisted.copy(jobs = persisted.jobs.map { job -> if (job.id !in selected) job else job.copy(finishesAt = finishedAt.toString(),
            collection = job.collection?.let { collection -> if (collection.startedAt == null) collection
                else collection.copy(startedAt = finishedAt.minusSeconds(collection.seconds).toString(), finishesAt = finishedAt.toString()) }) })
        execute("UPDATE economy_profiles SET state=?::jsonb WHERE user_id=?", economyJson.encodeToString(ready), p.id)
    }

    @Test fun `production slot purchases persist and lock one debit across replay and revision races`() = runBlocking<Unit> {
        val p = player(); val stranger = player(); economy.snapshot(p.hash)
        val original = source.connection.use { readEconomyProfile(it, p.id).state }
        execute("UPDATE economy_profiles SET state=?::jsonb WHERE user_id=?", economyJson.encodeToString(original.copy(
            wallet = EconomyWallet(0, 20_000), buildings = original.buildings + mapOf("home" to 4, "workshop" to 1))), p.id)
        val buy = command(p, economy.snapshot(p.hash), "buy_production_slot", "workshop")
        val replies = coroutineScope { List(2) { async(Dispatchers.IO) { JdbcEconomyRepository(source).command(p.hash, buy) } }.awaitAll() }
        assertEquals(1, replies.count { it.replayed })
        assertEquals(mapOf("workshop" to 2), economy.snapshot(p.hash).productionSlots)
        assertEquals(18_500L, economy.snapshot(p.hash).wallet.pearls)
        assertEquals("-1500", scalar("SELECT pearls FROM economy_ledger WHERE user_id=? AND kind='buy_production_slot'", p.id))
        assertEquals("ECONOMY_OWNER_CHANGED", assertFailsWith<AuthFailure> { economy.command(stranger.hash, buy) }.code)
        assertEquals("ECONOMY_REQUEST_CONFLICT", assertFailsWith<AuthFailure> { economy.command(p.hash, buy.copy(targetId = "garden")) }.code)
        val next = command(p, economy.snapshot(p.hash), "buy_production_slot", "workshop")
        val raced = coroutineScope { List(2) { async(Dispatchers.IO) {
            runCatching { economy.command(p.hash, next.copy(requestId = UUID.randomUUID().toString())) }
        } }.awaitAll() }
        assertEquals(1, raced.count { it.isSuccess })
        assertEquals(3, economy.snapshot(p.hash).productionSlots["workshop"])
        assertEquals(13_500L, economy.snapshot(p.hash).wallet.pearls)
        assertEquals(3, source.connection.use { readEconomyProfile(it, p.id).state.productionSlots["workshop"] })
    }

    @Test fun `merging accounts preserves maximum purchased station slots without refunding duplicates`() = runBlocking<Unit> {
        val a = player(); val b = player()
        for ((p, slots) in listOf(a to mapOf("workshop" to 2, "garden" to 3), b to mapOf("workshop" to 3, "kiln" to 2))) {
            economy.snapshot(p.hash)
            val state = source.connection.use { readEconomyProfile(it, p.id).state }
            execute("UPDATE economy_profiles SET state=?::jsonb WHERE user_id=?", economyJson.encodeToString(state.copy(
                wallet = EconomyWallet(0, 100), productionSlots = slots)), p.id)
        }
        source.connection.use { c ->
            c.autoCommit = false
            listOf(a.id, b.id).sorted().forEach { id -> c.economyRows("SELECT id FROM app_users WHERE id=? FOR NO KEY UPDATE", id) { true } }
            mergeEconomyProfiles(c, a.id, b.id); c.commit()
        }
        val merged = economy.snapshot(a.hash)
        assertEquals(mapOf("workshop" to 3, "garden" to 3, "kiln" to 2), merged.productionSlots)
        assertEquals(200L, merged.wallet.pearls)
    }

    @Test fun `clothing purchase receipts lock both balances and legacy equipment ownership across racing requests`() = runBlocking<Unit> {
        val p = player(); val stranger = player(); val world = JdbcWorldRepository(source)
        economy.snapshot(p.hash)
        val original = source.connection.use { readEconomyProfile(it, p.id).state }
        execute("UPDATE economy_profiles SET state=?::jsonb WHERE user_id=?", economyJson.encodeToString(original.copy(wallet=EconomyWallet(20_000, 2_000))), p.id)
        val beforeWorld = world.snapshot(p.hash)
        val buy = command(p, economy.snapshot(p.hash), "buy_wardrobe_item", "pearls:heather").copy(totalPrice=150)
        val replies = coroutineScope { List(2) { async(Dispatchers.IO) { JdbcEconomyRepository(source).command(p.hash, buy) } }.awaitAll() }
        assertEquals(1, replies.count { it.replayed })
        assertEquals(1850L, economy.snapshot(p.hash).wallet.pearls)
        assertEquals("1", scalar("SELECT count(*) FROM economy_ledger WHERE user_id=? AND kind='buy_wardrobe_item'", p.id))
        assertEquals("-150", scalar("SELECT pearls FROM economy_ledger WHERE user_id=? AND kind='buy_wardrobe_item'", p.id))
        assertEquals("ECONOMY_REQUEST_CONFLICT", assertFailsWith<AuthFailure> { economy.command(p.hash, buy.copy(totalPrice=0)) }.code)
        assertEquals("ECONOMY_OWNER_CHANGED", assertFailsWith<AuthFailure> { economy.command(stranger.hash, buy) }.code)
        val afterWorld = world.snapshot(p.hash)
        assertTrue("heather" in afterWorld.state.inventory)
        assertTrue(afterWorld.revision > beforeWorld.revision)
        val equip = WorldCommand(UUID.randomUUID().toString(), p.publicId, afterWorld.revision, "equip", "heather")
        assertEquals("heather", world.command(p.hash, equip).snapshot.state.equipment.palette)
        val second = command(p, economy.snapshot(p.hash), "buy_wardrobe_item", "coins:fern").copy(totalPrice=1200)
        val raced = coroutineScope { List(2) { async(Dispatchers.IO) { runCatching { economy.command(p.hash, second.copy(requestId=UUID.randomUUID().toString())) } } }.awaitAll() }
        assertEquals(1, raced.count { it.isSuccess })
        assertEquals(18_800L, economy.snapshot(p.hash).wallet.coins)
        val again = command(p, economy.snapshot(p.hash), "buy_wardrobe_item", "coins:fern").copy(totalPrice=1200)
        assertEquals("ECONOMY_WARDROBE_OWNED", assertFailsWith<AuthFailure> { economy.command(p.hash, again) }.code)
        assertEquals(1850L, economy.snapshot(p.hash).wallet.pearls)
    }

    @Test fun `legacy clothes remain owned and account merging does not refund duplicate cosmetics`() = runBlocking<Unit> {
        val a = player(); val b = player(); val world = JdbcWorldRepository(source)
        for (p in listOf(a,b)) {
            economy.snapshot(p.hash)
            val before = source.connection.use { readEconomyProfile(it, p.id).state }
            execute("UPDATE economy_profiles SET state=?::jsonb WHERE user_id=?", economyJson.encodeToString(before.copy(wallet=EconomyWallet(5000, 500))), p.id)
            economy.command(p.hash, command(p, economy.snapshot(p.hash), "buy_wardrobe_item", "pearls:heather").copy(totalPrice=150))
        }
        val old = world.snapshot(a.hash)
        execute("UPDATE world_profiles SET state=?::jsonb WHERE user_id=?", worldJson.encodeToString(old.state.copy(inventory=old.state.inventory+"fern")), a.id)
        assertTrue("fern" in economy.snapshot(a.hash).wardrobe)
        assertEquals("ECONOMY_WARDROBE_OWNED", assertFailsWith<AuthFailure> {
            economy.command(a.hash, command(a, economy.snapshot(a.hash), "buy_wardrobe_item", "coins:fern").copy(totalPrice=1200))
        }.code)
        source.connection.use { c ->
            c.autoCommit=false
            listOf(a.id,b.id).sorted().forEach { id -> c.economyRows("SELECT id FROM app_users WHERE id=? FOR NO KEY UPDATE", id) { true } }
            mergeEconomyProfiles(c,a.id,b.id); mergeWorldProfiles(c,a.id,b.id); c.commit()
        }
        val merged = economy.snapshot(a.hash)
        assertEquals(700L, merged.wallet.pearls)
        assertEquals(10_000L, merged.wallet.coins)
        assertEquals(1, merged.wardrobe.count { it == "heather" })
        assertTrue("fern" in merged.wardrobe)
        assertTrue("heather" in world.snapshot(a.hash).state.inventory)
    }

    @Test fun `rare delivery has one transactional effect and private clock is isolated from views owners and failed claims`() = runBlocking<Unit> {
        val p = player(); val stranger = player(); economy.snapshot(p.hash)
        val original = source.connection.use { readEconomyProfile(it, p.id).state }
        val clock = EconomyRareDropClock(remainingSeconds = 900, itemId = "ancient_core")
        execute("UPDATE economy_profiles SET state=?::jsonb WHERE user_id=?", economyJson.encodeToString(original.copy(
            buildings = original.buildings + ("home" to 3), rareDropState = clock)), p.id)
        val start = command(p, economy.snapshot(p.hash), "start_exploration", "forest")
        val attempts = coroutineScope { List(2) { async(Dispatchers.IO) { JdbcEconomyRepository(source).command(p.hash, start) } }.awaitAll() }
        assertEquals(1, attempts.count { it.replayed })
        val active = economy.snapshot(p.hash); val job = active.jobs.single()
        assertEquals("ancient_core", job.rareDrop?.itemId); assertEquals(1L, job.rewards["ancient_core"])
        assertFalse(economyJson.encodeToString(active).contains("rareDropState"))
        assertFalse(economyJson.encodeToString(attempts.first()).contains("remainingSeconds"))
        assertEquals("ECONOMY_OWNER_CHANGED", assertFailsWith<AuthFailure> { economy.command(stranger.hash, start) }.code)
        val hidden = source.connection.use { readEconomyProfile(it, p.id).state }
        val end = Instant.parse("2000-01-01T00:00:00Z")
        val ready = hidden.copy(jobs = listOf(job.copy(startedAt = end.minusSeconds(1800).toString(), finishesAt = end.toString())))
        execute("UPDATE economy_profiles SET state=?::jsonb WHERE user_id=?", economyJson.encodeToString(ready.copy(
            inventory = mapOf("wood" to active.storage.capacity))), p.id)
        val claim = command(p, active, "claim_job", job.id)
        assertEquals("ECONOMY_STORAGE_FULL", assertFailsWith<AuthFailure> { economy.command(p.hash, claim) }.code)
        assertEquals(clock, source.connection.use { readEconomyProfile(it, p.id).state.rareDropState })
        assertEquals("0", scalar("SELECT count(*) FROM economy_commands WHERE user_id=? AND request_id=?", p.id, UUID.fromString(claim.requestId)))
        execute("UPDATE economy_profiles SET state=?::jsonb WHERE user_id=?", economyJson.encodeToString(ready), p.id)
        val results = coroutineScope { List(2) { async(Dispatchers.IO) { JdbcEconomyRepository(source).command(p.hash, claim) } }.awaitAll() }
        assertEquals(1, results.count { it.replayed })
        val delivered = economy.snapshot(p.hash)
        assertEquals(1L, delivered.inventory["ancient_core"]); assertTrue(delivered.jobs.isEmpty())
        val after = source.connection.use { readEconomyProfile(it, p.id).state.rareDropState }
        assertTrue(checkNotNull(after).remainingSeconds in (48 * 3600L - 900)..(144 * 3600L - 900))
        assertTrue(economy.command(p.hash, claim).replayed)
        assertEquals(after, source.connection.use { readEconomyProfile(it, p.id).state.rareDropState })
        assertEquals("1", scalar("SELECT count(*) FROM economy_ledger WHERE user_id=? AND kind='claim_job'", p.id))
        assertFalse(economy.snapshot(stranger.hash).inventory.containsKey("ancient_core"))
    }

    @Test fun `rare start cancellation keeps countdown and type across another repository instance`() = runBlocking<Unit> {
        val p = player(); economy.snapshot(p.hash)
        val initial = source.connection.use { readEconomyProfile(it, p.id).state }
        execute("UPDATE economy_profiles SET state=?::jsonb WHERE user_id=?", economyJson.encodeToString(initial.copy(
            buildings = initial.buildings + ("home" to 3))), p.id)
        val started = economy.command(p.hash, command(p, economy.snapshot(p.hash), "start_exploration", "forest_camp")).state
        val clock = source.connection.use { readEconomyProfile(it, p.id).state.rareDropState }
        assertNotNull(clock)
        val cancelled = economy.command(p.hash, command(p, started, "cancel_exploration", started.jobs.single().id)).state
        val restarted = JdbcEconomyRepository(source).command(p.hash, command(p, cancelled, "start_fishing", "shore")).state
        assertEquals(clock, source.connection.use { readEconomyProfile(it, p.id).state.rareDropState })
        assertNull(restarted.jobs.single().rareDrop?.itemId)
        assertFalse(economyJson.encodeToString(restarted).contains("remainingSeconds"))
    }

    @Test fun `qualifying exploration claim persists stages before modal read and retries preserve dates`() = runBlocking<Unit> {
        val p=player(); val initial=economy.snapshot(p.hash)
        val started=economy.command(p.hash,command(p,initial,"start_exploration","forest")).state
        assertEquals("0",scalar("SELECT count(*) FROM game_achievement_tiers WHERE user_id=?",p.id))
        val state=source.connection.use { readEconomyProfile(it,p.id).state }
        val finishAt=Instant.parse("2000-01-01T00:00:00Z")
        val ready=state.copy(completedExplorations=9,jobs=state.jobs.map { it.copy(
            startedAt=finishAt.minusSeconds(1800).toString(),finishesAt=finishAt.toString()) })
        execute("UPDATE economy_profiles SET state=?::jsonb WHERE user_id=?",economyJson.encodeToString(ready),p.id)
        val request=command(p,started,"claim_job",started.jobs.single().id)
        economy.command(p.hash,request)
        val first=scalar("SELECT unlocked_at FROM game_achievement_tiers WHERE user_id=? AND achievement_id='explorer' AND level=1",p.id)
        assertEquals("1",scalar("SELECT count(*) FROM game_achievement_tiers WHERE user_id=? AND achievement_id='first_path'",p.id))
        assertTrue(economy.command(p.hash,request).replayed)
        assertEquals(first,scalar("SELECT unlocked_at FROM game_achievement_tiers WHERE user_id=? AND achievement_id='explorer' AND level=1",p.id))
        val award=JdbcGameRepository(source).achievements(p.hash).achievements.single { it.id=="explorer" }
        assertEquals(10L,award.progress); assertEquals(50L,award.target)
        assertNotNull(award.tiers.first().unlockedAt); assertNull(award.tiers[1].unlockedAt)
        assertEquals(1L,economy.snapshot(p.hash).progression.routes.getValue("forest"))
    }

    @Test fun `discounted sales persist one rounded payment and reject stale minimum without consuming goods`() = runBlocking<Unit> {
        val p = player()
        economy.snapshot(p.hash)
        val state = source.connection.use { readEconomyProfile(it, p.id).state }
        execute("UPDATE economy_profiles SET state=?::jsonb WHERE user_id=?", economyJson.encodeToString(state.copy(
            inventory = mapOf("berries" to 9L, "fish" to 2L, "crumb_bait" to 1L))), p.id)
        val before = economy.snapshot(p.hash)
        val stale = command(p, before, "sell", "berries", 3).copy(totalPrice = 60)
        assertEquals("ECONOMY_SALE_PRICE_CHANGED", assertFailsWith<AuthFailure> { economy.command(p.hash, stale) }.code)
        assertEquals("ECONOMY_SALE_QUANTITY", assertFailsWith<AuthFailure> {
            economy.command(p.hash, command(p, before, "sell", "crumb_bait"))
        }.code)
        assertEquals(before, economy.snapshot(p.hash).copy(serverTime = before.serverTime))
        assertEquals("0", scalar("SELECT count(*) FROM economy_commands WHERE user_id=?", p.id))
        val sale = command(p, before, "sell", "berries", 3).copy(totalPrice = 50)
        val results = coroutineScope { List(2) { async(Dispatchers.IO) { JdbcEconomyRepository(source).command(p.hash, sale) } }.awaitAll() }
        assertEquals(1, results.count { it.replayed })
        val sold = economy.snapshot(p.hash)
        assertEquals(50L, sold.wallet.coins)
        assertEquals(6L, sold.inventory["berries"])
        assertEquals("1", scalar("SELECT count(*) FROM economy_ledger WHERE user_id=? AND kind='sell'", p.id))
        assertEquals("50", scalar("SELECT coins FROM economy_ledger WHERE user_id=? AND kind='sell'", p.id))
        assertEquals("ECONOMY_REQUEST_CONFLICT", assertFailsWith<AuthFailure> {
            economy.command(p.hash, sale.copy(totalPrice = 40))
        }.code)
        val specialist = economy.command(p.hash, command(p, sold, "sell_fish", "fish", 2)).state
        assertEquals(210L, specialist.wallet.coins)
        assertTrue(specialist.fishing.catches.isEmpty())
    }

    @Test fun `fishing purchases and retries persist equipment once and keep internal draw out of all public views`() = runBlocking<Unit> {
        val p = player()
        economy.snapshot(p.hash)
        val original = source.connection.use { readEconomyProfile(it, p.id).state }
        val funded = original.copy(wallet = EconomyWallet(100_000))
        val stocked = funded.copy(fishingShop = EconomyFishingShops.create(funded, Instant.now(), { 0 }))
        execute("UPDATE economy_profiles SET state=?::jsonb WHERE user_id=?", economyJson.encodeToString(stocked), p.id)
        val stock = economy.snapshot(p.hash)
        val buy = command(p, stock, "buy_fishing_item", checkNotNull(stock.fishingShop).offers.single { it.itemId == "river_rod" }.id).copy(totalPrice = 18050)
        val attempts = coroutineScope { List(2) { async(Dispatchers.IO) { JdbcEconomyRepository(source).command(p.hash, buy) } }.awaitAll() }
        assertEquals(1, attempts.count { it.replayed })
        val bought = economy.snapshot(p.hash)
        assertEquals(82000L, bought.wallet.coins)
        assertEquals(listOf("reed_rod", "river_rod"), bought.fishing.ownedRods)
        assertEquals("1", scalar("SELECT count(*) FROM economy_ledger WHERE user_id=? AND kind='buy_fishing_item'", p.id))
        val equipped = economy.command(p.hash, command(p, bought, "equip_fishing_rod", "river_rod")).state
        val start = command(p, equipped, "start_fishing", "shore")
        val starts = coroutineScope { List(2) { async(Dispatchers.IO) { JdbcEconomyRepository(source).command(p.hash, start) } }.awaitAll() }
        assertEquals(1, starts.count { it.replayed })
        val active = economy.snapshot(p.hash)
        val job = active.jobs.single()
        assertNotEquals(start.requestId, job.id)
        assertEquals("river_rod", job.fishing?.rodId)
        val persisted = source.connection.use { readEconomyProfile(it, p.id).state }
        assertNotNull(persisted.fishingCastSeed)
        assertNotEquals(persisted.fishingCastSeed, job.id)
        assertFalse(economyJson.encodeToString(active).contains("fishingCastSeed"))
        assertFalse(economyJson.encodeToString(starts.first()).contains("fishingCastSeed"))
        val cancel = command(p, active, "cancel_exploration", job.id)
        val cancelled = economy.command(p.hash, cancel).state
        assertTrue(cancelled.fishing.catches.isEmpty())
        val restarted = economy.command(p.hash, command(p, cancelled, "start_fishing", "shore")).state
        assertNotEquals(job.id, restarted.jobs.single().id)
        assertEquals(job.fishing?.fishId, restarted.jobs.single().fishing?.fishId)
        assertEquals(persisted.fishingCastSeed, source.connection.use { readEconomyProfile(it, p.id).state.fishingCastSeed })
        assertEquals(restarted.jobs, economy.command(p.hash, cancel).state.jobs, "an old cancellation receipt cannot cancel the replacement trip")
        finish(p, restarted)
        val claim = command(p, restarted, "claim_job", restarted.jobs.single().id)
        val claims = coroutineScope { List(2) { async(Dispatchers.IO) { JdbcEconomyRepository(source).command(p.hash, claim) } }.awaitAll() }
        assertEquals(1, claims.count { it.replayed })
        val delivered = economy.snapshot(p.hash)
        assertEquals(persisted.jobs.single().rewards, delivered.fishing.catches)
        assertNull(source.connection.use { readEconomyProfile(it, p.id).state.fishingCastSeed })
        assertEquals("1", scalar("SELECT count(*) FROM economy_ledger WHERE user_id=? AND kind='claim_job'", p.id))
        assertEquals("ECONOMY_REVISION_CONFLICT", assertFailsWith<AuthFailure> {
            economy.command(p.hash, claim.copy(requestId = UUID.randomUUID().toString()))
        }.code)
    }

    @Test fun `unclaimed species stay private in snapshots commands replays and admin views while saved catches survive claim`() = runBlocking<Unit> {
        val p = player()
        economy.snapshot(p.hash)
        val initial = source.connection.use { readEconomyProfile(it, p.id).state }
        execute("UPDATE economy_profiles SET state=?::jsonb WHERE user_id=?", economyJson.encodeToString(initial.copy(
            inventory = mapOf("worm_bait" to 1L), fishing = initial.fishing.copy(equippedBaitId = "worm_bait"))), p.id)
        val start = command(p, economy.snapshot(p.hash), "start_exploration", "shore")
        val started = economy.command(p.hash, start).state
        assertEquals(mapOf("fish" to 4L), started.jobs.single().rewards)
        assertEquals("fish", started.jobs.single().fishing?.fishId)
        assertEquals(mapOf("worm_bait" to 1L), started.jobs.single().cost.items)
        assertTrue(started.inventory.isEmpty())
        assertNotEquals(start.requestId, started.jobs.single().id)
        val stored = source.connection.use { readEconomyProfile(it, p.id).state }
        assertNotNull(stored.fishingCastSeed)
        assertNotEquals(start.requestId, stored.fishingCastSeed)
        assertNotEquals(started.jobs.single().id, stored.fishingCastSeed)
        val saved = stored.jobs.single().copy(rewards = mapOf("fish" to 1L, "fish_mooncarp" to 1L, "fish_shark" to 2L),
            fishing = checkNotNull(stored.jobs.single().fishing).copy(fishId = "fish_mooncarp"))
        execute("UPDATE economy_profiles SET state=?::jsonb WHERE user_id=?", economyJson.encodeToString(stored.copy(jobs = listOf(saved))), p.id)
        val snapshot = economy.snapshot(p.hash)
        val replay = economy.command(p.hash, start)
        assertTrue(replay.replayed)
        val admin = source.connection.use { readAdminEconomyPlayer(it, p.publicId, java.time.OffsetDateTime.now()) }
        for (view in listOf(snapshot, replay.state, checkNotNull(admin?.economy))) {
            assertEquals(mapOf("fish" to 4L), view.jobs.single().rewards)
            assertEquals("fish", view.jobs.single().fishing?.fishId)
            assertFalse(economyJson.encodeToString(view).contains("fishingCastSeed"))
        }
        assertEquals(saved, source.connection.use { readEconomyProfile(it, p.id).state.jobs.single() })
        finish(p, snapshot)
        val ready = economy.snapshot(p.hash)
        assertEquals(mapOf("fish" to 4L), ready.jobs.single().rewards, "a finished but unclaimed catch is still cancelable")
        val claim = command(p, ready, "claim_job", saved.id)
        val delivered = economy.command(p.hash, claim).state
        assertEquals(saved.rewards, delivered.inventory)
        assertEquals(saved.rewards, delivered.fishing.catches)
        assertTrue(delivered.jobs.isEmpty())
        assertEquals(delivered.inventory, economy.command(p.hash, claim).state.inventory)
        assertTrue(economy.command(p.hash, start).state.jobs.isEmpty())
    }

    @Test fun `discounted fish purchase retries debit and stock once without opening collection records`() = runBlocking<Unit> {
        val p = player()
        economy.snapshot(p.hash)
        val stored = source.connection.use { readEconomyProfile(it, p.id).state }
        execute("UPDATE economy_profiles SET state=?::jsonb WHERE user_id=?",
            economyJson.encodeToString(stored.copy(wallet = EconomyWallet(100_000))), p.id)
        val before = economy.snapshot(p.hash)
        val offer = checkNotNull(before.fishingShop).offers.single { it.kind == "fish" }
        val buy = command(p, before, "buy_fishing_item", offer.id, 2).copy(totalPrice = offer.unitPrice * 2)
        val attempts = coroutineScope { List(2) { async(Dispatchers.IO) { JdbcEconomyRepository(source).command(p.hash, buy) } }.awaitAll() }
        assertEquals(1, attempts.count { it.replayed })
        val after = economy.snapshot(p.hash)
        assertEquals(before.wallet.coins - offer.unitPrice * 2, after.wallet.coins)
        assertEquals((before.inventory[offer.itemId] ?: 0) + 2, after.inventory[offer.itemId])
        assertEquals(1L, checkNotNull(after.fishingShop).offers.single { it.id == offer.id }.remaining)
        assertEquals(before.fishing, after.fishing)
        assertEquals(before.progression, after.progression)
        assertEquals("1", scalar("SELECT count(*) FROM economy_ledger WHERE user_id=? AND kind='buy_fishing_item'", p.id))
        assertEquals(after.inventory, economy.command(p.hash, buy).state.inventory)
    }

    @Test fun `fishing shop full-storage and stale-price failures roll back payment inventory records and receipts`() = runBlocking<Unit> {
        val p = player()
        economy.snapshot(p.hash)
        val state = source.connection.use { readEconomyProfile(it, p.id).state }
        val fullInventory = state.copy(wallet = EconomyWallet(100_000), inventory = mapOf("wood" to 190L))
        val stocked = fullInventory.copy(fishingShop = EconomyFishingShops.create(fullInventory, Instant.now(), { 0 }))
        execute("UPDATE economy_profiles SET state=?::jsonb WHERE user_id=?", economyJson.encodeToString(stocked), p.id)
        execute("INSERT INTO economy_market_listings(id,seller_id,item_id,quantity,total_price) VALUES (?,?,?,?,?)",
            UUID.randomUUID(), p.id, "stone", 10L, 100L)
        val before = economy.snapshot(p.hash)
        val bait = checkNotNull(before.fishingShop).offers.single { it.kind == "bait" }
        val full = command(p, before, "buy_fishing_item", bait.id).copy(totalPrice = bait.unitPrice)
        assertEquals("ECONOMY_STORAGE_FULL", assertFailsWith<AuthFailure> { economy.command(p.hash, full) }.code)
        val stale = command(p, before, "buy_fishing_item", checkNotNull(before.fishingShop).offers.single { it.itemId == "river_rod" }.id).copy(totalPrice = 17990)
        assertEquals("ECONOMY_FISHING_PRICE_CHANGED", assertFailsWith<AuthFailure> { economy.command(p.hash, stale) }.code)
        assertEquals(before, economy.snapshot(p.hash).copy(serverTime = before.serverTime))
        assertEquals("0", scalar("SELECT count(*) FROM economy_commands WHERE user_id=?", p.id))
        assertEquals("0", scalar("SELECT count(*) FROM economy_ledger WHERE user_id=? AND kind='buy_fishing_item'", p.id))
        val rod = economy.command(p.hash, command(p, before, "buy_fishing_item", checkNotNull(before.fishingShop).offers.single { it.itemId == "river_rod" }.id).copy(totalPrice = 18000)).state
        assertEquals(before.inventory, rod.inventory, "durable tackle does not take warehouse space")
        val freed = economy.command(p.hash, command(p, rod, "sell", "wood", 1)).state
        val bought = economy.command(p.hash, command(p, freed, "buy_fishing_item", bait.id).copy(totalPrice = bait.unitPrice)).state
        assertEquals(1L, bought.inventory[bait.itemId])
        assertTrue(bought.fishing.catches.isEmpty(), "merchant stock is not a fishing achievement")
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
        assertEquals(EconomyRules.localSellPrice(EconomyRules.catalog.items.single { it.id == "berries" }.baseSellPrice, berryCount), acknowledged.state.wallet.coins)
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
            UUID.randomUUID(), p.id, "stone", 10L, 100L)
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
            cost = EconomyCost(1500, mapOf("wood" to 20L)), catalogVersion = 2)
        execute("UPDATE economy_profiles SET state=?::jsonb WHERE user_id=?", economyJson.encodeToString(stored.copy(
            wallet = EconomyWallet(710, pearls * 50), inventory = mapOf("berries" to 8L), jobs = listOf(job))), p.id)
        return p to economy.snapshot(p.hash)
    }

    @Test fun `concurrent speedup retries charge once record pearls and synchronise world geometry atomically`() = runBlocking<Unit> {
        val (p, before) = constructionFixture()
        val speedup = command(p, before, "speedup_construction", before.jobs.single().id).copy(totalPrice = 200)
        val retries = coroutineScope { List(2) { async(Dispatchers.IO) { JdbcEconomyRepository(source).command(p.hash, speedup) } }.awaitAll() }
        assertEquals(1, retries.count { it.replayed })
        val after = economy.snapshot(p.hash)
        assertEquals(EconomyWallet(710, 800), after.wallet)
        assertEquals(before.inventory, after.inventory)
        assertEquals(2, after.buildings["home"])
        assertTrue(after.jobs.isEmpty())
        assertEquals(before.revision + 1, after.revision)
        assertEquals("2", scalar("SELECT state->>'houseLevel' FROM world_profiles WHERE user_id=?", p.id))
        assertEquals("-200", scalar("SELECT pearls FROM economy_ledger WHERE user_id=? AND source_key=?", p.id, "command:${speedup.requestId}"))
        assertEquals("1", scalar("SELECT count(*) FROM economy_ledger WHERE user_id=? AND kind='speedup_construction'", p.id))
        assertEquals("ECONOMY_REVISION_CONFLICT", assertFailsWith<AuthFailure> {
            economy.command(p.hash, speedup.copy(requestId = UUID.randomUUID().toString()))
        }.code)
        assertEquals("ECONOMY_REQUEST_CONFLICT", assertFailsWith<AuthFailure> {
            economy.command(p.hash, speedup.copy(totalPrice = 250))
        }.code)
    }

    @Test fun `separate concurrent speedup commands spend one balance and reject the stale revision`() = runBlocking<Unit> {
        val (p, before) = constructionFixture()
        val commands = List(2) { command(p, before, "speedup_construction", before.jobs.single().id).copy(totalPrice = 200) }
        val attempts = coroutineScope { commands.map { request -> async(Dispatchers.IO) {
            runCatching { JdbcEconomyRepository(source).command(p.hash, request) }
        } }.awaitAll() }
        assertEquals(1, attempts.count { it.isSuccess })
        assertEquals("ECONOMY_REVISION_CONFLICT", (attempts.single { it.isFailure }.exceptionOrNull() as AuthFailure).code)
        assertEquals(800L, economy.snapshot(p.hash).wallet.pearls)
        assertEquals("1", scalar("SELECT count(*) FROM economy_ledger WHERE user_id=? AND kind='speedup_construction'", p.id))
    }

    @Test fun `speedup rejection rolls back currency job revision renderer and audit`() = runBlocking<Unit> {
        val (p, before) = constructionFixture(pearls = 3)
        val speedup = command(p, before, "speedup_construction", before.jobs.single().id).copy(totalPrice = 200)
        assertEquals("ECONOMY_PEARLS", assertFailsWith<AuthFailure> { economy.command(p.hash, speedup) }.code)
        assertEquals("ECONOMY_SPEEDUP_PRICE_CHANGED", assertFailsWith<AuthFailure> { economy.command(p.hash, speedup.copy(totalPrice = 150)) }.code)
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
            command(p, before, "speedup_construction", before.jobs.single().id).copy(totalPrice = 200))
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
        assertEquals(760L, result.wallet.coins)
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
        val supplied = stored.copy(wallet = EconomyWallet(100_000), inventory = homeUpgrade.cost.items,
            buildings = stored.buildings + homeUpgrade.requiredBuildings + ("home" to 1))
        execute("UPDATE economy_profiles SET state=?::jsonb WHERE user_id=?", economyJson.encodeToString(supplied), p.id)
        val initial = economy.snapshot(p.hash)
        val started = economy.command(p.hash, command(p, initial, "start_construction", "home")).state
        assertEquals("1", scalar("SELECT state->>'houseLevel' FROM world_profiles WHERE user_id=?", p.id))
        finish(p, started)
        val completed = economy.command(p.hash, command(p, started, "claim_job", started.jobs.single().id)).state
        assertEquals(2, completed.buildings["home"])
        assertEquals("2", scalar("SELECT state->>'houseLevel' FROM world_profiles WHERE user_id=?", p.id))
        assertEquals(100_000 - homeUpgrade.cost.coins, completed.wallet.coins)
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

    @Test fun `concurrent quarry and cave departures share one actor and retries never recreate finished jobs`() = runBlocking<Unit> {
        for (miningFirst in listOf(true, false)) {
            val p = player()
            economy.snapshot(p.hash)
            val original = source.connection.use { readEconomyProfile(it, p.id).state }
            execute("UPDATE economy_profiles SET state=?::jsonb WHERE user_id=?", economyJson.encodeToString(original.copy(
                buildings = original.buildings + mapOf("home" to 2, "quarry" to 1))), p.id)
            val initial = economy.snapshot(p.hash)
            val mine = command(p, initial, "start_exploration", "quarry_stone")
            val cave = command(p, initial, "start_exploration", "cave")
            val commands = if (miningFirst) listOf(mine, cave) else listOf(cave, mine)
            val results = coroutineScope { commands.map { request -> async(Dispatchers.IO) {
                runCatching { JdbcEconomyRepository(source).command(p.hash, request) }
            } }.awaitAll() }
            assertEquals(1, results.count { it.isSuccess })
            assertEquals("ECONOMY_REVISION_CONFLICT", (results.single { it.isFailure }.exceptionOrNull() as AuthFailure).code)
            val winnerIndex = results.indexOfFirst { it.isSuccess }
            val winner = commands[winnerIndex]; val loser = commands[1 - winnerIndex]
            val accepted = results[winnerIndex].getOrThrow()
            assertEquals(1, accepted.state.jobs.size)
            assertEquals("1", scalar("SELECT count(*) FROM economy_ledger WHERE user_id=? AND kind IN ('start_production','start_exploration')", p.id))
            assertEquals("ECONOMY_EXPLORER_BUSY",
                assertFailsWith<AuthFailure> { economy.command(p.hash, command(p, accepted.state, loser.action, loser.targetId)) }.code)
            assertTrue(economy.command(p.hash, winner).replayed)
            finish(p, accepted.state)
            val claimed = economy.command(p.hash, command(p, economy.snapshot(p.hash), "claim_job", accepted.state.jobs.single().id)).state
            val replacement = economy.command(p.hash, command(p, claimed, loser.action, loser.targetId)).state
            val replay = economy.command(p.hash, winner)
            assertTrue(replay.replayed)
            assertEquals(replacement.jobs, replay.state.jobs)
            assertEquals(replacement.inventory, replay.state.inventory)
        }
    }

    @Test fun `owner fences banned accounts and old journeys cannot be bypassed`() = runBlocking<Unit> {
        val p = player()
        val stranger = player()
        val oldTrip = WorldJourney(UUID.randomUUID().toString(), "first_path", Instant.now().toString(), Instant.now().plusSeconds(600).toString(), WorldResources(), emptyList(), true, 3)
        execute("INSERT INTO world_profiles(user_id,state) VALUES (?,?::jsonb)", p.id, worldJson.encodeToString(WorldState(journeys = listOf(oldTrip))))
        val initial = economy.snapshot(p.hash)
        val stored = source.connection.use { readEconomyProfile(it, p.id).state }
        execute("UPDATE economy_profiles SET state=?::jsonb WHERE user_id=?", economyJson.encodeToString(stored.copy(
            buildings = stored.buildings + ("quarry" to 1))), p.id)
        val quarry = command(p, initial, "start_exploration", "quarry_stone")
        assertEquals("ECONOMY_EXPLORER_BUSY", assertFailsWith<AuthFailure> { economy.command(p.hash, quarry) }.code)
        assertEquals("0", scalar("SELECT count(*) FROM economy_commands WHERE user_id=? AND request_id=?", p.id, UUID.fromString(quarry.requestId)))
        assertEquals(stored.inventory, economy.snapshot(p.hash).inventory)
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
        val savedRewards = source.connection.use { readEconomyProfile(it, p.id).state.jobs.single().rewards }
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
        assertEquals(if (winner.action == "claim_job") savedRewards else before.inventory, after.inventory)
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
                val job = EconomyJob(UUID.randomUUID().toString(), "construction", "home", targetLevel = 2,
                    startedAt = Instant.now().toString(), finishesAt = Instant.now().plusSeconds(1190).toString())
                val requestId = UUID.randomUUID()
                isolated.connection.use { c ->
                    c.economyRows("SELECT id FROM app_users WHERE id=? FOR NO KEY UPDATE", user.id) { true }
                    c.economyUpdate("INSERT INTO economy_profiles(user_id,state) VALUES (?,economy_v2_initial_state('{}'::jsonb))", user.id)
                    val stored = readEconomyProfile(c, user.id).state
                    c.economyUpdate("UPDATE economy_profiles SET state=?::jsonb WHERE user_id=?", economyJson.encodeToString(stored.copy(
                        wallet = EconomyWallet(123, 20), jobs = listOf(job))), user.id)
                    c.economyUpdate("INSERT INTO economy_ledger(user_id,source_key,kind,coins) VALUES (?,'historic','sell',123)", user.id)
                    c.economyUpdate("INSERT INTO economy_commands(user_id,request_id,signature,message,accepted_revision) VALUES (?,?,'preserved','Готово',0)", user.id, requestId)
                    c.commit()
                }
                // A historical fixture must not call the latest view, which reads V39 escrow.
                val before = isolated.connection.use { readEconomyProfile(it, user.id) }
                DatabaseFactory.migrate(isolated)
                DatabaseFactory.migrate(isolated)
                assertEquals(before.copy(state = EconomyMoney.redenominate(before.state), revision = before.revision + 2), isolated.connection.use { readEconomyProfile(it, user.id) })
                val migrated = repo.snapshot(token.hash)
                assertEquals(EconomyMoney.redenominate(before.state).wallet, migrated.wallet)
                isolated.connection.use { c ->
                    assertEquals(123L to 0L, c.economyRows("SELECT coins,pearls FROM economy_ledger WHERE user_id=? AND source_key='historic'", user.id) {
                        it.getLong(1) to it.getLong(2)
                    }.single())
                    assertEquals("preserved", c.economyRows("SELECT signature FROM economy_commands WHERE user_id=? AND request_id=?", user.id, requestId) { it.getString(1) }.single())
                }
                val speedup = EconomyCommand(UUID.randomUUID().toString(), user.publicId, migrated.revision, "speedup_construction", job.id, totalPrice = 200)
                assertEquals(800L, repo.command(token.hash, speedup).state.wallet.pearls)
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
                assertEquals(5000L, converted.wallet.coins)
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
    @Test fun `book delivery persists once under the same claim receipt`() = runBlocking<Unit> {
        val p = player()
        val view = economy.snapshot(p.hash)
        val original = source.connection.use { readEconomyProfile(it, p.id).state }
        val start = Instant.parse("2000-01-01T00:00:00Z")
        val route = EconomyRules.catalog.explorations.single { it.id == "forest_camp" }
        val job = EconomyJob(UUID.randomUUID().toString(), "exploration", route.id,
            startedAt = start.toString(), finishesAt = start.plusSeconds(route.seconds).toString(), rewards = route.rewards, catalogVersion = 2)
        execute("UPDATE economy_profiles SET state=?::jsonb WHERE user_id=?", economyJson.encodeToString(original.copy(jobs = listOf(job))), p.id)
        val collect = command(p, view, "claim_job", job.id)
        val first = economy.command(p.hash, collect)
        val replay = economy.command(p.hash, collect)
        assertFalse(first.replayed); assertTrue(replay.replayed)
        assertEquals(first.state.progression, replay.state.progression)
        assertEquals(mapOf("forest_camp" to 1L), first.state.progression.routes)
        assertEquals(28800L, first.state.progression.collections.travelSeconds)
        assertEquals(4, first.state.progression.collections.finds.size)
        assertEquals(first.state.progression, source.connection.use { readEconomyProfile(it, p.id).state.progression })
    }

    @Test fun `legacy forest ownership joins the book without inventing activity or losing river keepsakes`() = runBlocking<Unit> {
        val p = player()
        val world = JdbcWorldRepository(source)
        world.snapshot(p.hash)
        economy.snapshot(p.hash)
        val inherited = WorldState(collection = listOf("acorn", "feather", "river_pearl"))
        execute("UPDATE world_profiles SET state=?::jsonb WHERE user_id=?", worldJson.encodeToString(inherited), p.id)
        val before = economy.snapshot(p.hash)
        assertEquals(listOf("acorn", "feather"), before.progression.collections.finds)
        assertEquals(0L, before.progression.collections.travelSeconds)
        assertTrue(before.progression.routes.isEmpty()); assertTrue(before.progression.recipes.isEmpty())
        assertEquals(inherited.collection, world.snapshot(p.hash).state.collection)
        val repeated = economy.snapshot(p.hash)
        assertEquals(before.revision, repeated.revision)
        assertEquals(before.progression, repeated.progression)
    }
    @Test fun `merchant paid refresh retries across repository instances charge once and stale offers cannot spend`() = runBlocking<Unit> {
        val p = player()
        val initial = economy.snapshot(p.hash)
        val stored = source.connection.use { readEconomyProfile(it, p.id).state }
        val funded = stored.copy(wallet = EconomyWallet(100_000, 1000), buildings = stored.buildings + ("home" to 5))
        // Use a saved rare pair with ordinary alternatives for deterministic paid-refresh eligibility.
        val replaceable = funded.copy(fishingShop = EconomyFishingShops.create(funded, Instant.now(), { if (it == 10000) 8000 else 0 }))
        execute("UPDATE economy_profiles SET state=?::jsonb WHERE user_id=?", economyJson.encodeToString(replaceable), p.id)
        val before = economy.snapshot(p.hash)
        val shop = checkNotNull(before.fishingShop)
        assertEquals(initial.revision, before.revision)
        val refresh = command(p, before, "refresh_fishing_shop", shop.id).copy(totalPrice = 100)
        val attempts = coroutineScope { List(2) { async(Dispatchers.IO) { JdbcEconomyRepository(source).command(p.hash, refresh) } }.awaitAll() }
        assertEquals(1, attempts.count { it.replayed })
        val next = JdbcEconomyRepository(source).snapshot(p.hash)
        assertEquals(900L, next.wallet.pearls)
        assertNotEquals(shop.id, next.fishingShop?.id)
        assertTrue(checkNotNull(next.fishingShop).offers.none { offer -> shop.offers.any { it.itemId == offer.itemId } })
        assertEquals(next.fishingShop, economy.command(p.hash, refresh).state.fishingShop)
        assertEquals("1", scalar("SELECT count(*) FROM economy_ledger WHERE user_id=? AND kind='refresh_fishing_shop'", p.id))
        assertEquals("-100", scalar("SELECT pearls FROM economy_ledger WHERE user_id=? AND kind='refresh_fishing_shop'", p.id))
        val oldOffer = shop.offers.first()
        assertEquals("ECONOMY_FISHING_SHOP_CHANGED", assertFailsWith<AuthFailure> {
            economy.command(p.hash, command(p, next, "buy_fishing_item", oldOffer.id).copy(totalPrice = oldOffer.unitPrice))
        }.code)
        assertEquals("ECONOMY_REQUEST_CONFLICT", assertFailsWith<AuthFailure> {
            economy.command(p.hash, refresh.copy(totalPrice = 150))
        }.code)
    }

    @Test fun `paid merchant refresh with no different assortment never debits or writes a receipt`() = runBlocking<Unit> {
        val p = player()
        economy.snapshot(p.hash)
        val stored = source.connection.use { readEconomyProfile(it, p.id).state }
        val depleted = stored.copy(wallet = EconomyWallet(100_000, 1000), fishing = stored.fishing.copy(
            ownedRods = stored.fishing.ownedRods + "brook_rod", ownedHooks = stored.fishing.ownedHooks + "round_hook"))
        val stocked = depleted.copy(fishingShop = EconomyFishingShops.create(depleted, Instant.now(), { 0 }))
        execute("UPDATE economy_profiles SET state=?::jsonb WHERE user_id=?", economyJson.encodeToString(stocked), p.id)
        val before = economy.snapshot(p.hash)
        val shop = checkNotNull(before.fishingShop)
        repeat(2) {
            assertEquals("ECONOMY_FISHING_SHOP_NO_REPLACEMENT", assertFailsWith<AuthFailure> {
                JdbcEconomyRepository(source).command(p.hash,
                    command(p, before, "refresh_fishing_shop", shop.id).copy(totalPrice = 100))
            }.code)
        }
        val after = economy.snapshot(p.hash)
        assertEquals(before.revision, after.revision)
        assertEquals(before.wallet, after.wallet)
        assertEquals(before.fishingShop, after.fishingShop)
        assertEquals("0", scalar("SELECT count(*) FROM economy_ledger WHERE user_id=? AND kind='refresh_fishing_shop'", p.id))
    }

    @Test fun `concurrent expiry reads create a single free persisted merchant rotation`() = runBlocking<Unit> {
        val p = player()
        val before = economy.snapshot(p.hash)
        val stored = source.connection.use { readEconomyProfile(it, p.id).state }
        val expired = checkNotNull(stored.fishingShop).copy(refreshAt = "2020-01-01T00:00:00Z")
        execute("UPDATE economy_profiles SET state=?::jsonb WHERE user_id=?", economyJson.encodeToString(stored.copy(fishingShop = expired)), p.id)
        val snapshots = coroutineScope { List(2) { async(Dispatchers.IO) { JdbcEconomyRepository(source).snapshot(p.hash) } }.awaitAll() }
        assertEquals(snapshots.first().fishingShop, snapshots.last().fishingShop)
        assertNotEquals(expired.id, snapshots.first().fishingShop?.id)
        assertEquals(before.revision + 1, snapshots.first().revision)
        assertEquals(snapshots.first().revision, snapshots.last().revision)
        assertEquals(before.wallet, snapshots.first().wallet)
        assertEquals("0", scalar("SELECT count(*) FROM economy_commands WHERE user_id=?", p.id))
    }

}
