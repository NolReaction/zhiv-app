package ru.zhiv.db

import com.zaxxer.hikari.HikariDataSource
import io.ktor.client.request.*
import io.ktor.http.*
import io.ktor.server.testing.testApplication
import kotlinx.coroutines.*
import kotlinx.serialization.encodeToString
import org.flywaydb.core.Flyway
import org.junit.jupiter.api.AfterAll
import org.junit.jupiter.api.BeforeAll
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.TestInstance
import org.testcontainers.containers.PostgreSQLContainer
import org.testcontainers.junit.jupiter.Container
import org.testcontainers.junit.jupiter.Testcontainers
import ru.zhiv.auth.AuthFailure
import ru.zhiv.config.AppConfig
import ru.zhiv.economy.*
import ru.zhiv.installZhivApi
import ru.zhiv.security.TokenCodec
import java.util.UUID
import kotlin.test.*

@Testcontainers(disabledWithoutDocker = true)
@TestInstance(TestInstance.Lifecycle.PER_CLASS)
class JdbcEconomyMarketRepositoryIntegrationTest {
    private class Postgres(image: String) : PostgreSQLContainer<Postgres>(image)
    companion object { @Container private val postgres = Postgres("postgres:18-alpine") }
    private lateinit var source: HikariDataSource
    private lateinit var config: AppConfig
    private lateinit var identities: JdbcZhivRepository
    private lateinit var economy: JdbcEconomyRepository
    private lateinit var market: JdbcEconomyMarketRepository
    private val tokens = TokenCodec()
    private data class Player(val id: UUID, val publicId: String, val hash: ByteArray, val raw: String)

    @BeforeAll fun setup() {
        config = AppConfig(postgres.jdbcUrl, postgres.username, postgres.password, false, setOf("http://localhost"))
        source = DatabaseFactory.create(config)
        DatabaseFactory.migrate(source)
        identities = JdbcZhivRepository(source)
        economy = JdbcEconomyRepository(source)
        market = JdbcEconomyMarketRepository(source)
    }
    @AfterAll fun close() { source.close() }
    @BeforeEach fun clearListings() { execute("DELETE FROM economy_market_showcases"); execute("DELETE FROM economy_market_listings") }

    private fun execute(sql: String, vararg values: Any?) = source.connection.use { c ->
        c.economyUpdate(sql, *values).also { c.commit() }
    }
    private fun scalar(sql: String, vararg values: Any?): Long = source.connection.use { c ->
        c.economyRows(sql, *values) { it.getLong(1) }.single()
    }
    private suspend fun player(coins: Long = 100, berries: Long = 20, unlocked: Boolean = true): Player {
        val token = tokens.issue()
        val user = identities.bootstrap("Мохлик", tokens.issue().hash, token.hash, 365)
        economy.snapshot(token.hash)
        source.connection.use { c ->
            val row = readEconomyProfile(c, user.id)
            val state = row.state.copy(wallet = row.state.wallet.copy(coins = coins * 10), inventory = mapOf("berries" to berries),
                buildings = row.state.buildings + ("home" to if (unlocked) 2 else 1), completedExplorations = if (unlocked) 1 else 0)
            c.economyUpdate("UPDATE economy_profiles SET state=?::jsonb WHERE user_id=?", economyJson.encodeToString(state), user.id)
            c.commit()
        }
        return Player(user.id, user.publicId, token.hash, token.raw)
    }
    private fun editState(player: Player, change: (EconomyState) -> EconomyState) {
        source.connection.use { c ->
            val row = readEconomyProfile(c, player.id)
            c.economyUpdate("UPDATE economy_profiles SET state=?::jsonb WHERE user_id=?", economyJson.encodeToString(change(row.state)), player.id)
            c.commit()
        }
    }
    private suspend fun command(player: Player, action: String, target: String = "berries", quantity: Long = 1, price: Long = 0) =
        EconomyCommand(UUID.randomUUID().toString(), player.publicId, economy.snapshot(player.hash).revision, action, target, quantity, if (action == "create_listing") price * 10 else price)
    private suspend fun offer(player: Player, quantity: Long = 2, price: Long = 6): EconomyMarketListing {
        val previous = market.market(player.hash).mine.map { it.id }.toSet()
        market.command(player.hash, command(player, "create_listing", quantity = quantity, price = price))
        return market.market(player.hash).mine.single { it.id !in previous }
    }
    private suspend fun purchase(player: Player, listing: EconomyMarketListing): EconomyCommand {
        market.market(player.hash)
        return command(player, "buy_listing", listing.id, listing.quantity, listing.totalPrice)
    }
    private fun expireShowcase(player: Player) { execute("UPDATE economy_market_showcases SET refresh_at=clock_timestamp()-interval '1 second' WHERE user_id=?", player.id) }

    @Test fun `only confirmed player payment awards first sale to seller inside the transaction`() = runBlocking<Unit> {
        val seller=player(); val buyer=player(berries=0)
        val cancelled=offer(seller)
        assertEquals(0L,scalar("SELECT count(*) FROM game_achievement_tiers WHERE user_id=? AND achievement_id='first_sale'",seller.id))
        market.command(seller.hash,command(seller,"cancel_listing",cancelled.id))
        val lot=offer(seller); val buy=purchase(buyer,lot)
        market.command(buyer.hash,buy)
        assertEquals(1L,scalar("SELECT count(*) FROM game_achievement_tiers WHERE user_id=? AND achievement_id='first_sale'",seller.id))
        assertEquals(0L,scalar("SELECT count(*) FROM game_achievement_tiers WHERE user_id=? AND achievement_id='first_sale'",buyer.id))
        val game=JdbcGameRepository(source)
        val date=game.achievements(seller.hash).achievements.single { it.id=="first_sale" }.unlockedAt
        assertNotNull(date); assertTrue(market.command(buyer.hash,buy).replayed)
        assertEquals(date,game.achievements(seller.hash).achievements.single { it.id=="first_sale" }.unlockedAt)
    }

