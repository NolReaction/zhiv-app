package ru.zhiv.db

import com.zaxxer.hikari.HikariDataSource
import kotlinx.coroutines.runBlocking
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
import ru.zhiv.security.TokenCodec
import java.util.UUID
import javax.sql.DataSource
import kotlin.test.*

@Testcontainers(disabledWithoutDocker = true)
@TestInstance(TestInstance.Lifecycle.PER_CLASS)
class JdbcMarketUnlocksSlotsIntegrationTest {
    private class Postgres(image: String) : PostgreSQLContainer<Postgres>(image)
    companion object { @Container private val postgres = Postgres("postgres:18-alpine") }
    private lateinit var source: HikariDataSource
    private lateinit var economy: JdbcEconomyRepository
    private lateinit var market: JdbcEconomyMarketRepository
    private val tokens = TokenCodec()
    private data class Player(val id: UUID, val publicId: String, val hash: ByteArray)

    private fun config(database: String? = null) = AppConfig(
        database?.let { "jdbc:postgresql://${postgres.host}:${postgres.getMappedPort(5432)}/$it" } ?: postgres.jdbcUrl,
        postgres.username, postgres.password, false, setOf("http://localhost"))

    @BeforeAll fun setup() {
        source = DatabaseFactory.create(config())
        DatabaseFactory.migrate(source)
        economy = JdbcEconomyRepository(source)
        market = JdbcEconomyMarketRepository(source)
    }
    @AfterAll fun close() { source.close() }
    @BeforeEach fun clearLots() {
        execute(source, "DELETE FROM economy_market_showcases")
        execute(source, "DELETE FROM economy_market_listings")
    }
    private fun execute(db: DataSource, sql: String, vararg values: Any?) = db.connection.use { c ->
        c.economyUpdate(sql, *values).also { c.commit() }
    }
    private fun scalar(db: DataSource, sql: String, vararg values: Any?): String = db.connection.use { c ->
        c.economyRows(sql, *values) { it.getString(1) }.single()
    }
    private suspend fun player(): Player {
        val token = tokens.issue()
        val user = JdbcZhivRepository(source).bootstrap("Лавка", tokens.issue().hash, token.hash, 365)
        economy.snapshot(token.hash)
        edit(user.id) { it.copy(buildings=it.buildings+mapOf("home" to 3,"bridge" to 1), completedExplorations=1,
            wallet=it.wallet.copy(coins=10000, pearls=2000), inventory=mapOf("berries" to 20), itemUnlockVersion=1) }
        return Player(user.id,user.publicId,token.hash)
    }
    private fun edit(user: UUID, change: (EconomyState) -> EconomyState) = source.connection.use { c ->
        val state = change(readEconomyProfile(c,user).state)
        c.economyUpdate("UPDATE economy_profiles SET state=?::jsonb WHERE user_id=?",economyJson.encodeToString(state),user)
        c.commit()
    }
    private suspend fun command(player: Player, action: String, target: String, quantity: Long=1, price: Long=0) =
        EconomyCommand(UUID.randomUUID().toString(),player.publicId,economy.snapshot(player.hash).revision,
            action,target,quantity,price)

    @Test fun `five places expand once and legacy excess lots remain cancellable`() = runBlocking<Unit> {
        val p=player()
        repeat(5) { market.command(p.hash,command(p,"create_listing","berries",price=10)) }
        assertEquals("ECONOMY_MARKET_LIMIT",assertFailsWith<AuthFailure> {
            market.command(p.hash,command(p,"create_listing","berries",price=10)) }.code)
        val before=economy.snapshot(p.hash)
        val offer=assertNotNull(EconomyRules.marketSlotOffer(readState(p)))
        val purchase=command(p,"buy_market_slot",offer.targetId,price=offer.pricePearls)
        val expanded=economy.command(p.hash,purchase)
        assertEquals(6,expanded.state.marketSlots)
        assertEquals(before.wallet.pearls-offer.pricePearls,expanded.state.wallet.pearls)
        assertTrue(economy.command(p.hash,purchase).replayed)
        assertEquals(expanded.state.wallet,economy.snapshot(p.hash).wallet)
        market.command(p.hash,command(p,"create_listing","berries",price=10))
        edit(p.id) { it.copy(marketSlots=5) }
        val lots=market.market(p.hash).mine
        assertEquals(6,lots.size)
        for (lot in lots) market.command(p.hash,command(p,"cancel_listing",lot.id))
        assertEquals(20L,economy.snapshot(p.hash).inventory["berries"])
    }

    private fun readState(player: Player) = source.connection.use { readEconomyProfile(it,player.id).state }

