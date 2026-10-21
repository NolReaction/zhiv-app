package ru.zhiv.db

import com.zaxxer.hikari.HikariDataSource
import kotlinx.coroutines.*
import kotlinx.serialization.encodeToString
import org.junit.jupiter.api.AfterAll
import org.junit.jupiter.api.BeforeAll
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.TestInstance
import org.testcontainers.containers.PostgreSQLContainer
import org.testcontainers.junit.jupiter.Container
import org.testcontainers.junit.jupiter.Testcontainers
import ru.zhiv.auth.AuthFailure
import ru.zhiv.config.AppConfig
import ru.zhiv.economy.*
import ru.zhiv.security.TokenCodec
import java.time.Instant
import java.util.UUID
import kotlin.test.*

/** Committed daily merchant sales, selected currency, durable receipts and two-device races. */
@Testcontainers(disabledWithoutDocker = true)
@TestInstance(TestInstance.Lifecycle.PER_CLASS)
class JdbcLeaftailV12IntegrationTest {
    private class Postgres(image: String) : PostgreSQLContainer<Postgres>(image)
    companion object { @Container private val postgres = Postgres("postgres:18-alpine") }
    private lateinit var source: HikariDataSource
    private lateinit var economy: JdbcEconomyRepository
    private val tokens = TokenCodec()
    private val spec get() = checkNotNull(EconomyRules.catalog.leaftailShop)
    private data class Player(val id: UUID, val publicId: String, val hash: ByteArray)
    @BeforeAll fun setup() {
        source = DatabaseFactory.create(AppConfig(postgres.jdbcUrl, postgres.username, postgres.password, false, setOf("http://localhost")))
        DatabaseFactory.migrate(source)
        economy = JdbcEconomyRepository(source)
    }
    @AfterAll fun close() { source.close() }
    private fun execute(sql: String, vararg values: Any?) = source.connection.use { c -> c.economyUpdate(sql, *values).also { c.commit() } }
    private fun scalar(sql: String, vararg values: Any?): String = source.connection.use { c -> c.economyRows(sql, *values) { it.getString(1) }.single() }
    private fun edit(p: Player, change: (EconomyState) -> EconomyState) = source.connection.use { c ->
        val next = change(readEconomyProfile(c, p.id).state)
        c.economyUpdate("UPDATE economy_profiles SET state=?::jsonb WHERE user_id=?", economyJson.encodeToString(next), p.id)
        c.commit()
    }
    private suspend fun player(): Player {
        val session = tokens.issue()
        val user = JdbcZhivRepository(source).bootstrap("Листохвост", tokens.issue().hash, session.hash, 365)
        val p = Player(user.id, user.publicId, session.hash)
        economy.snapshot(p.hash)
        edit(p) { it.copy(wallet = EconomyWallet(1_000_000, 10_000), inventory = emptyMap(), buildings = it.buildings + ("home" to 4)) }
        return p
    }
    private fun shelf(snapshot: EconomyView) = EconomyLeaftailShops.offers(EconomyRules.catalog,
        EconomyLeaftailShops.cycle(Instant.parse(snapshot.serverTime), spec), snapshot.ownerPublicId, snapshot.buildings.getValue("home"))
    private fun request(p: Player, snapshot: EconomyView, offer: EconomyLeaftailShops.DailyOffer, quantity: Long = 1) =
        EconomyCommand(UUID.randomUUID().toString(), p.publicId, snapshot.revision, "buy_leaftail_item",
            EconomyLeaftailShops.targetId(spec, EconomyLeaftailShops.cycle(Instant.parse(snapshot.serverTime), spec), offer.id), quantity, offer.unitPrice * quantity)
    private suspend fun assertRejected(p: Player, request: EconomyCommand, code: String) {
        val before = economy.snapshot(p.hash)
        val saved = scalar("SELECT state FROM economy_profiles WHERE user_id=?", p.id)
        assertEquals(code, assertFailsWith<AuthFailure> { economy.command(p.hash, request) }.code)
        val after = economy.snapshot(p.hash)
        assertEquals(before.revision, after.revision)
        assertEquals(before.wallet, after.wallet)
        assertEquals(before.inventory, after.inventory)
        assertEquals(saved, scalar("SELECT state FROM economy_profiles WHERE user_id=?", p.id))
        assertEquals("0", scalar("SELECT count(*) FROM economy_commands WHERE user_id=? AND request_id=?", p.id, UUID.fromString(request.requestId)))
        assertEquals("0", scalar("SELECT count(*) FROM economy_ledger WHERE user_id=? AND source_key=?", p.id, "command:${request.requestId}"))
    }

