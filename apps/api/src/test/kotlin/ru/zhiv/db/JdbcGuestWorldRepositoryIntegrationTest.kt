package ru.zhiv.db

import com.zaxxer.hikari.HikariDataSource
import io.ktor.client.request.*
import io.ktor.client.statement.bodyAsText
import io.ktor.http.*
import io.ktor.server.testing.testApplication
import kotlinx.coroutines.*
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.*
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
import ru.zhiv.installZhivApi
import ru.zhiv.relationships.*
import ru.zhiv.security.TokenCodec
import ru.zhiv.world.WorldEquipment
import ru.zhiv.world.WorldState
import ru.zhiv.world.worldJson
import java.util.UUID
import kotlin.test.*

@Testcontainers(disabledWithoutDocker = true)
@TestInstance(TestInstance.Lifecycle.PER_CLASS)
class JdbcGuestWorldRepositoryIntegrationTest {
    private class Postgres(image: String) : PostgreSQLContainer<Postgres>(image)
    companion object { @Container private val postgres = Postgres("postgres:18-alpine") }
    private lateinit var source: HikariDataSource
    private lateinit var config: AppConfig
    private lateinit var identities: JdbcZhivRepository
    private lateinit var relationships: JdbcRelationshipRepository
    private lateinit var economy: JdbcEconomyRepository
    private lateinit var market: JdbcEconomyMarketRepository
    private lateinit var worlds: JdbcGuestWorldRepository
    private val tokens = TokenCodec()
    private data class Player(val id: UUID, val publicId: String, val hash: ByteArray, val raw: String)

    @BeforeAll fun setup() {
        config=AppConfig(postgres.jdbcUrl,postgres.username,postgres.password,false,setOf("http://localhost"))
        source=DatabaseFactory.create(config);DatabaseFactory.migrate(source)
        identities=JdbcZhivRepository(source);relationships=JdbcRelationshipRepository(source)
        economy=JdbcEconomyRepository(source);market=JdbcEconomyMarketRepository(source);worlds=JdbcGuestWorldRepository(source)
    }
    @AfterAll fun close() { source.close() }
    private fun execute(sql: String,vararg values: Any?) = source.connection.use { c -> c.economyUpdate(sql,*values).also { c.commit() } }
    private fun scalar(sql: String,vararg values: Any?): Long = source.connection.use { c -> c.economyRows(sql,*values){it.getLong(1)}.single() }
    private suspend fun player(startGame: Boolean = true): Player {
        val token=tokens.issue();val user=identities.bootstrap("Лесник",tokens.issue().hash,token.hash,365)
        val player=Player(user.id,user.publicId,token.hash,token.raw)
        if (startGame) {
            economy.snapshot(player.hash)
            edit(player) { it.copy(wallet=it.wallet.copy(coins=1000),inventory=mapOf("berries" to 20L),
                buildings=it.buildings + mapOf("home" to 2,"bridge" to 1)) }
        }
        return player
    }
    private fun edit(player: Player,change: (EconomyState)->EconomyState) = source.connection.use { c ->
        val state=readEconomyProfile(c,player.id).state
        c.economyUpdate("UPDATE economy_profiles SET state=?::jsonb WHERE user_id=?",economyJson.encodeToString(change(state)),player.id)
        c.commit()
    }
    private fun <T> ok(value: RelationshipResult<T>): T = assertIs<RelationshipResult.Success<T>>(value).value
    private suspend fun connect(a: Player,b: Player): UUID {
        val request=ok(relationships.sendRequest(a.hash,b.publicId,UUID.randomUUID())).request
        return ok(relationships.actOnRequest(b.hash,request.requestId,RequestAction.ACCEPTED)).person!!.circleId
    }
    private suspend fun command(player: Player,action: String,target: String,quantity: Long = 1,price: Long = 0) =
        EconomyCommand(UUID.randomUUID().toString(),player.publicId,economy.snapshot(player.hash).revision,action,target,quantity,price)
    private suspend fun offer(seller: Player): EconomyMarketListing {
        val before=market.market(seller.hash).mine.map { it.id }.toSet()
        market.command(seller.hash,command(seller,"create_listing","berries",2,20))
        return market.market(seller.hash).mine.single { it.id !in before }
    }
    private suspend fun buy(buyer: Player,lot: EconomyMarketListing) = command(buyer,"buy_listing",lot.id,lot.quantity,lot.totalPrice)

