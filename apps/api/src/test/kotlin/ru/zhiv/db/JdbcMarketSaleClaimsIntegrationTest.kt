package ru.zhiv.db

import com.zaxxer.hikari.HikariDataSource
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
import ru.zhiv.auth.*
import ru.zhiv.config.AppConfig
import ru.zhiv.economy.*
import ru.zhiv.security.TokenCodec
import java.time.Instant
import java.util.UUID
import javax.sql.DataSource
import kotlin.test.*

/** Exercises committed market transfers, durable unclaimed proceeds and lifecycle boundaries. */
@Testcontainers(disabledWithoutDocker = true)
@TestInstance(TestInstance.Lifecycle.PER_CLASS)
class JdbcMarketSaleClaimsIntegrationTest {
    private class Postgres(image: String) : PostgreSQLContainer<Postgres>(image)
    companion object { @Container private val postgres = Postgres("postgres:18-alpine") }
    private lateinit var source: HikariDataSource
    private lateinit var economy: JdbcEconomyRepository
    private lateinit var market: JdbcEconomyMarketRepository
    private lateinit var auth: JdbcAuthRepository
    private val tokens = TokenCodec()
    private data class Player(val id: UUID, val publicId: String, val hash: ByteArray, val subject: String)

    private fun config(database: String? = null) = AppConfig(
        database?.let { "jdbc:postgresql://${postgres.host}:${postgres.getMappedPort(5432)}/$it" } ?: postgres.jdbcUrl,
        postgres.username, postgres.password, false, setOf("http://localhost"))