    @Test fun `escrow creation retry and cancellation conserve the original finite lot`() = runBlocking<Unit> {
        val p = player()
        val create = command(p, "create_listing", quantity = 3, price = 9)
        val first = market.command(p.hash, create)
        assertEquals(17L, first.state.inventory["berries"])
        assertTrue(market.command(p.hash, create).replayed)
        assertEquals("ECONOMY_REQUEST_CONFLICT", assertFailsWith<AuthFailure> { market.command(p.hash, create.copy(totalPrice = 10)) }.code)
        val lot = market.market(p.hash).mine.single()
        assertEquals(3L, lot.quantity)
        assertEquals(1000L, economy.snapshot(p.hash).wallet.coins)
        val cancel = command(p, "cancel_listing", lot.id)
        val result = market.command(p.hash, cancel)
        assertEquals(20L, result.state.inventory["berries"])
        assertTrue(market.command(p.hash, cancel).replayed)
        assertTrue(market.market(p.hash).mine.isEmpty())
        assertEquals(1L, scalar("SELECT count(*) FROM economy_ledger WHERE user_id=? AND kind='market_cancel'", p.id))
    }

    @Test fun `two buyers racing purchase one lot exactly once without minting coins`() = runBlocking<Unit> {
        val seller = player(coins = 10)
        val a = player(berries = 0)
        val b = player(berries = 0)
        val lot = offer(seller, 5, 15)
        val requests = listOf(a to purchase(a, lot), b to purchase(b, lot))
        val results = coroutineScope { requests.map { (p, request) -> async(Dispatchers.IO) { runCatching { market.command(p.hash, request) } } }.awaitAll() }
        assertEquals(1, results.count { it.isSuccess })
        assertEquals("ECONOMY_MARKET_NOT_ACTIVE", (results.single { it.isFailure }.exceptionOrNull() as AuthFailure).code)
        val views = listOf(seller, a, b).map { economy.snapshot(it.hash) }
        assertEquals(2092L, views.sumOf { it.wallet.coins })
        assertEquals(20L, views.sumOf { it.inventory["berries"] ?: 0L })
        assertEquals(242L, views.first().wallet.coins)
        assertEquals(1L, scalar("SELECT count(*) FROM economy_market_listings WHERE id=? AND status='sold'", UUID.fromString(lot.id)))
        assertEquals(1L, scalar("SELECT count(*) FROM economy_ledger WHERE kind='market_buy' AND source_key=?", "market:buy:${lot.id}"))
        val index = results.indexOfFirst { it.isSuccess }
        assertTrue(market.command(requests[index].first.hash, requests[index].second).replayed)
    }

    @Test fun `simultaneous duplicate buy requests return one committed receipt on both devices`() = runBlocking<Unit> {
        val seller = player()
        val buyer = player(berries = 0)
        val lot = offer(seller)
        val request = purchase(buyer, lot)
        val token = tokens.issue()
        execute("INSERT INTO app_sessions(user_id,token_hash,expires_at) VALUES (?,?,clock_timestamp()+interval '1 year')", buyer.id, token.hash)
        val results = coroutineScope { listOf(buyer.hash, token.hash).map { hash -> async(Dispatchers.IO) { market.command(hash, request) } }.awaitAll() }
        assertEquals(1, results.count { it.replayed })
        assertEquals(2L, economy.snapshot(buyer.hash).inventory["berries"])
        assertEquals(940L, economy.snapshot(buyer.hash).wallet.coins)
        assertEquals(1057L, economy.snapshot(seller.hash).wallet.coins)
    }

    @Test fun `seller cancel racing a buy preserves either escrow refund or purchased goods`() = runBlocking<Unit> {
        val seller = player()
        val buyer = player(berries = 0)
        val lot = offer(seller)
        val cancel = command(seller, "cancel_listing", lot.id)
        val buy = purchase(buyer, lot)
        val results = coroutineScope { listOf(seller to cancel, buyer to buy).map { (p, request) ->
            async(Dispatchers.IO) { runCatching { market.command(p.hash, request) } }
        }.awaitAll() }
        assertEquals(1, results.count { it.isSuccess })
        val views = listOf(seller, buyer).map { economy.snapshot(it.hash) }
        assertEquals(if (results[1].isSuccess) 1997L else 2000L, views.sumOf { it.wallet.coins })
        assertEquals(20L, views.sumOf { it.inventory["berries"] ?: 0L })
        assertTrue(market.market(seller.hash).mine.isEmpty())
    }

    @Test fun `reciprocal trades serialize sorted account locks and stale second command can retry`() = runBlocking<Unit> {
        val a = player()
        val b = player()
        val lotA = offer(a)
        val lotB = offer(b)
        expireShowcase(a); expireShowcase(b)
        val requests = listOf(a to purchase(a, lotB), b to purchase(b, lotA))
        val results = coroutineScope { requests.map { (p, request) -> async(Dispatchers.IO) { runCatching { market.command(p.hash, request) } } }.awaitAll() }
        assertEquals(1, results.count { it.isSuccess })
        assertEquals("ECONOMY_REVISION_CONFLICT", (results.single { it.isFailure }.exceptionOrNull() as AuthFailure).code)
        val failed = results.indexOfFirst { it.isFailure }
        val (p, request) = requests[failed]
        market.command(p.hash, request.copy(expectedRevision = economy.snapshot(p.hash).revision))
        assertEquals(997L, economy.snapshot(a.hash).wallet.coins)
        assertEquals(997L, economy.snapshot(b.hash).wallet.coins)
        assertEquals(20L, economy.snapshot(a.hash).inventory["berries"])
        assertEquals(20L, economy.snapshot(b.hash).inventory["berries"])
    }

    @Test fun `invalid ownership stale price insufficient funds and self trade leave offer intact`() = runBlocking<Unit> {
        val seller = player()
        val buyer = player(coins = 0)
        val lot = offer(seller)
        val buy = purchase(buyer, lot)
        assertEquals("ECONOMY_MARKET_QUOTE_CHANGED", assertFailsWith<AuthFailure> { market.command(buyer.hash, buy.copy(totalPrice = 5)) }.code)
        assertEquals("ECONOMY_RESOURCES", assertFailsWith<AuthFailure> { market.command(buyer.hash, buy) }.code)
        assertEquals("ECONOMY_MARKET_OWNER", assertFailsWith<AuthFailure> { market.command(buyer.hash, command(buyer, "cancel_listing", lot.id)) }.code)
        assertEquals("ECONOMY_MARKET_SELF_TRADE", assertFailsWith<AuthFailure> { market.command(seller.hash, purchase(seller, lot)) }.code)
        assertEquals("ECONOMY_OWNER_CHANGED", assertFailsWith<AuthFailure> { market.command(buyer.hash, buy.copy(ownerPublicId = seller.publicId)) }.code)
        assertEquals(1, market.market(seller.hash).mine.size)
        assertEquals(0L, scalar("SELECT count(*) FROM economy_market_receipts WHERE user_id=?", buyer.id))
    }