    @Test fun `relic debits only 300 stored pearls and exact receipt retry grants no second relic or collection credit`() = runBlocking<Unit> {
        val p = player(); val before = economy.snapshot(p.hash)
        val offer = shelf(before).first { it.currency == "pearls" }
        val request = request(p, before, offer)
        val bought = economy.command(p.hash, request)
        assertEquals(before.wallet.coins, bought.state.wallet.coins)
        assertEquals(before.wallet.pearls - 300, bought.state.wallet.pearls)
        assertEquals(1L, bought.state.inventory[offer.itemId])
        assertEquals(before.progression, bought.state.progression)
        assertEquals(1, source.connection.use { readEconomyProfile(it, p.id).state.leaftailShop.purchased[offer.id] })
        val replay = economy.command(p.hash, request)
        assertTrue(replay.replayed)
        assertEquals(bought.acceptedRevision, replay.acceptedRevision)
        assertEquals(bought.state.wallet, replay.state.wallet)
        assertEquals(bought.state.inventory, replay.state.inventory)
        assertEquals("-300", scalar("SELECT pearls FROM economy_ledger WHERE user_id=? AND source_key=?", p.id, "command:${request.requestId}"))
        assertEquals("0", scalar("SELECT coins FROM economy_ledger WHERE user_id=? AND source_key=?", p.id, "command:${request.requestId}"))
        assertEquals("1", scalar("SELECT count(*) FROM economy_commands WHERE user_id=? AND request_id=?", p.id, UUID.fromString(request.requestId)))
    }

    @Test fun `legacy coin stale cycle incorrect currency denomination and insufficient pearls leave no writes`() = runBlocking<Unit> {
        val p = player(); val snapshot = economy.snapshot(p.hash)
        val offer = shelf(snapshot).first { it.currency == "pearls" }
        val request = request(p, snapshot, offer)
        assertRejected(p, request.copy(targetId = request.targetId.removePrefix("v2:")), "ECONOMY_LEAFTAIL_SHOP_CHANGED")
        assertRejected(p, request.copy(targetId = request.targetId.replace("v2:", "coins:")), "ECONOMY_LEAFTAIL_SHOP_CHANGED")
        assertRejected(p, request.copy(totalPrice = 150), "ECONOMY_LEAFTAIL_PRICE_CHANGED")
        assertRejected(p, request.copy(totalPrice = 2400), "ECONOMY_LEAFTAIL_PRICE_CHANGED")
        val old = EconomyLeaftailShops.cycle(Instant.parse(snapshot.serverTime), spec) - 1
        assertRejected(p, request.copy(targetId = EconomyLeaftailShops.targetId(spec, old, offer.id)), "ECONOMY_LEAFTAIL_SHOP_CHANGED")
        edit(p) { it.copy(wallet = it.wallet.copy(pearls = 299)) }
        assertRejected(p, request, "ECONOMY_PEARLS")
    }

    @Test fun `individual supplies support partial repeated purchases with exact total quote and signed quantity`() = runBlocking<Unit> {
        val p = player(); val before = economy.snapshot(p.hash)
        val offer = shelf(before).first { it.kind == "item" && it.currency == "coins" && it.stock >= 10 }
        val first = request(p, before, offer, 3)
        assertRejected(p, first.copy(totalPrice = offer.unitPrice), "ECONOMY_LEAFTAIL_PRICE_CHANGED")
        val one = economy.command(p.hash, first)
        assertEquals(3L, one.state.inventory[offer.itemId])
        assertTrue(economy.command(p.hash, first).replayed)
        assertEquals("ECONOMY_REQUEST_CONFLICT", assertFailsWith<AuthFailure> { economy.command(p.hash, first.copy(quantity = 4, totalPrice = offer.unitPrice * 4)) }.code)
        val rest = economy.command(p.hash, request(p, economy.snapshot(p.hash), offer, offer.stock - 3L))
        assertEquals(offer.stock.toLong(), rest.state.inventory[offer.itemId])
        assertEquals(before.wallet.coins - offer.unitPrice * offer.stock, rest.state.wallet.coins)
        assertEquals(before.wallet.pearls, rest.state.wallet.pearls)
        val state = economy.snapshot(p.hash)
        assertRejected(p, request(p, state, offer), "ECONOMY_LEAFTAIL_STOCK")
    }