    @Test fun `missing bridge blocks both peers without losing paid places escrow or replay receipts`() = runBlocking<Unit> {
        val seller=player(); val buyer=player()
        val create=command(seller,"create_listing","berries",price=10)
        market.command(seller.hash,create)
        val lot=market.market(seller.hash).mine.single()
        assertEquals(lot.id,market.market(buyer.hash).listings.single().id)
        edit(seller.id) { it.copy(buildings=it.buildings-"bridge",marketSlots=10) }
        val before=economy.snapshot(seller.hash)
        assertEquals(10,before.marketSlots)
        assertTrue(market.market(buyer.hash).listings.isEmpty(),"Cached showcase cannot expose a locked seller")
        assertEquals(lot.id,market.market(seller.hash).mine.single().id)
        assertTrue(market.command(seller.hash,create).replayed,"A bridge gate does not rewrite a committed receipt")
        assertEquals("ECONOMY_MARKET_LOCKED",assertFailsWith<AuthFailure> {
            market.command(seller.hash,command(seller,"create_listing","berries",price=10)) }.code)
        assertEquals("ECONOMY_MARKET_LOCKED",assertFailsWith<AuthFailure> {
            economy.command(seller.hash,command(seller,"buy_market_slot","market:11",price=500)) }.code)
        assertEquals("ECONOMY_MARKET_LOCKED",assertFailsWith<AuthFailure> {
            market.command(buyer.hash,command(buyer,"buy_listing",lot.id,lot.quantity,lot.totalPrice)) }.code)
        assertEquals("active",scalar(source,"SELECT status FROM economy_market_listings WHERE id=?",UUID.fromString(lot.id)))
        assertEquals(before.wallet,economy.snapshot(seller.hash).wallet)
        market.command(seller.hash,command(seller,"cancel_listing",lot.id))
        assertEquals(20L,economy.snapshot(seller.hash).inventory["berries"])
        assertEquals(10,economy.snapshot(seller.hash).marketSlots)

        edit(seller.id) { it.copy(buildings=it.buildings+("bridge" to 1),completedExplorations=0) }
        market.command(seller.hash,command(seller,"create_listing","berries",price=10))
        val restoredLot=market.market(seller.hash).mine.single()
        execute(source,"UPDATE economy_market_showcases SET refresh_at=clock_timestamp()-interval '1 second' WHERE user_id=?",buyer.id)
        assertEquals(restoredLot.id,market.market(buyer.hash).listings.single().id)
        edit(buyer.id) { it.copy(buildings=it.buildings+("bridge" to 0),completedExplorations=999) }
        assertTrue(market.market(buyer.hash).listings.isEmpty())
        assertEquals("ECONOMY_MARKET_LOCKED",assertFailsWith<AuthFailure> {
            market.command(buyer.hash,command(buyer,"buy_listing",restoredLot.id,restoredLot.quantity,restoredLot.totalPrice)) }.code)
        assertEquals("active",scalar(source,"SELECT status FROM economy_market_listings WHERE id=?",UUID.fromString(restoredLot.id)))
    }

    @Test fun `unopened gifted goods are hidden and forced buy or listing commands fail`() = runBlocking<Unit> {
        val seller=player(); val buyer=player()
        edit(seller.id) { it.copy(inventory=mapOf("beams" to 1),unlockedItems=it.unlockedItems+"beams") }
        edit(buyer.id) { it.copy(inventory=mapOf("beams" to 1),unlockedItems=emptyList()) }
        assertFalse("beams" in economy.snapshot(buyer.hash).unlockedItems)
        market.command(seller.hash,command(seller,"create_listing","beams",price=650))
        val lot=market.market(seller.hash).mine.single()
        assertTrue(market.market(buyer.hash).listings.isEmpty())
        assertEquals("ECONOMY_MARKET_ITEM_LOCKED",assertFailsWith<AuthFailure> {
            market.command(buyer.hash,command(buyer,"create_listing","beams",price=650)) }.code)
        execute(source,"UPDATE economy_market_showcases SET listing_ids=ARRAY[?::uuid] WHERE user_id=?",
            UUID.fromString(lot.id),buyer.id)
        assertEquals("ECONOMY_MARKET_ITEM_LOCKED",assertFailsWith<AuthFailure> {
            market.command(buyer.hash,command(buyer,"buy_listing",lot.id,lot.quantity,lot.totalPrice)) }.code)
        assertEquals("active",scalar(source,"SELECT status FROM economy_market_listings WHERE id=?",UUID.fromString(lot.id)))
        assertEquals(10000L,economy.snapshot(buyer.hash).wallet.coins)
    }