    @Test fun `market unlock and finite active offer cap apply before spending`() = runBlocking<Unit> {
        val locked = player(unlocked = false)
        assertEquals("ECONOMY_MARKET_LOCKED", assertFailsWith<AuthFailure> {
            market.command(locked.hash, command(locked, "create_listing", quantity = 1, price = 3))
        }.code)
        val seller = player(berries = 30)
        repeat(EconomyMarketRules.MAX_LISTINGS) { offer(seller, 1, 3) }
        assertEquals("ECONOMY_MARKET_LIMIT", assertFailsWith<AuthFailure> { offer(seller, 1, 3) }.code)
        assertEquals(20L, economy.snapshot(seller.hash).inventory["berries"])
        assertEquals("ECONOMY_MARKET_ITEM", assertFailsWith<AuthFailure> {
            market.command(seller.hash, command(seller, "create_listing", "pearls", 1, 3))
        }.code)
    }

    @Test fun `escrow reserves capacity and lifecycle cancellation refunds all lots only once`() = runBlocking<Unit> {
        val seller = player(berries = ECONOMY_MAX_ITEMS)
        editState(seller) { it.copy(buildings=it.buildings + ("home" to 3)) }
        offer(seller, 99, 297)
        source.connection.use { c ->
            c.economyRows("SELECT id FROM app_users WHERE id=? FOR NO KEY UPDATE", seller.id) { true }
            val before = readEconomyProfile(c, seller.id).state
            assertFailsWith<AuthFailure> {
                assertEconomyMarketCapacity(c, seller.id, before, before.copy(inventory=mapOf("berries" to ECONOMY_MAX_ITEMS - 98)))
            }
            cancelEconomyMarketListings(c, seller.id)
            cancelEconomyMarketListings(c, seller.id)
            c.commit()
        }
        assertEquals(ECONOMY_MAX_ITEMS, economy.snapshot(seller.hash).inventory["berries"])
        assertTrue(market.market(seller.hash).mine.isEmpty())
        assertEquals(1L, scalar("SELECT count(*) FROM economy_ledger WHERE user_id=? AND kind='market_cancel'", seller.id))
    }


    @Test fun `mixed warehouse stock plus escrow blocks purchase atomically until space is released`() = runBlocking<Unit> {
        val seller = player()
        val buyer = player(berries = 100)
        editState(buyer) { it.copy(inventory=mapOf("berries" to 100L, "wood" to 100L)) }
        val ownLot = offer(buyer, 2, 6)
        val lot = offer(seller, 2, 6)
        expireShowcase(buyer)
        val before = economy.snapshot(buyer.hash)
        assertEquals(200L, before.storage.capacity)
        assertEquals(198L, before.storage.used)
        assertEquals(2L, before.storage.reserved)
        assertEquals(0L, before.storage.available)
        val buy = purchase(buyer, lot)
        assertEquals("ECONOMY_STORAGE_FULL", assertFailsWith<AuthFailure> { market.command(buyer.hash, buy) }.code)
        val after = economy.snapshot(buyer.hash)
        assertEquals(before.revision, after.revision)
        assertEquals(before.inventory, after.inventory)
        assertEquals(before.wallet, after.wallet)
        assertEquals(1000L, economy.snapshot(seller.hash).wallet.coins)
        assertEquals(1, market.market(seller.hash).mine.size)
        assertEquals(0L, scalar("SELECT count(*) FROM economy_market_receipts WHERE user_id=? AND request_id=?", buyer.id, UUID.fromString(buy.requestId)))
        market.command(buyer.hash, command(buyer, "cancel_listing", ownLot.id))
        assertEquals(200L, economy.snapshot(buyer.hash).storage.used)
        economy.command(buyer.hash, command(buyer, "sell", quantity=2))
        val retry = buy.copy(expectedRevision=economy.snapshot(buyer.hash).revision)
        val purchased = market.command(buyer.hash, retry)
        assertEquals(200L, purchased.state.storage.used)
        assertEquals(0L, purchased.state.storage.overflow)
        assertTrue(market.command(buyer.hash, retry).replayed)
    }


    @Test fun `purchase and harvest racing for the last warehouse slots serialize on the same account`() = runBlocking<Unit> {
        val seller = player()
        val buyer = player(berries = 98)
        val job = EconomyJob(UUID.randomUUID().toString(), "production", "garden", "berries",
            startedAt="2000-01-01T00:00:00Z", finishesAt="2000-01-01T00:01:00Z", rewards=mapOf("berries" to 2L))
        editState(buyer) { it.copy(inventory=mapOf("berries" to 98L, "wood" to 100L), jobs=listOf(job)) }
        val lot = offer(seller, 2, 6)
        val buy = purchase(buyer, lot)
        val claim = command(buyer, "claim_job", job.id)
        val results = coroutineScope { listOf(
            async(Dispatchers.IO) { runCatching { market.command(buyer.hash, buy) } },
            async(Dispatchers.IO) { runCatching { economy.command(buyer.hash, claim) } },
        ).awaitAll() }
        assertEquals(1, results.count { it.isSuccess })
        assertEquals("ECONOMY_REVISION_CONFLICT", (results.single { it.isFailure }.exceptionOrNull() as AuthFailure).code)
        val settled = economy.snapshot(buyer.hash)
        assertEquals(200L, settled.storage.used)
        assertEquals(0L, settled.storage.overflow)
        val loser = if (results.first().isFailure) buy else claim
        val retry = loser.copy(expectedRevision=settled.revision)
        val error = assertFailsWith<AuthFailure> {
            if (retry.action == "buy_listing") market.command(buyer.hash, retry) else economy.command(buyer.hash, retry)
        }
        assertEquals("ECONOMY_STORAGE_FULL", error.code)
        assertEquals(settled.revision, economy.snapshot(buyer.hash).revision)
        assertEquals(settled.inventory, economy.snapshot(buyer.hash).inventory)
    }