    @Test fun `visiting untouched legacy and new worlds does not initialize or mutate either account`() = runBlocking<Unit> {
        val viewer=player(false);val friend=player(false);val circle=connect(viewer,friend)
        execute("INSERT INTO world_profiles(user_id,state) VALUES (?,?::jsonb)",friend.id,
            worldJson.encodeToString(WorldState(houseLevel=4,workshop=true,workshopLevel=2,equipment=WorldEquipment(head="rain_hood"))))
        val before=scalar("SELECT count(*) FROM economy_profiles WHERE user_id IN (?,?)",viewer.id,friend.id)
        val world=worlds.world(viewer.hash,circle)
        assertEquals(viewer.publicId,world.ownerPublicId);assertEquals(friend.publicId,world.user.publicId)
        assertEquals(4,world.world.buildings["home"]);assertEquals(2,world.world.buildings["workshop"])
        assertEquals("rain_hood",world.world.equipment.head);assertEquals("buyer_locked",world.market.reason)
        assertEquals(before,scalar("SELECT count(*) FROM economy_profiles WHERE user_id IN (?,?)",viewer.id,friend.id))
        assertEquals(0L,scalar("SELECT count(*) FROM economy_market_showcases WHERE user_id IN (?,?)",viewer.id,friend.id))
        assertEquals(0L,scalar("SELECT count(*) FROM economy_ledger WHERE user_id IN (?,?)",viewer.id,friend.id))
    }

    @Test fun `personal storefront transfers real items coins fee and daily volume without the random showcase`() = runBlocking<Unit> {
        val buyer=player();val seller=player();val circle=connect(buyer,seller);val lot=offer(seller)
        val snapshot=worlds.world(buyer.hash,circle)
        assertTrue(snapshot.market.available);assertNull(snapshot.market.reason)
        assertEquals(listOf(lot.id),snapshot.market.listings.map { it.id })
        assertEquals(0L,scalar("SELECT count(*) FROM economy_market_showcases WHERE user_id=?",buyer.id))
        val purchase=buy(buyer,lot);val result=worlds.purchase(buyer.hash,circle,purchase)
        assertEquals(980L,result.state.wallet.coins);assertEquals(22L,result.state.inventory["berries"])
        val sold=economy.snapshot(seller.hash)
        assertEquals(1000L,sold.wallet.coins);assertEquals(18L,sold.inventory["berries"])
        assertEquals(buyer.publicId,market.market(seller.hash).mine.single().sale?.buyerPublicId)
        assertEquals(19L,market.market(seller.hash).mine.single().sale?.proceedsCoins)
        assertTrue(worlds.world(buyer.hash,circle).market.listings.isEmpty())
        assertEquals(20L,scalar("SELECT buys_value FROM economy_market_daily_turnover WHERE user_id=?",buyer.id))
        assertEquals(20L,scalar("SELECT sales_value FROM economy_market_daily_turnover WHERE user_id=?",seller.id))
        val replay=worlds.purchase(buyer.hash,circle,purchase)
        assertTrue(replay.replayed);assertEquals(result.state.revision,replay.state.revision)
        assertEquals(980L,replay.state.wallet.coins);assertEquals(1000L,economy.snapshot(seller.hash).wallet.coins)
    }

    @Test fun `friend seller binding applies before replay and a stranger cannot spend the buyer balance`() = runBlocking<Unit> {
        val buyer=player();val seller=player();val other=player();val stranger=player()
        val circle=connect(buyer,seller);val otherCircle=connect(buyer,other);val lot=offer(seller)
        val purchase=buy(buyer,lot)
        assertEquals("GUEST_WORLD_UNAVAILABLE",assertFailsWith<AuthFailure>{worlds.purchase(buyer.hash,otherCircle,purchase)}.code)
        assertEquals("GUEST_WORLD_UNAVAILABLE",assertFailsWith<AuthFailure>{worlds.world(stranger.hash,circle)}.code)
        assertEquals("GUEST_WORLD_UNAVAILABLE",assertFailsWith<AuthFailure>{worlds.purchase(stranger.hash,circle,purchase.copy(ownerPublicId=stranger.publicId))}.code)
        worlds.purchase(buyer.hash,circle,purchase)
        assertEquals("GUEST_WORLD_UNAVAILABLE",assertFailsWith<AuthFailure>{worlds.purchase(buyer.hash,otherCircle,purchase)}.code)
        assertEquals("INVALID_ECONOMY_COMMAND",assertFailsWith<AuthFailure>{worlds.purchase(buyer.hash,circle,purchase.copy(action="cancel_listing",quantity=1,totalPrice=0))}.code)
    }