    @Test fun `legacy item projection uses committed history without mutating a profile on GET`() = runBlocking<Unit> {
        val p=player()
        edit(p.id) { it.copy(itemUnlockVersion=0,unlockedItems=emptyList(),inventory=emptyMap()) }
        execute(source,"""INSERT INTO economy_ledger(user_id,source_key,kind,coins,items)
            VALUES (?,'legacy-known-beam','claim_job',0,'{"beams":1,"not_a_good":1}')""",p.id)
        val before=scalar(source,"SELECT state::text || ':' || revision FROM economy_profiles WHERE user_id=?",p.id)
        val view=economy.snapshot(p.hash)
        assertTrue("beams" in view.unlockedItems)
        assertFalse("not_a_good" in view.unlockedItems)
        market.market(p.hash)
        assertEquals(before,scalar(source,"SELECT state::text || ':' || revision FROM economy_profiles WHERE user_id=?",p.id))
        source.connection.use { c ->
            val sealed=readEconomyProfile(c,p.id).state
            assertEquals(1,sealed.itemUnlockVersion)
            saveEconomyProfile(c,p.id,sealed.copy(inventory=mapOf("tools" to 1)),recordAwards=false)
            c.commit()
        }
        val after=economy.snapshot(p.hash)
        assertTrue("beams" in after.unlockedItems)
        assertFalse("tools" in after.unlockedItems,"A later gift cannot enter the legacy knowledge seed")
    }

    @Test fun `V55 fences existing profiles preserves paid state and normalizes historical fish without reading jobs`() = runBlocking<Unit> {
        val database="unlock_migration_${UUID.randomUUID().toString().replace("-","")}"
        source.connection.use { c -> c.autoCommit=true; c.createStatement().use { it.executeUpdate("CREATE DATABASE $database") } }
        try {
            DatabaseFactory.create(config(database)).use { db ->
                Flyway.configure().dataSource(db).locations("classpath:db/migration").target("54").load().migrate()
                val hash=tokens.issue().hash
                val user=JdbcZhivRepository(db).bootstrap("До V55",tokens.issue().hash,hash,365)
                val old=EconomyRules.initial(0,0,0,3,0).copy(inventory=mapOf("metal_parts" to 1),
                    jobs=listOf(EconomyJob(id=UUID.randomUUID().toString(),kind="exploration",targetId="shore",
                        startedAt="2026-10-14T00:00:00Z",finishesAt="2026-10-14T00:03:00Z",
                        rewards=mapOf("fish_legendary" to 1),catalogVersion=7)))
                execute(db,"""INSERT INTO economy_profiles(user_id,revision,state) VALUES (?,17,
                    ?::jsonb-'marketSlots'-'unlockedItems'-'itemUnlockVersion')""",user.id,economyJson.encodeToString(old))
                execute(db,"""INSERT INTO economy_ledger(user_id,source_key,kind,coins,items)
                    VALUES (?,'paid-history','claim_job',0,'{"beams":1,"fish_pike":1,"not_a_good":1}')""",user.id)
                val before=scalar(db,"SELECT state::text FROM economy_profiles WHERE user_id=?",user.id)
                DatabaseFactory.migrate(db)
                assertEquals("18",scalar(db,"SELECT revision FROM economy_profiles WHERE user_id=?",user.id))
                assertEquals(before,scalar(db,"SELECT (state-'marketSlots'-'unlockedItems'-'itemUnlockVersion')::text FROM economy_profiles WHERE user_id=?",user.id))
                val migrated=db.connection.use { readEconomyProfile(it,user.id).state }
                assertEquals(5,migrated.marketSlots); assertEquals(1,migrated.itemUnlockVersion)
                assertTrue(migrated.unlockedItems.containsAll(listOf("beams","metal_parts","fish_rare")))
                assertFalse("not_a_good" in migrated.unlockedItems)
                assertFalse("fish_legendary" in migrated.unlockedItems)
                assertEquals("1",scalar(db,"SELECT count(*) FROM economy_ledger WHERE user_id=? AND source_key='paid-history'",user.id))
                DatabaseFactory.migrate(db)
                assertEquals("18",scalar(db,"SELECT revision FROM economy_profiles WHERE user_id=?",user.id))
                assertEquals("1:5:[]",scalar(db,"""SELECT s->>'itemUnlockVersion' || ':' ||
                    (s->>'marketSlots') || ':' || (s->'unlockedItems')::text
                    FROM (SELECT economy_v4_initial_state('{}'::jsonb,true) s) initial"""))
            }
        } finally { source.connection.use { c ->
            c.autoCommit=true; c.createStatement().use { it.executeUpdate("DROP DATABASE $database") }
        } }
    }
}