    @Test fun `preserved old overflow allows listing cancellation and selling without discarding goods`() = runBlocking<Unit> {
        val seller = player(berries = 260)
        editState(seller) { it.copy(inventory=it.inventory + ("stone" to 40L)) }
        val original = economy.snapshot(seller.hash)
        assertEquals(100L, original.storage.overflow)
        val lot = offer(seller, 10, 30)
        val listed = economy.snapshot(seller.hash)
        assertEquals(290L, listed.storage.used)
        assertEquals(10L, listed.storage.reserved)
        assertEquals(100L, listed.storage.overflow)
        market.command(seller.hash, command(seller, "cancel_listing", lot.id))
        val cancelled = economy.snapshot(seller.hash)
        assertEquals(original.inventory, cancelled.inventory)
        assertEquals(original.wallet, cancelled.wallet, "cancelling never charges a sale fee")
        assertEquals(0L, cancelled.storage.reserved)
        assertEquals(100L, cancelled.storage.overflow)
        val soldLot = offer(seller, 10, 30)
        val buyer = player(berries = 0)
        val buyerBefore = economy.snapshot(buyer.hash)
        val buy = purchase(buyer, soldLot)
        market.command(buyer.hash, buy)
        val sold = economy.snapshot(seller.hash)
        val bought = economy.snapshot(buyer.hash)
        assertEquals(90L, sold.storage.overflow)
        assertEquals(0L, sold.storage.reserved)
        // The overflow is preserved from an older save, but this lot is newly
        // created: its agreed 5% fee on 300 coins is 15, leaving 285 to the seller.
        assertEquals(300L, soldLot.totalPrice)
        assertEquals(500, soldLot.feeBps)
        assertEquals(original.wallet.coins + 285L, sold.wallet.coins)
        assertEquals(buyerBefore.wallet.coins - 300L, bought.wallet.coins)
        assertEquals(original.wallet.coins + buyerBefore.wallet.coins - 15L, sold.wallet.coins + bought.wallet.coins)
        assertEquals(285L, scalar("SELECT coins FROM economy_ledger WHERE user_id=? AND source_key=?", seller.id, "market:sell:${soldLot.id}"))
        assertEquals(-300L, scalar("SELECT coins FROM economy_ledger WHERE user_id=? AND source_key=?", buyer.id, "market:buy:${soldLot.id}"))
        assertTrue(market.command(buyer.hash, buy).replayed)
        val replayedSeller = economy.snapshot(seller.hash)
        val replayedBuyer = economy.snapshot(buyer.hash)
        assertEquals(sold.wallet, replayedSeller.wallet)
        assertEquals(sold.inventory, replayedSeller.inventory)
        assertEquals(sold.storage, replayedSeller.storage)
        assertEquals(bought.wallet, replayedBuyer.wallet)
        assertEquals(bought.inventory, replayedBuyer.inventory)
        assertEquals(1L, scalar("SELECT count(*) FROM economy_ledger WHERE user_id=? AND source_key=?", seller.id, "market:sell:${soldLot.id}"))
        assertEquals(1L, scalar("SELECT count(*) FROM economy_ledger WHERE user_id=? AND source_key=?", buyer.id, "market:buy:${soldLot.id}"))
        economy.command(seller.hash, command(seller, "sell", quantity=10))
        assertEquals(80L, economy.snapshot(seller.hash).storage.overflow)
    }

    @Test fun `items in escrow cannot create spare warehouse space for a ready harvest`() = runBlocking<Unit> {
        val p = player(berries = 200)
        offer(p, 40, 120)
        val job = EconomyJob(UUID.randomUUID().toString(), "production", "garden", "berries",
            startedAt="2000-01-01T00:00:00Z", finishesAt="2000-01-01T00:01:00Z", rewards=mapOf("berries" to 1L))
        editState(p) { it.copy(jobs=listOf(job)) }
        val before = economy.snapshot(p.hash)
        val claim = command(p, "claim_job", job.id)
        assertEquals("ECONOMY_STORAGE_FULL", assertFailsWith<AuthFailure> { economy.command(p.hash, claim) }.code)
        val failed = economy.snapshot(p.hash)
        assertEquals(before.revision, failed.revision)
        assertEquals(before.jobs, failed.jobs)
        assertEquals(before.inventory, failed.inventory)
        assertEquals(0L, scalar("SELECT count(*) FROM economy_commands WHERE user_id=? AND request_id=?", p.id, UUID.fromString(claim.requestId)))
        economy.command(p.hash, command(p, "sell", quantity=1))
        val result = economy.command(p.hash, claim.copy(expectedRevision=economy.snapshot(p.hash).revision))
        assertTrue(result.state.jobs.isEmpty())
        assertEquals(160L, result.state.storage.used)
        assertEquals(40L, result.state.storage.reserved)
        assertEquals(0L, result.state.storage.available)
    }

    @Test fun `showcase is fixed diverse bounded and hides banned sellers without filling their slots`() = runBlocking<Unit> {
        val sellers = List(8) { player() }
        val viewer = player(berries = 0)
        for (seller in sellers) repeat(4) { offer(seller, 1, 3) }
        val first = market.market(viewer.hash)
        assertEquals(12, first.listings.size)
        assertTrue(first.mine.isEmpty())
        assertNull(first.nextCursor)
        assertTrue(first.listings.groupingBy { it.sellerPublicId }.eachCount().values.all { it <= 2 })
        assertEquals(first.listings, market.market(viewer.hash).listings)
        assertEquals(first.listings.take(2), market.market(viewer.hash, limit=2).listings)
        assertFalse(economyJson.encodeToString(first).contains(viewer.id.toString()))
        val selectedSeller = sellers.single { it.publicId == first.listings.first().sellerPublicId }
        execute("UPDATE app_users SET banned_at=clock_timestamp(),ban_reason='Economy test account ban' WHERE id=?", selectedSeller.id)
        val next = market.market(viewer.hash)
        assertEquals(first.listings.filter { it.sellerPublicId != selectedSeller.publicId }, next.listings)
        assertEquals(first.showcase.refreshAt, next.showcase.refreshAt)
        assertFailsWith<AuthFailure> { market.market(viewer.hash, cursor="anything") }
        assertFailsWith<AuthFailure> { market.market(viewer.hash, limit=13) }
    }