    @Test fun `removal sharing off and revoked session close both visits and purchases`() = runBlocking<Unit> {
        val buyer=player();val seller=player();val circle=connect(buyer,seller);val lot=offer(seller);val purchase=buy(buyer,lot)
        worlds.world(buyer.hash,circle)
        ok(relationships.updateSharing(seller.hash,circle,SharingMode.OFF))
        assertEquals("GUEST_WORLD_UNAVAILABLE",assertFailsWith<AuthFailure>{worlds.world(buyer.hash,circle)}.code)
        assertEquals("GUEST_WORLD_UNAVAILABLE",assertFailsWith<AuthFailure>{worlds.purchase(buyer.hash,circle,purchase)}.code)
        assertEquals(1000L,economy.snapshot(buyer.hash).wallet.coins)
        ok(relationships.updateSharing(seller.hash,circle,SharingMode.LATEST_ONLY))
        worlds.purchase(buyer.hash,circle,purchase)
        ok(relationships.removePerson(buyer.hash,circle))
        assertEquals("GUEST_WORLD_UNAVAILABLE",assertFailsWith<AuthFailure>{worlds.purchase(buyer.hash,circle,purchase)}.code)
        execute("UPDATE app_sessions SET revoked_at=clock_timestamp() WHERE token_hash=?",buyer.hash)
        assertEquals("UNAUTHORIZED",assertFailsWith<AuthFailure>{worlds.world(buyer.hash,circle)}.code)
    }

    @Test fun `personal purchases across home levels retain warehouse and daily trade limits`() = runBlocking<Unit> {
        val buyer=player();val seller=player();val circle=connect(buyer,seller);val lot=offer(seller)
        edit(seller){it.copy(buildings=it.buildings + ("home" to 4))}
        val storefront=worlds.world(buyer.hash,circle).market
        assertTrue(storefront.available);assertNull(storefront.reason)
        assertEquals(listOf(lot.id),storefront.listings.map { it.id })
        edit(buyer){it.copy(inventory=mapOf("berries" to 50L))}
        assertEquals("ECONOMY_STORAGE_FULL",assertFailsWith<AuthFailure>{worlds.purchase(buyer.hash,circle,buy(buyer,lot))}.code)
        edit(buyer){it.copy(inventory=mapOf("berries" to 20L))}
        execute("INSERT INTO economy_market_daily_turnover(user_id,trade_day,buys_value) VALUES (?,(clock_timestamp() AT TIME ZONE 'UTC')::date,?)",buyer.id,EconomyMarketRules.dailyTradeLimit(2))
        assertEquals("ECONOMY_MARKET_DAILY_LIMIT",assertFailsWith<AuthFailure>{worlds.purchase(buyer.hash,circle,buy(buyer,lot))}.code)
        assertEquals(1000L,economy.snapshot(buyer.hash).wallet.coins)
        assertEquals(listOf(lot.id),worlds.world(buyer.hash,circle).market.listings.map { it.id })
        execute("DELETE FROM economy_market_daily_turnover WHERE user_id=?",buyer.id)
        val bought=worlds.purchase(buyer.hash,circle,buy(buyer,lot)).state
        assertEquals(980L,bought.wallet.coins);assertEquals(22L,bought.inventory["berries"])
        assertEquals(1000L,economy.snapshot(seller.hash).wallet.coins)
        assertEquals(19L,market.market(seller.hash).mine.single().sale?.proceedsCoins)
        assertTrue(worlds.world(buyer.hash,circle).market.listings.isEmpty())
    }