    @BeforeAll fun setup() {
        source = DatabaseFactory.create(config())
        DatabaseFactory.migrate(source)
        economy = JdbcEconomyRepository(source)
        market = JdbcEconomyMarketRepository(source)
        auth = JdbcAuthRepository(source)
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
    private suspend fun player(name: String = "Лавочник", coins: Long = 1000, berries: Long = 20): Player {
        val token = tokens.issue()
        val user = JdbcZhivRepository(source).bootstrap(name, tokens.issue().hash, token.hash, 365)
        val subject = UUID.randomUUID().toString()
        execute(source, "INSERT INTO account_login_identities(provider,subject,user_id) VALUES ('vk',?,?)", subject, user.id)
        economy.snapshot(token.hash)
        edit(user.id) { it.copy(wallet=it.wallet.copy(coins=coins), inventory=mapOf("berries" to berries),
            buildings=it.buildings + mapOf("home" to 2, "bridge" to 1), completedExplorations=1) }
        return Player(user.id, user.publicId, token.hash, subject)
    }
    private fun edit(user: UUID, change: (EconomyState) -> EconomyState) = source.connection.use { c ->
        val state = change(readEconomyProfile(c, user).state)
        c.economyUpdate("UPDATE economy_profiles SET state=?::jsonb WHERE user_id=?", economyJson.encodeToString(state), user)
        c.commit()
    }
    private suspend fun command(p: Player, action: String, target: String, quantity: Long=1, price: Long=0) =
        EconomyCommand(UUID.randomUUID().toString(), p.publicId, economy.snapshot(p.hash).revision, action, target, quantity, price)
    private suspend fun offer(p: Player, item: String="berries", quantity: Long=2, price: Long=20): EconomyMarketListing {
        val prior = market.market(p.hash).mine.map { it.id }.toSet()
        market.command(p.hash, command(p,"create_listing",item,quantity,price))
        return market.market(p.hash).mine.single { it.id !in prior }
    }
    private suspend fun purchase(p: Player, lot: EconomyMarketListing): EconomyCommand {
        market.market(p.hash)
        return command(p,"buy_listing",lot.id,lot.quantity,lot.totalPrice)
    }
    private suspend fun prove(current: Player, browser: ByteArray, action: String, role: String="current", owner: Player=current) {
        val flow=LoginFlow(tokens.issue().hash,browser,"vk","account",current.hash,null,null,"pkce",null,null,action,role)
        auth.create(flow)
        auth.recordAccountProof(auth.takeVk(flow.tokenHash,browser),owner.subject)
    }

    @Test fun `purchase delivers goods immediately but exposes real buyer and fixed net proceeds only to seller until collection`() = runBlocking<Unit> {
        val seller=player(); val buyer=player("Natasha",berries=0); val stranger=player(berries=0)
        execute(source,"UPDATE app_users SET avatar_storage_key='private/never-public',avatar_updated_at=clock_timestamp(),updated_at=clock_timestamp() WHERE id=?",buyer.id)
        val lot=offer(seller)
        assertNull(market.market(buyer.hash).listings.single().sale)
        val buy=purchase(buyer,lot)
        val buyerBefore=economy.snapshot(buyer.hash)
        val sellerBefore=economy.snapshot(seller.hash)
        val bought=market.command(buyer.hash,buy)
        assertEquals(buyerBefore.wallet.coins-lot.totalPrice,bought.state.wallet.coins)
        assertEquals(2L,bought.state.inventory["berries"])
        assertEquals(sellerBefore.wallet,economy.snapshot(seller.hash).wallet)
        val pending=market.market(seller.hash).mine.single()
        assertEquals("sold",pending.status)
        val sale=assertNotNull(pending.sale)
        assertEquals(buyer.publicId,sale.buyerPublicId)
        assertEquals("Natasha",sale.buyerName)
        assertNull(sale.buyerAvatarUrl,"The current public profile API does not expose stored avatar keys")
        assertNull(sale.claimedAt)
        assertEquals(19L,sale.proceedsCoins)
        assertFalse(economyJson.encodeToString(pending).contains("private/never-public"))
        assertFalse(economyJson.encodeToString(pending).contains(buyer.id.toString()))
        assertTrue(market.market(stranger.hash).listings.none { it.id==lot.id })
        assertTrue(market.market(buyer.hash).mine.isEmpty())
        assertEquals(20L,market.market(seller.hash).tradeBudget?.salesUsed)
        assertEquals(0L,economy.snapshot(seller.hash).storage.reserved)
        assertEquals("0",scalar(source,"SELECT count(*) FROM economy_ledger WHERE user_id=? AND kind='market_claim' AND coins<>0",seller.id))
        execute(source,"UPDATE app_users SET display_name='Новое имя',updated_at=clock_timestamp() WHERE id=?",buyer.id)
        execute(source,"UPDATE economy_market_listings SET seller_fee_bps=0 WHERE id=?",UUID.fromString(lot.id))
        assertEquals("Natasha",market.market(seller.hash).mine.single().sale?.buyerName,"Purchase keeps the public identity at the time of sale")
        val claim=command(seller,"claim_sale",lot.id)
        val collected=market.command(seller.hash,claim)
        assertEquals(sellerBefore.wallet.coins+19L,collected.state.wallet.coins,"Stored net proceeds cannot be requoted at collection")
        assertEquals(20L,market.market(seller.hash).tradeBudget?.salesUsed,"Collection is not a second sale")
        assertTrue(market.market(seller.hash).mine.isEmpty())
        assertTrue(market.command(buyer.hash,buy).replayed)
        assertEquals(collected.state.wallet,economy.snapshot(seller.hash).wallet)
    }

    @Test fun `only seller can collect and an uncertain response replays without accepting a changed request`() = runBlocking<Unit> {
        val seller=player(); val buyer=player(berries=0); val lot=offer(seller)
        market.command(buyer.hash,purchase(buyer,lot))
        val foreign=assertFailsWith<AuthFailure> { market.command(buyer.hash,command(buyer,"claim_sale",lot.id)) }
        assertEquals("ECONOMY_MARKET_OWNER",foreign.code); assertEquals(403,foreign.status)
        val claim=command(seller,"claim_sale",lot.id)
        val first=market.command(seller.hash,claim)
        assertEquals(1019L,first.state.wallet.coins)
        val replay=market.command(seller.hash,claim)
        assertTrue(replay.replayed); assertEquals(first.acceptedRevision,replay.acceptedRevision)
        assertEquals(first.state.wallet,replay.state.wallet)
        assertEquals("ECONOMY_REQUEST_CONFLICT",assertFailsWith<AuthFailure> {
            market.command(seller.hash,claim.copy(targetId=UUID.randomUUID().toString())) }.code)
        val repeated=assertFailsWith<AuthFailure> { market.command(seller.hash,command(seller,"claim_sale",lot.id)) }
        assertEquals("ECONOMY_MARKET_NOT_PENDING",repeated.code); assertEquals(409,repeated.status)
        assertEquals("1",scalar(source,"SELECT count(*) FROM economy_market_receipts WHERE user_id=? AND request_id=?",seller.id,UUID.fromString(claim.requestId)))
        assertEquals(1019L,economy.snapshot(seller.hash).wallet.coins)
    }

    @Test fun `two devices collecting the same sale race on one committed credit`() = runBlocking<Unit> {
        val seller=player(); val buyer=player(berries=0); val lot=offer(seller)
        market.command(buyer.hash,purchase(buyer,lot))
        val claim=command(seller,"claim_sale",lot.id)
        val otherSession=tokens.issue().hash
        execute(source,"INSERT INTO app_sessions(user_id,token_hash,expires_at) VALUES (?,?,clock_timestamp()+interval '1 year')",seller.id,otherSession)
        val results=coroutineScope { listOf(seller.hash,otherSession).map { hash ->
            async(Dispatchers.IO) { market.command(hash,claim) }
        }.awaitAll() }
        assertEquals(1,results.count { it.replayed })
        assertEquals(1019L,economy.snapshot(seller.hash).wallet.coins)
        assertTrue(market.market(seller.hash).mine.isEmpty())
        assertEquals("1",scalar(source,"SELECT count(*) FROM economy_market_receipts WHERE user_id=? AND request_id=?",seller.id,UUID.fromString(claim.requestId)))
    }

    @Test fun `distinct competing claims cannot credit twice and the loser can observe the collected sale`() = runBlocking<Unit> {
        val seller=player(); val buyer=player(berries=0); val lot=offer(seller)
        market.command(buyer.hash,purchase(buyer,lot))
        val requests=listOf(command(seller,"claim_sale",lot.id),command(seller,"claim_sale",lot.id))
        val results=coroutineScope { requests.map { request -> async(Dispatchers.IO) {
            runCatching { market.command(seller.hash,request) }
        } }.awaitAll() }
        assertEquals(1,results.count { it.isSuccess })
        assertEquals("ECONOMY_REVISION_CONFLICT",(results.single { it.isFailure }.exceptionOrNull() as AuthFailure).code)
        val retry=requests[results.indexOfFirst { it.isFailure }].copy(expectedRevision=economy.snapshot(seller.hash).revision)
        assertEquals("ECONOMY_MARKET_NOT_PENDING",assertFailsWith<AuthFailure> { market.command(seller.hash,retry) }.code)
        assertEquals(1019L,economy.snapshot(seller.hash).wallet.coins)
    }

    @Test fun `sold uncollected lots occupy places until collected and remain collectible after market is locked`() = runBlocking<Unit> {
        val seller=player(); val buyer=player(berries=0)
        repeat(5) { offer(seller,quantity=1,price=10) }
        repeat(5) {
            execute(source,"DELETE FROM economy_market_showcases WHERE user_id=?",buyer.id)
            val lot=market.market(buyer.hash).listings.first()
            market.command(buyer.hash,purchase(buyer,lot))
        }
        val pending=market.market(seller.hash).mine
        assertEquals(5,pending.size); assertTrue(pending.all { it.status=="sold" && it.sale?.claimedAt==null })
        assertEquals(1000L,economy.snapshot(seller.hash).wallet.coins)
        assertEquals("ECONOMY_MARKET_LIMIT",assertFailsWith<AuthFailure> { offer(seller,quantity=1,price=10) }.code)
        assertEquals(15L,economy.snapshot(seller.hash).inventory["berries"])
        edit(seller.id) { it.copy(buildings=it.buildings+mapOf("home" to 1,"bridge" to 0),completedExplorations=0) }
        assertEquals(5,market.market(seller.hash).mine.size)
        market.command(seller.hash,command(seller,"claim_sale",pending.first().id))
        assertEquals(1009L,economy.snapshot(seller.hash).wallet.coins)
        assertEquals(4,market.market(seller.hash).mine.size)
        edit(seller.id) { it.copy(buildings=it.buildings+mapOf("home" to 2,"bridge" to 1),completedExplorations=1) }
        offer(seller,quantity=1,price=10)
        assertEquals(5,market.market(seller.hash).mine.size)
    }

    @Test fun `full seller wallet delays collection without blocking purchase or consuming a receipt`() = runBlocking<Unit> {
        val seller=player(coins=ECONOMY_MAX_BALANCE); val buyer=player(berries=0); val lot=offer(seller)
        market.command(buyer.hash,purchase(buyer,lot))
        assertEquals(2L,economy.snapshot(buyer.hash).inventory["berries"])
        assertEquals(ECONOMY_MAX_BALANCE,economy.snapshot(seller.hash).wallet.coins)
        val claim=command(seller,"claim_sale",lot.id)
        val error=assertFailsWith<AuthFailure> { market.command(seller.hash,claim) }
        assertEquals("ECONOMY_CAPACITY",error.code); assertEquals(409,error.status)
        assertNull(market.market(seller.hash).mine.single().sale?.claimedAt)
        assertEquals("0",scalar(source,"SELECT count(*) FROM economy_market_receipts WHERE user_id=? AND request_id=?",seller.id,UUID.fromString(claim.requestId)))
        edit(seller.id) { it.copy(wallet=it.wallet.copy(coins=ECONOMY_MAX_BALANCE-19)) }
        assertEquals(ECONOMY_MAX_BALANCE,market.command(seller.hash,claim).state.wallet.coins)
        assertTrue(market.command(seller.hash,claim).replayed)
    }

    @Test fun `fish purchase releases exact escrow before seller collects any proceeds`() = runBlocking<Unit> {
        val seller=player(berries=0); val buyer=player(berries=0)
        val species=checkNotNull(EconomyRules.catalog.fishing).fish.first { it.rarity=="common" }.itemId
        edit(seller.id) { it.copy(inventory=mapOf("fish_common" to 2L),fishing=it.fishing.copy(stock=mapOf(species to 2L))) }
        val lot=offer(seller,"fish_common",2,80)
        market.command(buyer.hash,purchase(buyer,lot))
        val sold=economy.snapshot(seller.hash)
        assertTrue(sold.fishing.stock.orEmpty().isEmpty()); assertTrue(sold.fishing.escrow.orEmpty().isEmpty())
        assertEquals(1000L,sold.wallet.coins)
        val bought=economy.snapshot(buyer.hash)
        assertEquals(mapOf("fish_common" to 2L),bought.inventory)
        assertEquals(mapOf(species to 2L),bought.fishing.stock)
        assertTrue(bought.fishing.catches.isEmpty())
        market.command(seller.hash,command(seller,"claim_sale",lot.id))
        assertEquals(1076L,economy.snapshot(seller.hash).wallet.coins)
    }

    @Test fun `economy profile reset preserves pending proceeds and the original daily sales fence`() = runBlocking<Unit> {
        val seller=player(); val buyer=player(berries=0); val lot=offer(seller)
        market.command(buyer.hash,purchase(buyer,lot))
        source.connection.use { c ->
            c.economyRows("SELECT id FROM app_users WHERE id=? FOR NO KEY UPDATE",seller.id) { true }
            removeEconomyProfile(c,seller.id)
            ensureEconomyProfile(c,seller.id)
            assertEquals(20L,readEconomyTradeUsage(c,seller.id,Instant.now()).sales)
            c.commit()
        }
        val initial=economy.snapshot(seller.hash)
        assertEquals(1,initial.buildings["home"])
        assertEquals(lot.id,market.market(seller.hash).mine.single().id)
        val claimed=market.command(seller.hash,command(seller,"claim_sale",lot.id))
        assertEquals(initial.wallet.coins+19L,claimed.state.wallet.coins)
        assertTrue(market.market(seller.hash).mine.isEmpty())
    }

    @Test fun `real account merge transfers uncollected proceeds to surviving owner without repaying the old seller`() = runBlocking<Unit> {
        val survivor=player(berries=0); val seller=player(); val lot=offer(seller)
        market.command(survivor.hash,purchase(survivor,lot))
        val browser=tokens.issue().hash
        prove(survivor,browser,"merge"); prove(survivor,browser,"merge","other",seller)
        val key=tokens.issue().hash
        assertTrue(auth.previewMerge(survivor.hash,browser,MergeChoices(providerChoices=mapOf("vk" to "current")),key).conflicts.isEmpty())
        auth.confirmMerge(survivor.hash,browser,key)
        val merged=economy.snapshot(survivor.hash)
        assertEquals(1980L,merged.wallet.coins)
        val pending=market.market(survivor.hash).mine.single()
        assertEquals(lot.id,pending.id); assertTrue(pending.owned)
        assertEquals(survivor.publicId,pending.sale?.buyerPublicId)
        assertEquals(1999L,market.command(survivor.hash,command(survivor,"claim_sale",lot.id)).state.wallet.coins)
        assertEquals("UNAUTHORIZED",assertFailsWith<AuthFailure> { market.market(seller.hash) }.code)
        auth.confirmMerge(survivor.hash,browser,key)
        assertEquals(1999L,economy.snapshot(survivor.hash).wallet.coins)
    }

    @Test fun `merge review refuses more pending payouts than the public bounded list can safely preserve`() = runBlocking<Unit> {
        val a=player(); val b=player(); val buyer=player(berries=0)
        for ((seller,count) in listOf(a to 6,b to 5)) {
            edit(seller.id) { it.copy(marketSlots=10) }
            repeat(count) { offer(seller,quantity=1,price=10) }
            repeat(count) {
                execute(source,"DELETE FROM economy_market_showcases WHERE user_id=?",buyer.id)
                val lot=market.market(buyer.hash).listings.first { it.sellerPublicId==seller.publicId }
                market.command(buyer.hash,purchase(buyer,lot))
            }
        }
        val browser=tokens.issue().hash
        prove(a,browser,"merge"); prove(a,browser,"merge","other",b)
        val preview=auth.previewMerge(a.hash,browser,MergeChoices(providerChoices=mapOf("vk" to "current")),tokens.issue().hash)
        assertTrue(preview.conflicts.isNotEmpty(),"Eleven payable rows must not be hidden behind a ten-row response")
        assertEquals(6,market.market(a.hash).mine.size)
        assertEquals(5,market.market(b.hash).mine.size)
        assertEquals(1000L,economy.snapshot(a.hash).wallet.coins)
        assertEquals(1000L,economy.snapshot(b.hash).wallet.coins)
    }

    @Test fun `buyer account deletion anonymizes the durable sale without erasing the seller payment`() = runBlocking<Unit> {
        val seller=player(); val buyer=player("Natasha",berries=0); val lot=offer(seller)
        market.command(buyer.hash,purchase(buyer,lot))
        val browser=tokens.issue().hash
        prove(buyer,browser,"delete")
        auth.deleteAccount(buyer.hash,browser,tokens.issue().hash)
        val pending=market.market(seller.hash).mine.single()
        val sale=assertNotNull(pending.sale)
        assertNull(sale.buyerPublicId); assertNull(sale.buyerAvatarUrl)
        assertFalse(sale.buyerName.contains("Natasha"))
        assertFalse(economyJson.encodeToString(pending).contains(buyer.publicId))
        assertEquals(19L,sale.proceedsCoins)
        assertEquals(1019L,market.command(seller.hash,command(seller,"claim_sale",lot.id)).state.wallet.coins)
    }

    @Test fun `V63 marks both old currency scales already paid without changing wallets or recrediting sold lots`() = runBlocking<Unit> {
        val database="sale_migration_${UUID.randomUUID().toString().replace("-","")}"
        source.connection.use { c -> c.autoCommit=true; c.economyUpdate("CREATE DATABASE $database") }
        try {
            DatabaseFactory.create(config(database)).use { db ->
                Flyway.configure().dataSource(db).locations("classpath:db/migration").target("62").load().migrate()
                val token=tokens.issue(); val buyerToken=tokens.issue()
                val identities=JdbcZhivRepository(db)
                val seller=identities.bootstrap("До V63",tokens.issue().hash,token.hash,365)
                val buyer=identities.bootstrap("Покупатель",tokens.issue().hash,buyerToken.hash,365)
                val old=EconomyRules.initial(homeLevel=2).copy(wallet=EconomyWallet(1230,450),inventory=emptyMap(),
                    buildings=EconomyRules.initial(homeLevel=2).buildings+("bridge" to 1),completedExplorations=1)
                execute(db,"INSERT INTO economy_profiles(user_id,revision,state) VALUES (?,17,?::jsonb)",seller.id,economyJson.encodeToString(old))
                val ids=listOf(UUID.randomUUID(),UUID.randomUUID())
                for ((id,scale) in ids.zip(listOf(1,10))) execute(db,"""INSERT INTO economy_market_listings
                    (id,seller_id,buyer_id,item_id,quantity,total_price,currency_scale,status,closed_at,seller_fee_bps)
                    VALUES (?,?,?,'berries',2,?,?,'sold',clock_timestamp(),500)""",id,seller.id,buyer.id,if(scale==1) 2L else 20L,scale)
                val before=scalar(db,"SELECT state::text || ':' || revision FROM economy_profiles WHERE user_id=?",seller.id)
                DatabaseFactory.migrate(db)
                assertEquals(before,scalar(db,"SELECT state::text || ':' || revision FROM economy_profiles WHERE user_id=?",seller.id))
                val migrated=JdbcEconomyRepository(db); val migratedMarket=JdbcEconomyMarketRepository(db)
                assertEquals(1230L,migrated.snapshot(token.hash).wallet.coins)
                assertTrue(migratedMarket.market(token.hash).mine.isEmpty(),"Historical sales were paid before V63")
                for (id in ids) {
                    val view=migrated.snapshot(token.hash)
                    val claim=EconomyCommand(UUID.randomUUID().toString(),seller.publicId,view.revision,"claim_sale",id.toString(),1,0)
                    assertEquals("ECONOMY_MARKET_NOT_PENDING",assertFailsWith<AuthFailure> { migratedMarket.command(token.hash,claim) }.code)
                }
                // Ordinary snapshots may pin item knowledge, initialize the fishing
                // shop and sort wardrobe data. Repeated migration preserves the state
                // committed by those reads, separately from the initial V63 upgrade.
                val afterReads=scalar(db,"SELECT state::text || ':' || revision FROM economy_profiles WHERE user_id=?",seller.id)
                DatabaseFactory.migrate(db)
                assertEquals(afterReads,scalar(db,"SELECT state::text || ':' || revision FROM economy_profiles WHERE user_id=?",seller.id))
                assertEquals("2",scalar(db,"SELECT count(*) FROM economy_market_listings WHERE sale_claimed_at IS NOT NULL"))
            }
        } finally { source.connection.use { c -> c.autoCommit=true; c.economyUpdate("DROP DATABASE $database") } }
    }
}