    @Test fun `hidden and expired lots cannot be bought by ID and an empty window cannot refresh early`() = runBlocking<Unit> {
        val seller = player()
        val buyer = player(berries = 0)
        val empty = market.market(buyer.hash)
        val lot = offer(seller)
        val request = command(buyer, "buy_listing", lot.id, lot.quantity, lot.totalPrice)
        assertEquals("ECONOMY_MARKET_SHOWCASE_CHANGED", assertFailsWith<AuthFailure> { market.command(buyer.hash, request) }.code)
        assertTrue(market.market(buyer.hash).listings.isEmpty())
        assertEquals(empty.showcase.refreshAt, market.market(buyer.hash).showcase.refreshAt)
        expireShowcase(buyer)
        assertEquals("ECONOMY_MARKET_SHOWCASE_CHANGED", assertFailsWith<AuthFailure> { market.command(buyer.hash, request) }.code)
        assertEquals(lot.id, market.market(buyer.hash).listings.single().id)
        market.command(buyer.hash, request)
        val nextLot = offer(seller)
        assertTrue(market.market(buyer.hash).listings.isEmpty(), "buying never refills a consumed slot")
        assertEquals("ECONOMY_MARKET_SHOWCASE_CHANGED", assertFailsWith<AuthFailure> {
            market.command(buyer.hash, command(buyer, "buy_listing", nextLot.id, nextLot.quantity, nextLot.totalPrice))
        }.code)
        expireShowcase(buyer)
        assertTrue(market.command(buyer.hash, request).replayed, "a committed receipt survives expiry")
        assertEquals(2L, economy.snapshot(buyer.hash).inventory["berries"])
    }

    @Test fun `simultaneous first views create one persistent selection and never multiply purchase slots`() = runBlocking<Unit> {
        val sellers = List(8) { player() }
        for (seller in sellers) repeat(3) { offer(seller, 1, 3) }
        val buyer = player(berries = 0)
        val views = coroutineScope { List(4) { async(Dispatchers.IO) { market.market(buyer.hash) } }.awaitAll() }
        assertTrue(views.all { it.listings == views.first().listings && it.showcase == views.first().showcase })
        assertEquals(1L, scalar("SELECT count(*) FROM economy_market_showcases WHERE user_id=?", buyer.id))
        for (lot in views.first().listings) market.command(buyer.hash, command(buyer, "buy_listing", lot.id, lot.quantity, lot.totalPrice))
        assertTrue(market.market(buyer.hash).listings.isEmpty())
        assertEquals(12L, scalar("SELECT count(*) FROM economy_ledger WHERE user_id=? AND kind='market_buy'", buyer.id))
    }

    @Test fun `home tier and old low prices cannot bypass the showcase and old lots remain refundable`() = runBlocking<Unit> {
        val seller = player(berries = 0)
        editState(seller) { it.copy(inventory=mapOf("tools" to 3L), buildings=it.buildings + ("home" to 4)) }
        market.command(seller.hash, command(seller, "create_listing", "tools", 1, 100))
        val lot = market.market(seller.hash).mine.single()
        val low = player(berries = 0)
        assertTrue(market.market(low.hash).listings.isEmpty())
        assertEquals("ECONOMY_MARKET_SHOWCASE_CHANGED", assertFailsWith<AuthFailure> { market.command(low.hash, purchase(low, lot)) }.code)
        val high = player(berries = 0)
        editState(high) { it.copy(buildings=it.buildings + ("home" to 4)) }
        val buy = purchase(high, lot)
        assertEquals(lot.id, market.market(high.hash).listings.single().id)
        editState(high) { it.copy(buildings=it.buildings + ("home" to 3)) }
        assertEquals("ECONOMY_MARKET_ITEM_LOCKED", assertFailsWith<AuthFailure> { market.command(high.hash, buy) }.code)
        editState(high) { it.copy(buildings=it.buildings + ("home" to 4)) }
        market.command(high.hash, buy)
        assertEquals(0, economy.snapshot(high.hash).buildings["workshop"], "specialization may replace owning a workshop")
        market.command(seller.hash, command(seller, "create_listing", "tools", 1, 100))
        val cheap = market.market(seller.hash).mine.single()
        execute("UPDATE economy_market_listings SET total_price=10 WHERE id=?", UUID.fromString(cheap.id))
        val buyer = player(berries = 0); editState(buyer) { it.copy(buildings=it.buildings + ("home" to 4)) }
        assertTrue(market.market(buyer.hash).listings.isEmpty())
        assertEquals(10L, market.market(seller.hash).mine.single().totalPrice)
        market.command(seller.hash, command(seller, "cancel_listing", cheap.id))
        assertEquals(2L, economy.snapshot(seller.hash).inventory["tools"])
    }

    @Test fun `merchant bait and mandatory shark hook tiers also gate listing and purchase`() = runBlocking<Unit> {
        for ((itemId, home) in listOf("firefly_bait" to 3, "fish_shark" to 4)) {
            val price = EconomyRules.catalog.items.single { it.id == itemId }.baseSellPrice
            val low = player(coins = 1000, berries = 0)
            editState(low) { it.copy(inventory=mapOf(itemId to 1L), buildings=it.buildings + ("home" to home - 1)) }
            val before = economy.snapshot(low.hash)
            assertEquals("ECONOMY_MARKET_ITEM_LOCKED", assertFailsWith<AuthFailure> {
                market.command(low.hash, command(low, "create_listing", itemId, 1, price / 10))
            }.code)
            assertEquals(before.inventory, economy.snapshot(low.hash).inventory)
            assertEquals(before.revision, economy.snapshot(low.hash).revision)

            val seller = player(berries = 0)
            editState(seller) { it.copy(inventory=mapOf(itemId to 2L), buildings=it.buildings + ("home" to home)) }
            market.command(seller.hash, command(seller, "create_listing", itemId, 1, price / 10))
            val lot = market.market(seller.hash).mine.single()
            assertFalse(market.market(low.hash).listings.any { it.id == lot.id })
            assertEquals("ECONOMY_MARKET_SHOWCASE_CHANGED", assertFailsWith<AuthFailure> {
                market.command(low.hash, purchase(low, lot))
            }.code)

            val high = player(coins = 1000, berries = 0)
            editState(high) { it.copy(buildings=it.buildings + ("home" to home)) }
            val buy = purchase(high, lot)
            assertTrue(market.market(high.hash).listings.any { it.id == lot.id })
            editState(high) { it.copy(buildings=it.buildings + ("home" to home - 1)) }
            assertEquals("ECONOMY_MARKET_ITEM_LOCKED", assertFailsWith<AuthFailure> { market.command(high.hash, buy) }.code)
            editState(high) { it.copy(buildings=it.buildings + ("home" to home)) }
            val result = market.command(high.hash, buy)
            assertEquals(1L, result.state.inventory[itemId])
            assertTrue(result.state.fishing.catches.isEmpty())

            market.command(seller.hash, command(seller, "create_listing", itemId, 1, price / 10))
            val remaining = market.market(seller.hash).mine.single()
            editState(seller) { it.copy(buildings=it.buildings + ("home" to home - 1)) }
            assertEquals(1L, market.command(seller.hash, command(seller, "cancel_listing", remaining.id)).state.inventory[itemId])
        }
    }