    @Test fun `same id on two sessions has one pearl debit one relic and one durable receipt`() = runBlocking<Unit> {
        val p = player(); val snapshot = economy.snapshot(p.hash)
        val offer = shelf(snapshot).first { it.currency == "pearls" }; val request = request(p, snapshot, offer)
        val second = tokens.issue().hash
        execute("INSERT INTO app_sessions(user_id,token_hash,expires_at) VALUES (?,?,clock_timestamp()+interval '1 year')", p.id, second)
        val results = coroutineScope { listOf(p.hash, second).map { session -> async(Dispatchers.IO) { economy.command(session, request) } }.awaitAll() }
        assertEquals(1, results.count { it.replayed })
        val after = economy.snapshot(p.hash)
        assertEquals(snapshot.wallet.pearls - 300, after.wallet.pearls)
        assertEquals(1L, after.inventory[offer.itemId])
        assertEquals("1", scalar("SELECT count(*) FROM economy_commands WHERE user_id=? AND request_id=?", p.id, UUID.fromString(request.requestId)))
    }

    @Test fun `distinct competing relic purchases cannot spend twice and fresh retry observes exhausted stock`() = runBlocking<Unit> {
        val p = player(); val snapshot = economy.snapshot(p.hash)
        val offer = shelf(snapshot).first { it.currency == "pearls" }
        val requests = listOf(request(p, snapshot, offer), request(p, snapshot, offer))
        val results = coroutineScope { requests.map { r -> async(Dispatchers.IO) { runCatching { economy.command(p.hash, r) } } }.awaitAll() }
        assertEquals(1, results.count { it.isSuccess })
        assertEquals("ECONOMY_REVISION_CONFLICT", (results.single { it.isFailure }.exceptionOrNull() as AuthFailure).code)
        val after = economy.snapshot(p.hash)
        assertRejected(p, requests[results.indexOfFirst { it.isFailure }].copy(expectedRevision = after.revision), "ECONOMY_LEAFTAIL_STOCK")
        assertEquals(snapshot.wallet.pearls - 300, after.wallet.pearls)
        assertEquals(1L, after.inventory[offer.itemId])
    }

    @Test fun `full warehouse rejects relic and selected supplies before either currency or stock is consumed`() = runBlocking<Unit> {
        val p = player()
        edit(p) { it.copy(inventory = mapOf("wood" to EconomyRules.storage(it).capacity)) }
        val snapshot = economy.snapshot(p.hash)
        for (offer in shelf(snapshot).filter { it.currency == "pearls" || it.kind == "item" }.take(4)) {
            assertRejected(p, request(p, snapshot, offer), "ECONOMY_STORAGE_FULL")
        }
        assertEquals(0, source.connection.use { readEconomyProfile(it, p.id).state.leaftailShop.purchased.size })
    }

    @Test fun `closed home and forged owner cannot select another personal shelf`() = runBlocking<Unit> {
        val p = player(); val other = player(); val snapshot = economy.snapshot(p.hash)
        val offer = shelf(snapshot).first { it.currency == "pearls" }
        assertRejected(p, request(p, snapshot, offer).copy(ownerPublicId = other.publicId), "ECONOMY_OWNER_CHANGED")
        edit(p) { it.copy(buildings = it.buildings + ("home" to 2)) }
        assertRejected(p, request(p, snapshot, offer), "ECONOMY_HOME_REQUIRED")
    }

    @Test fun `out of range supplies and multi relic commands leave no financial receipt`() = runBlocking<Unit> {
        val p = player(); val snapshot = economy.snapshot(p.hash)
        val relic = shelf(snapshot).first { it.currency == "pearls" }
        assertRejected(p, request(p, snapshot, relic, 2), "INVALID_ECONOMY_COMMAND")
        val supply = shelf(snapshot).first { it.kind == "item" && it.currency == "coins" }
        assertRejected(p, request(p, snapshot, supply, 21), "INVALID_ECONOMY_COMMAND")
        assertRejected(p, request(p, snapshot, supply, supply.stock + 1L), if (supply.stock >= 20) "INVALID_ECONOMY_COMMAND" else "ECONOMY_LEAFTAIL_STOCK")
    }
}