    @Test fun `level two visitor sees a level five storefront but cannot buy an undiscovered late item`() = runBlocking<Unit> {
        val buyer=player();val seller=player();val circle=connect(buyer,seller)
        edit(seller){it.copy(buildings=it.buildings + ("home" to 5),inventory=mapOf("tools" to 1L),
            unlockedItems=(it.unlockedItems+"tools").distinct())}
        market.command(seller.hash,command(seller,"create_listing","tools",1,1030))
        val lot=market.market(seller.hash).mine.single()
        val storefront=worlds.world(buyer.hash,circle).market
        assertTrue(storefront.available);assertNull(storefront.reason)
        assertEquals(listOf(lot.id),storefront.listings.map { it.id })
        val before=economy.snapshot(buyer.hash);val sellerBefore=economy.snapshot(seller.hash)
        val purchase=buy(buyer,lot)
        assertEquals("ECONOMY_MARKET_ITEM_LOCKED",assertFailsWith<AuthFailure>{worlds.purchase(buyer.hash,circle,purchase)}.code)
        val after=economy.snapshot(buyer.hash);val sellerAfter=economy.snapshot(seller.hash)
        assertEquals(before.revision,after.revision);assertEquals(before.wallet,after.wallet);assertEquals(before.inventory,after.inventory)
        assertEquals(sellerBefore.revision,sellerAfter.revision);assertEquals(sellerBefore.wallet,sellerAfter.wallet);assertEquals(sellerBefore.inventory,sellerAfter.inventory)
        assertEquals(listOf(lot.id),worlds.world(buyer.hash,circle).market.listings.map { it.id })
        assertEquals(0L,scalar("SELECT count(*) FROM economy_market_receipts WHERE user_id=? AND request_id=?",buyer.id,UUID.fromString(purchase.requestId)))
    }

    @Test fun `two visiting buyers cannot purchase the same escrow twice`() = runBlocking<Unit> {
        val seller=player();val a=player();val b=player();val ca=connect(a,seller);val cb=connect(b,seller);val lot=offer(seller)
        val ac=buy(a,lot);val bc=buy(b,lot)
        val results=coroutineScope { listOf(async(Dispatchers.IO){runCatching{worlds.purchase(a.hash,ca,ac)}},
            async(Dispatchers.IO){runCatching{worlds.purchase(b.hash,cb,bc)}}).awaitAll() }
        assertEquals(1,results.count { it.isSuccess });assertEquals("ECONOMY_MARKET_NOT_ACTIVE",(results.single { it.isFailure }.exceptionOrNull() as AuthFailure).code)
        assertEquals(42L,(economy.snapshot(a.hash).inventory["berries"] ?: 0) + (economy.snapshot(b.hash).inventory["berries"] ?: 0))
        assertEquals(1000L,economy.snapshot(seller.hash).wallet.coins)
        assertEquals(19L,market.market(seller.hash).mine.single().sale?.proceedsCoins)
    }

    @Test fun `HTTP guest world and purchase enforce session origin scope body and no store`() = testApplication {
        application { installZhivApi(identities,identities,config,tokens,guestWorlds=worlds) }
        val buyer=player();val seller=player();val circle=connect(buyer,seller);val lot=offer(seller);val path="/api/v1/people/$circle/world"
        assertEquals(HttpStatusCode.Unauthorized,client.get(path).status)
        val response=client.get(path){cookie(config.cookieName,buyer.raw)}
        assertEquals(HttpStatusCode.OK,response.status);assertEquals("no-store",response.headers[HttpHeaders.CacheControl])
        assertEquals(seller.publicId,Json.parseToJsonElement(response.bodyAsText()).jsonObject.getValue("user").jsonObject.getValue("publicId").jsonPrimitive.content)
        assertEquals(HttpStatusCode.BadRequest,client.get("$path?include=wallet"){cookie(config.cookieName,buyer.raw)}.status)
        val purchase=buy(buyer,lot)
        assertEquals(HttpStatusCode.Forbidden,client.post("$path/market/commands"){
            cookie(config.cookieName,buyer.raw);header(HttpHeaders.Origin,"https://foreign.invalid");contentType(ContentType.Application.Json);setBody(economyJson.encodeToString(purchase))
        }.status)
        assertEquals(HttpStatusCode.BadRequest,client.post("$path/market/commands"){
            cookie(config.cookieName,buyer.raw);header(HttpHeaders.Origin,"http://localhost");contentType(ContentType.Application.Json);setBody(economyJson.encodeToString(purchase).dropLast(1)+",\"seller\":\"fake\"}")
        }.status)
        val bought=client.post("$path/market/commands"){
            cookie(config.cookieName,buyer.raw);header(HttpHeaders.Origin,"http://localhost");contentType(ContentType.Application.Json);setBody(economyJson.encodeToString(purchase))
        }
        assertEquals(HttpStatusCode.OK,bought.status);assertEquals("no-store",bought.headers[HttpHeaders.CacheControl])
    }
}