    @Test fun `request ids cannot be reused across market and production endpoints`() = runBlocking<Unit> {
        val p = player()
        val sell = command(p, "sell", quantity = 1)
        economy.command(p.hash, sell)
        val create = command(p, "create_listing", quantity = 1, price = 3).copy(requestId = sell.requestId)
        assertEquals("ECONOMY_REQUEST_CONFLICT", assertFailsWith<AuthFailure> { market.command(p.hash, create) }.code)
        val fresh = create.copy(requestId = UUID.randomUUID().toString())
        market.command(p.hash, fresh)
        val duplicate = command(p, "sell", quantity = 1).copy(requestId = fresh.requestId)
        assertEquals("ECONOMY_REQUEST_CONFLICT", assertFailsWith<AuthFailure> { economy.command(p.hash, duplicate) }.code)
        assertEquals(18L, economy.snapshot(p.hash).inventory["berries"])
        assertEquals(1000L + EconomyRules.localSellPrice(30), economy.snapshot(p.hash).wallet.coins)
    }

    @Test fun `V36 preserves populated V35 listings paid quotes balances receipts and escrow`() = runBlocking<Unit> {
        val database = "showcase_upgrade_${UUID.randomUUID().toString().replace("-", "")}"
        source.connection.use { c -> c.autoCommit = true; c.economyUpdate("CREATE DATABASE $database") }
        try {
            val isolatedConfig = config.copy(databaseUrl="jdbc:postgresql://${postgres.host}:${postgres.getMappedPort(5432)}/$database")
            DatabaseFactory.create(isolatedConfig).use { isolated ->
                Flyway.configure().dataSource(isolated).locations("classpath:db/migration").target("35").load().migrate()
                val token = tokens.issue()
                val user = JdbcZhivRepository(isolated).bootstrap("Прежняя лавка", tokens.issue().hash, token.hash, 365)
                val repo = JdbcEconomyRepository(isolated)
                val lot = UUID.randomUUID(); val request = UUID.randomUUID()
                isolated.connection.use { c ->
                    c.economyRows("SELECT id FROM app_users WHERE id=? FOR NO KEY UPDATE", user.id) { true }
                    c.economyUpdate("INSERT INTO economy_profiles(user_id,state) VALUES (?,economy_v2_initial_state('{}'::jsonb))", user.id)
                    val historical = c.economyRows("SELECT state FROM economy_profiles WHERE user_id=?", user.id) {
                        economyJson.decodeFromString<EconomyState>(it.getString(1)) }.single()
                    val state = historical.copy(wallet=EconomyWallet(123, 20),
                        inventory=mapOf("berries" to 17L), buildings=mapOf("home" to 2, "warehouse" to 1), completedExplorations=1)
                    c.economyUpdate("UPDATE economy_profiles SET state=?::jsonb,revision=7 WHERE user_id=?", economyJson.encodeToString(state), user.id)
                    c.economyUpdate("INSERT INTO economy_market_listings(id,seller_id,item_id,quantity,total_price) VALUES (?,?,'berries',3,3)", lot, user.id)
                    c.economyUpdate("INSERT INTO economy_market_receipts(user_id,request_id,signature,message,accepted_revision) VALUES (?,?,'old-signature','Размещено',7)", user.id, request)
                    c.economyUpdate("INSERT INTO economy_ledger(user_id,source_key,kind,items) VALUES (?,'old-listing','market_create','{\"berries\":-3}'::jsonb)", user.id)
                    c.commit()
                }
                fun rows(table: String) = isolated.connection.use { c -> c.economyRows("SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]'::jsonb)::text FROM $table t") { it.getString(1) }.single() }
                val tables = listOf("economy_profiles", "economy_market_listings", "economy_market_receipts", "economy_ledger")
                val before = tables.associateWith(::rows)
                val showcaseMigration = Flyway.configure().dataSource(isolated).locations("classpath:db/migration").target("36").load()
                showcaseMigration.migrate(); showcaseMigration.migrate()
                assertEquals(before, tables.associateWith(::rows))
                DatabaseFactory.migrate(isolated)
                assertEquals(9L, isolated.connection.use { readEconomyProfile(it, user.id).revision }, "V40 and V41 each convert once")
                val upgraded = JdbcEconomyMarketRepository(isolated)
                val view = upgraded.market(token.hash)
                assertEquals(30L, view.mine.single().totalPrice, "old quote changes denomination without losing the offer")
                val current = repo.snapshot(token.hash)
                assertEquals(10L, current.revision, "Current merchant stock is initialized once after both conversions")
                assertEquals(3L, current.storage.reserved)
                val cancel = EconomyCommand(UUID.randomUUID().toString(), user.publicId, current.revision, "cancel_listing", lot.toString())
                val result = upgraded.command(token.hash, cancel)
                assertEquals(20L, result.state.inventory["berries"])
                assertEquals(EconomyWallet(1230, 1000), result.state.wallet)
                assertTrue(upgraded.command(token.hash, cancel).replayed)
            }
        } finally { source.connection.use { c -> c.autoCommit = true; c.economyUpdate("DROP DATABASE $database WITH (FORCE)") } }
    }

