package ru.zhiv.db

import com.zaxxer.hikari.HikariDataSource
import io.ktor.client.request.*
import io.ktor.http.*
import io.ktor.server.testing.testApplication
import kotlinx.coroutines.*
import kotlinx.serialization.encodeToString
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
    @BeforeEach fun clearListings() { execute("DELETE FROM economy_market_listings") }

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
            val state = row.state.copy(wallet = row.state.wallet.copy(coins = coins), inventory = mapOf("berries" to berries),
                buildings = row.state.buildings + ("home" to if (unlocked) 2 else 1), completedExplorations = if (unlocked) 1 else 0)
            c.economyUpdate("UPDATE economy_profiles SET state=?::jsonb WHERE user_id=?", economyJson.encodeToString(state), user.id)
            c.commit()
        }
        return Player(user.id, user.publicId, token.hash, token.raw)
    }
    private suspend fun command(player: Player, action: String, target: String = "berries", quantity: Long = 1, price: Long = 0) =
        EconomyCommand(UUID.randomUUID().toString(), player.publicId, economy.snapshot(player.hash).revision, action, target, quantity, price)
    private suspend fun offer(player: Player, quantity: Long = 2, price: Long = 6): EconomyMarketListing {
        val previous = market.market(player.hash).mine.map { it.id }.toSet()
        market.command(player.hash, command(player, "create_listing", quantity = quantity, price = price))
        return market.market(player.hash).mine.single { it.id !in previous }
    }
    private suspend fun purchase(player: Player, listing: EconomyMarketListing) =
        command(player, "buy_listing", listing.id, listing.quantity, listing.totalPrice)

    @Test fun `escrow creation retry and cancellation conserve the original finite lot`() = runBlocking<Unit> {
        val p = player()
        val create = command(p, "create_listing", quantity = 3, price = 9)
        val first = market.command(p.hash, create)
        assertEquals(17L, first.state.inventory["berries"])
        assertTrue(market.command(p.hash, create).replayed)
        assertEquals("ECONOMY_REQUEST_CONFLICT", assertFailsWith<AuthFailure> { market.command(p.hash, create.copy(totalPrice = 10)) }.code)
        val lot = market.market(p.hash).mine.single()
        assertEquals(3L, lot.quantity)
        assertEquals(100L, economy.snapshot(p.hash).wallet.coins)
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
        assertEquals(210L, views.sumOf { it.wallet.coins })
        assertEquals(20L, views.sumOf { it.inventory["berries"] ?: 0L })
        assertEquals(25L, views.first().wallet.coins)
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
        assertEquals(94L, economy.snapshot(buyer.hash).wallet.coins)
        assertEquals(106L, economy.snapshot(seller.hash).wallet.coins)
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
        assertEquals(200L, views.sumOf { it.wallet.coins })
        assertEquals(20L, views.sumOf { it.inventory["berries"] ?: 0L })
        assertTrue(market.market(seller.hash).mine.isEmpty())
    }

    @Test fun `reciprocal trades serialize sorted account locks and stale second command can retry`() = runBlocking<Unit> {
        val a = player()
        val b = player()
        val lotA = offer(a)
        val lotB = offer(b)
        val requests = listOf(a to purchase(a, lotB), b to purchase(b, lotA))
        val results = coroutineScope { requests.map { (p, request) -> async(Dispatchers.IO) { runCatching { market.command(p.hash, request) } } }.awaitAll() }
        assertEquals(1, results.count { it.isSuccess })
        assertEquals("ECONOMY_REVISION_CONFLICT", (results.single { it.isFailure }.exceptionOrNull() as AuthFailure).code)
        val failed = results.indexOfFirst { it.isFailure }
        val (p, request) = requests[failed]
        market.command(p.hash, request.copy(expectedRevision = economy.snapshot(p.hash).revision))
        assertEquals(100L, economy.snapshot(a.hash).wallet.coins)
        assertEquals(100L, economy.snapshot(b.hash).wallet.coins)
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
        val seller = player(berries = ECONOMY_MAX_BALANCE)
        offer(seller, 99, 297)
        source.connection.use { c ->
            c.economyRows("SELECT id FROM app_users WHERE id=? FOR NO KEY UPDATE", seller.id) { true }
            assertFailsWith<AuthFailure> { assertEconomyMarketCapacity(c, seller.id, mapOf("berries" to ECONOMY_MAX_BALANCE - 98)) }
            cancelEconomyMarketListings(c, seller.id)
            cancelEconomyMarketListings(c, seller.id)
            c.commit()
        }
        assertEquals(ECONOMY_MAX_BALANCE, economy.snapshot(seller.hash).inventory["berries"])
        assertTrue(market.market(seller.hash).mine.isEmpty())
        assertEquals(1L, scalar("SELECT count(*) FROM economy_ledger WHERE user_id=? AND kind='market_cancel'", seller.id))
    }

    @Test fun `feed is bounded paginated and hides banned sellers`() = runBlocking<Unit> {
        val seller = player()
        val viewer = player()
        repeat(3) { offer(seller, 1, 3) }
        val first = market.market(viewer.hash, limit = 2)
        assertEquals(2, first.listings.size)
        assertTrue(first.mine.isEmpty())
        assertNotNull(first.nextCursor)
        val second = market.market(viewer.hash, first.nextCursor, 2)
        assertEquals(1, second.listings.size)
        assertNull(second.nextCursor)
        assertEquals(3, (first.listings + second.listings).map { it.id }.toSet().size)
        assertTrue(first.listings.all { it.sellerPublicId == seller.publicId && !it.owned })
        assertFalse(economyJson.encodeToString(first).contains(seller.id.toString()))
        execute("UPDATE app_users SET banned_at=clock_timestamp() WHERE id=?", seller.id)
        assertTrue(market.market(viewer.hash).listings.isEmpty())
        assertFailsWith<AuthFailure> { market.market(viewer.hash, limit = 51) }
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
        assertEquals(103L, economy.snapshot(p.hash).wallet.coins)
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