    @Test fun `current seller and buyer home segments are checked again after selection`() = runBlocking<Unit> {
        val seller=player(); val buyer=player(berries=0); val high=player(berries=0)
        editState(high) { it.copy(buildings=it.buildings + ("home" to 4)) }
        val lot=offer(seller); val buy=purchase(buyer,lot)
        assertTrue(market.market(high.hash).listings.isEmpty())
        val before=economy.snapshot(buyer.hash)
        editState(seller) { it.copy(buildings=it.buildings + ("home" to 4)) }
        assertTrue(market.market(buyer.hash).listings.isEmpty(), "cached IDs must be filtered against current seller home")
        assertEquals("ECONOMY_MARKET_HOME_BAND", assertFailsWith<AuthFailure> { market.command(buyer.hash,buy) }.code)
        assertEquals(before.wallet,economy.snapshot(buyer.hash).wallet)
        assertEquals(before.inventory,economy.snapshot(buyer.hash).inventory)
        assertEquals(0L,scalar("SELECT count(*) FROM economy_market_daily_turnover WHERE user_id=?",buyer.id))
        editState(seller) { it.copy(buildings=it.buildings + ("home" to 2)) }
        editState(buyer) { it.copy(buildings=it.buildings + ("home" to 4)) }
        assertEquals("ECONOMY_MARKET_HOME_BAND", assertFailsWith<AuthFailure> { market.command(buyer.hash,buy) }.code)
        market.command(seller.hash,command(seller,"cancel_listing",lot.id))
        assertEquals(20L,economy.snapshot(seller.hash).inventory["berries"])
    }

    @Test fun `base value cap is separate from gold paid and duplicate receipts never spend it twice`() = runBlocking<Unit> {
        val seller=player(); val buyer=player(coins=1000,berries=0)
        val lot=offer(seller,2,12)
        execute("INSERT INTO economy_market_daily_turnover(user_id,trade_day,buys_value) VALUES (?,(clock_timestamp() AT TIME ZONE 'UTC')::date,2340)",buyer.id)
        val request=purchase(buyer,lot)
        market.command(buyer.hash,request)
        assertEquals(500,lot.feeBps)
        assertEquals(9880L,economy.snapshot(buyer.hash).wallet.coins)
        assertEquals(1114L,economy.snapshot(seller.hash).wallet.coins)
        assertEquals(2400L,market.market(buyer.hash).tradeBudget!!.buysUsed)
        assertEquals(60L,market.market(seller.hash).tradeBudget!!.salesUsed)
        assertEquals(0L,market.market(buyer.hash).tradeBudget!!.salesUsed)
        assertEquals(114L,scalar("SELECT coins FROM economy_ledger WHERE user_id=? AND source_key=?",seller.id,"market:sell:${lot.id}"))
        assertTrue(market.command(buyer.hash,request).replayed)
        assertEquals(2400L,market.market(buyer.hash).tradeBudget!!.buysUsed)
        val other=offer(seller,1,3);expireShowcase(buyer)
        val blocked=purchase(buyer,other);val before=economy.snapshot(buyer.hash)
        assertEquals("ECONOMY_MARKET_DAILY_LIMIT",assertFailsWith<AuthFailure>{market.command(buyer.hash,blocked)}.code)
        assertEquals(before.wallet,economy.snapshot(buyer.hash).wallet)
        assertEquals(before.inventory,economy.snapshot(buyer.hash).inventory)
        execute("UPDATE economy_market_daily_turnover SET trade_day=trade_day-1 WHERE user_id=?",buyer.id)
        assertEquals(0L,market.market(buyer.hash).tradeBudget!!.buysUsed)
        market.command(buyer.hash,blocked)
        assertEquals(30L,market.market(buyer.hash).tradeBudget!!.buysUsed)
        assertTrue(market.command(buyer.hash,request).replayed)
        assertEquals(30L,market.market(buyer.hash).tradeBudget!!.buysUsed)
    }

    @Test fun `two buyers cannot race distinct lots past the seller daily budget`() = runBlocking<Unit> {
        val seller=player();val a=player(berries=0);val b=player(berries=0)
        val first=offer(seller);val second=offer(seller)
        execute("INSERT INTO economy_market_daily_turnover(user_id,trade_day,sales_value) VALUES (?,(clock_timestamp() AT TIME ZONE 'UTC')::date,2340)",seller.id)
        val requests=listOf(a to purchase(a,first),b to purchase(b,second))
        val results=coroutineScope{requests.map{(p,request)->async(Dispatchers.IO){runCatching{market.command(p.hash,request)}}}.awaitAll()}
        assertEquals(1,results.count{it.isSuccess})
        assertEquals("ECONOMY_MARKET_SELLER_DAILY_LIMIT",(results.single{it.isFailure}.exceptionOrNull() as AuthFailure).code)
        assertEquals(2400L,market.market(seller.hash).tradeBudget!!.salesUsed)
        assertEquals(1,market.market(seller.hash).mine.size)
        assertEquals(2L,listOf(a,b).sumOf{economy.snapshot(it.hash).inventory["berries"]?:0L})
        assertEquals(60L,listOf(a,b).sumOf{market.market(it.hash).tradeBudget!!.buysUsed})
        assertEquals(1057L,economy.snapshot(seller.hash).wallet.coins)
    }

    @Test fun `new oversized lots fail but historical price and fee agreements remain refundable`() = runBlocking<Unit> {
        val seller=player(berries=99);val before=economy.snapshot(seller.hash)
        assertEquals("ECONOMY_MARKET_DAILY_LOT_LIMIT",assertFailsWith<AuthFailure>{offer(seller,81,243)}.code)
        assertEquals(before.inventory,economy.snapshot(seller.hash).inventory)
        val old=offer(seller)
        execute("UPDATE economy_market_listings SET seller_fee_bps=0 WHERE id=?",UUID.fromString(old.id))
        val buyer=player(berries=0);val loaded=market.market(buyer.hash).listings.single()
        assertEquals(0,loaded.feeBps)
        val historicalBuy=purchase(buyer,loaded)
        market.command(buyer.hash,historicalBuy)
        assertEquals(1060L,economy.snapshot(seller.hash).wallet.coins)
        assertEquals(940L,economy.snapshot(buyer.hash).wallet.coins)
        assertEquals(60L,scalar("SELECT coins FROM economy_ledger WHERE user_id=? AND source_key=?",seller.id,"market:sell:${loaded.id}"))
        assertTrue(market.command(buyer.hash,historicalBuy).replayed)
        assertEquals(1060L,economy.snapshot(seller.hash).wallet.coins,"replay retains the historical zero-fee agreement")
        assertEquals(940L,economy.snapshot(buyer.hash).wallet.coins)
        val overpriced=offer(seller)
        execute("UPDATE economy_market_listings SET total_price=300 WHERE id=?",UUID.fromString(overpriced.id))
        val nextBuyer=player(berries=0)
        assertTrue(market.market(nextBuyer.hash).listings.isEmpty())
        assertEquals(300L,market.market(seller.hash).mine.single().totalPrice)
        market.command(seller.hash,command(seller,"cancel_listing",overpriced.id))
        assertEquals(97L,economy.snapshot(seller.hash).inventory["berries"])
    }

    @Test fun `daily fences survive profile reset and sum safely during account merge`() = runBlocking<Unit> {
        val target=player();val other=player()
        source.connection.use { c ->
            c.economyRows("SELECT id FROM app_users WHERE id IN (?,?) ORDER BY id FOR NO KEY UPDATE",target.id,other.id){true}
            val at=java.time.Instant.parse("2026-10-06T23:59:59Z")
            addEconomyTradeUsage(c,target.id,at,buys=2300,sales=1000,barter=1)
            addEconomyTradeUsage(c,other.id,at,buys=200,sales=1500,barter=1)
            mergeEconomyTradeUsage(c,target.id,other.id)
            assertEquals(EconomyTradeUsage(2500,2500,2),readEconomyTradeUsage(c,target.id,at))
            removeEconomyProfile(c,target.id)
            ensureEconomyProfile(c,target.id)
            assertEquals(EconomyTradeUsage(2500,2500,2),readEconomyTradeUsage(c,target.id,at))
            assertEquals(EconomyTradeUsage(),readEconomyTradeUsage(c,target.id,at.plusSeconds(1)))
            assertEquals("2026-10-07T00:00:00Z",economyTradeResetsAt(at))
            c.rollback()
        }
    }

    @Test fun `V43 keeps V42 wallet escrow receipts and quoted proceeds intact`() = runBlocking<Unit> {
        val database="market_limits_${UUID.randomUUID().toString().replace("-", "")}"
        source.connection.use{c->c.autoCommit=true;c.economyUpdate("CREATE DATABASE $database")}
        try {
            val isolatedConfig=config.copy(databaseUrl="jdbc:postgresql://${postgres.host}:${postgres.getMappedPort(5432)}/$database")
            DatabaseFactory.create(isolatedConfig).use { isolated ->
                Flyway.configure().dataSource(isolated).locations("classpath:db/migration").target("42").load().migrate()
                val token=tokens.issue()
                val user=JdbcZhivRepository(isolated).bootstrap("До защиты рынка",tokens.issue().hash,token.hash,365)
                val lot=UUID.randomUUID();val request=UUID.randomUUID()
                isolated.connection.use { c ->
                    val state=EconomyRules.initial(homeLevel=2).copy(wallet=EconomyWallet(1230,450),inventory=mapOf("berries" to 17L),completedExplorations=1)
                    c.economyUpdate("INSERT INTO economy_profiles(user_id,state,revision) VALUES (?,?::jsonb,7)",user.id,economyJson.encodeToString(state))
                    c.economyUpdate("INSERT INTO economy_market_listings(id,seller_id,item_id,quantity,total_price) VALUES (?,?,'berries',3,90)",lot,user.id)
                    c.economyUpdate("INSERT INTO economy_market_receipts(user_id,request_id,signature,message,accepted_revision) VALUES (?,?,'before-v43','Размещено',7)",user.id,request)
                    c.commit()
                }
                fun rows(table:String)=isolated.connection.use { c -> c.economyRows("SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]'::jsonb)::text FROM $table t"){it.getString(1)}.single() }
                val before=listOf("economy_profiles","economy_market_receipts","economy_ledger").associateWith(::rows)
                DatabaseFactory.migrate(isolated);DatabaseFactory.migrate(isolated)
                assertEquals(before,before.keys.associateWith(::rows))
                isolated.connection.use { c ->
                    assertEquals(0,c.economyRows("SELECT seller_fee_bps FROM economy_market_listings WHERE id=?",lot){it.getInt(1)}.single())
                    assertEquals(90L,c.economyRows("SELECT total_price FROM economy_market_listings WHERE id=?",lot){it.getLong(1)}.single())
                    assertEquals(3L,reservedEconomyMarketItems(c,user.id)["berries"])
                    assertEquals(0L,c.economyRows("SELECT count(*) FROM economy_market_daily_turnover"){it.getLong(1)}.single())
                }
            }
        } finally { source.connection.use{c->c.autoCommit=true;c.economyUpdate("DROP DATABASE $database WITH (FORCE)")} }
    }

    @Test fun `HTTP market requires auth trusted origin and strict numeric command payloads`() = testApplication {
        application { installZhivApi(identities, identities, config, tokens, economy = economy, economyMarket = market) }
        val p = player()
        assertEquals(HttpStatusCode.Unauthorized, client.get("/api/v1/economy/market").status)
        val get = client.get("/api/v1/economy/market") { cookie(config.cookieName, p.raw) }
        assertEquals(HttpStatusCode.OK, get.status)
        assertEquals("no-store", get.headers[HttpHeaders.CacheControl])
        assertEquals(HttpStatusCode.BadRequest, client.get("/api/v1/economy/market?limit=500") { cookie(config.cookieName, p.raw) }.status)
        assertEquals(HttpStatusCode.BadRequest, client.get("/api/v1/economy/market?owner=another") { cookie(config.cookieName, p.raw) }.status)
        val create = command(p, "create_listing", quantity = 2, price = 6)
        val json = economyJson.encodeToString(create)
        suspend fun post(body: String, origin: String = "http://localhost") = client.post("/api/v1/economy/market/commands") {
            cookie(config.cookieName, p.raw)
            header(HttpHeaders.Origin, origin)
            contentType(ContentType.Application.Json)
            setBody(body)
        }
        assertEquals(HttpStatusCode.Forbidden, post(json, "https://foreign.example").status)
        assertEquals(HttpStatusCode.BadRequest, post(json.replace("\"quantity\":2", "\"quantity\":\"2\"")).status)
        assertEquals(HttpStatusCode.BadRequest, post(json.replace("\"quantity\":2", "\"quantity\":2.5")).status)
        assertEquals(HttpStatusCode.BadRequest, post(json.dropLast(1) + ",\"coins\":10000}").status)
        assertEquals(HttpStatusCode.Conflict, post(economyJson.encodeToString(create.copy(expectedRevision = 99))).status)
        assertEquals(HttpStatusCode.OK, post(json).status)
        assertEquals(18L, economy.snapshot(p.hash).inventory["berries"])
    }
}
