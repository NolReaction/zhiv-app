package ru.zhiv.db

import com.zaxxer.hikari.HikariDataSource
import io.ktor.client.request.*
import io.ktor.http.*
import io.ktor.server.testing.testApplication
import kotlinx.coroutines.*
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.*
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
class JdbcEconomyBarterRepositoryIntegrationTest {
    private class Postgres(image: String) : PostgreSQLContainer<Postgres>(image)
    companion object { @Container private val postgres = Postgres("postgres:18-alpine") }
    private lateinit var source: HikariDataSource
    private lateinit var config: AppConfig
    private lateinit var identities: JdbcZhivRepository
    private lateinit var economy: JdbcEconomyRepository
    private lateinit var barter: JdbcEconomyBarterRepository
    private val tokens = TokenCodec()
    private data class Player(val id: UUID, val publicId: String, val hash: ByteArray, val raw: String)

    @BeforeAll fun setup() {
        config=AppConfig(postgres.jdbcUrl, postgres.username, postgres.password, false, setOf("http://localhost"))
        source=DatabaseFactory.create(config); DatabaseFactory.migrate(source)
        identities=JdbcZhivRepository(source); economy=JdbcEconomyRepository(source); barter=JdbcEconomyBarterRepository(source)
    }
    @AfterAll fun close() { source.close() }
    @BeforeEach fun clearOffers() { execute("DELETE FROM economy_barter_showcases"); execute("DELETE FROM economy_barter_offers") }
    private fun execute(sql: String, vararg values: Any?) = source.connection.use { c -> c.economyUpdate(sql, *values).also { c.commit() } }
    private fun scalar(sql: String, vararg values: Any?): Long = source.connection.use { c -> c.economyRows(sql, *values) { it.getLong(1) }.single() }
    private suspend fun player(items: Map<String,Long> = mapOf("ancient_core" to 3L), home: Int = 3): Player {
        val token=tokens.issue(); val user=identities.bootstrap("Хранитель", tokens.issue().hash, token.hash, 365)
        economy.snapshot(token.hash)
        source.connection.use { c ->
            val old=readEconomyProfile(c,user.id).state
            c.economyUpdate("UPDATE economy_profiles SET state=?::jsonb WHERE user_id=?", economyJson.encodeToString(old.copy(
                wallet=EconomyWallet(123,9), inventory=items, buildings=old.buildings + ("home" to home), completedExplorations=1)),user.id)
            c.commit()
        }
        return Player(user.id,user.publicId,token.hash,token.raw)
    }
    private fun edit(player: Player, change: (EconomyState)->EconomyState) = source.connection.use { c ->
        c.economyUpdate("UPDATE economy_profiles SET state=?::jsonb WHERE user_id=?",economyJson.encodeToString(change(readEconomyProfile(c,player.id).state)),player.id)
        c.commit()
    }
    private suspend fun createCommand(p: Player, offered: String="ancient_core", requested: String="moon_crystal") =
        EconomyBarterCommand(UUID.randomUUID().toString(),p.publicId,economy.snapshot(p.hash).revision,"create_offer",offered,requested)
    private suspend fun action(p: Player, name: String, id: String) =
        EconomyBarterCommand(UUID.randomUUID().toString(),p.publicId,economy.snapshot(p.hash).revision,name,offerId=id)
    private suspend fun offer(p: Player, offered: String="ancient_core", requested: String="moon_crystal") = barter.command(p.hash,createCommand(p,offered,requested)).offer
    private fun expire(p: Player) { execute("UPDATE economy_barter_showcases SET refresh_at=clock_timestamp()-interval '1 second' WHERE user_id=?",p.id) }
    private fun payload(command: EconomyBarterCommand) = buildJsonObject {
        put("requestId",command.requestId);put("ownerPublicId",command.ownerPublicId);put("expectedRevision",command.expectedRevision);put("action",command.action)
        if(command.action=="create_offer") { put("offeredItemId",command.offeredItemId);put("requestedItemId",command.requestedItemId) }
        else put("offerId",command.offerId)
    }.toString()

    @Test fun `escrow consumes storage and cancel replay restores a finite item while create receipt stays immutable`() = runBlocking<Unit> {
        val p=player(); val command=createCommand(p); val created=barter.command(p.hash,command)
        assertEquals(2L,created.state.inventory["ancient_core"]);assertEquals(1L,created.state.storage.reserved)
        assertEquals(3L,created.state.storage.used+created.state.storage.reserved)
        assertEquals(EconomyWallet(123,9),created.state.wallet)
        assertEquals(created.offer,barter.command(p.hash,command).offer)
        val cancel=action(p,"cancel_offer",created.offer.id)
        edit(p) { it.copy(buildings=it.buildings+("home" to 1)) }
        val cancelled=barter.command(p.hash,cancel)
        assertEquals(3L,cancelled.state.inventory["ancient_core"]);assertEquals(0L,cancelled.state.storage.reserved)
        assertEquals("cancelled",cancelled.offer.status)
        assertTrue(barter.command(p.hash,cancel).replayed)
        val replay=barter.command(p.hash,command)
        assertTrue(replay.replayed);assertEquals(created.offer,replay.offer);assertEquals("active",replay.offer.status)
        assertEquals(cancelled.state.revision,replay.state.revision);assertEquals(cancelled.state.inventory,replay.state.inventory)
        assertEquals(1L,scalar("SELECT count(*) FROM economy_ledger WHERE user_id=? AND kind='barter_cancel'",p.id))
    }

    @Test fun `pair eligibility home stock offer limit and owner failures never create or spend`() = runBlocking<Unit> {
        val low=player(home=2)
        assertEquals("ECONOMY_BARTER_LOCKED",assertFailsWith<AuthFailure>{barter.command(low.hash,createCommand(low))}.code)
        assertTrue(barter.barter(low.hash).offers.isEmpty())
        val p=player(mapOf("ancient_core" to 5L,"wood" to 2L))
        for(bad in listOf("wood","pearls","fish_mooncarp","not-an-item"))
            assertEquals("ECONOMY_BARTER_ITEM",assertFailsWith<AuthFailure>{barter.command(p.hash,createCommand(p,bad))}.code)
        assertEquals("ECONOMY_RESOURCES",assertFailsWith<AuthFailure>{barter.command(p.hash,createCommand(p,"living_resin"))}.code)
        repeat(3) { offer(p) }
        assertEquals("ECONOMY_BARTER_LIMIT",assertFailsWith<AuthFailure>{offer(p)}.code)
        assertEquals(2L,economy.snapshot(p.hash).inventory["ancient_core"])
        val first=barter.barter(p.hash).mine.first()
        assertEquals("ECONOMY_BARTER_SELF_TRADE",assertFailsWith<AuthFailure>{barter.command(p.hash,action(p,"accept_offer",first.id))}.code)
        val other=player()
        assertEquals("ECONOMY_BARTER_OWNER",assertFailsWith<AuthFailure>{barter.command(other.hash,action(other,"cancel_offer",first.id))}.code)
        val foreign=createCommand(other).copy(ownerPublicId=p.publicId)
        assertEquals("ECONOMY_OWNER_CHANGED",assertFailsWith<AuthFailure>{barter.command(other.hash,foreign)}.code)
        assertEquals(0L,scalar("SELECT count(*) FROM economy_barter_receipts WHERE user_id=?",other.id))
    }

    @Test fun `exchange is one for one conserves both currencies and does not award discovery or a coin sale`() = runBlocking<Unit> {
        val seller=player(mapOf("ancient_core" to 1L));val buyer=player(mapOf("moon_crystal" to 1L))
        val offered=offer(seller);val beforeBuyer=economy.snapshot(buyer.hash);val beforeSeller=economy.snapshot(seller.hash)
        barter.barter(buyer.hash)
        val command=action(buyer,"accept_offer",offered.id);val result=barter.command(buyer.hash,command)
        val afterSeller=economy.snapshot(seller.hash)
        assertEquals("exchanged",result.offer.status);assertFalse(result.offer.owned)
        assertEquals(1L,result.state.inventory["ancient_core"]);assertEquals(0L,result.state.inventory["moon_crystal"])
        assertEquals(1L,afterSeller.inventory["moon_crystal"]);assertEquals(0L,afterSeller.inventory["ancient_core"])
        assertEquals(beforeBuyer.wallet,result.state.wallet);assertEquals(beforeSeller.wallet,afterSeller.wallet)
        assertEquals(beforeBuyer.progression,result.state.progression);assertEquals(beforeSeller.progression,afterSeller.progression)
        assertEquals(0L,afterSeller.storage.reserved)
        assertEquals(0L,scalar("SELECT count(*) FROM economy_ledger WHERE user_id IN (?,?) AND kind LIKE 'barter_%' AND (coins<>0 OR pearls<>0)",seller.id,buyer.id))
        assertEquals(0L,scalar("SELECT count(*) FROM game_achievement_tiers WHERE user_id IN (?,?) AND achievement_id='first_sale'",seller.id,buyer.id))
        expire(buyer);assertTrue(barter.command(buyer.hash,command).replayed)
        assertEquals(1L,economy.snapshot(buyer.hash).inventory["ancient_core"])
    }

    @Test fun `two acceptors racing receive exactly one item and duplicate requests replay across sessions`() = runBlocking<Unit> {
        val seller=player(mapOf("ancient_core" to 1L));val a=player(mapOf("moon_crystal" to 1L));val b=player(mapOf("moon_crystal" to 1L))
        val offered=offer(seller);barter.barter(a.hash);barter.barter(b.hash)
        val requests=listOf(a to action(a,"accept_offer",offered.id),b to action(b,"accept_offer",offered.id))
        val results=coroutineScope { requests.map { (p,command)->async(Dispatchers.IO){runCatching{barter.command(p.hash,command)}} }.awaitAll() }
        assertEquals(1,results.count{it.isSuccess});assertEquals("ECONOMY_BARTER_NOT_ACTIVE",(results.single{it.isFailure}.exceptionOrNull() as AuthFailure).code)
        assertEquals(1L,listOf(seller,a,b).sumOf{economy.snapshot(it.hash).inventory["ancient_core"]?:0L})
        assertEquals(2L,listOf(seller,a,b).sumOf{economy.snapshot(it.hash).inventory["moon_crystal"]?:0L})
        val winner=requests[results.indexOfFirst{it.isSuccess}]
        assertTrue(barter.command(winner.first.hash,winner.second).replayed)
        assertEquals(1L,scalar("SELECT count(*) FROM economy_ledger WHERE source_key=?","barter:accept:${offered.id}"))
        val nextSeller=player(mapOf("ancient_core" to 1L));val buyer=player(mapOf("moon_crystal" to 1L));val next=offer(nextSeller)
        barter.barter(buyer.hash);val request=action(buyer,"accept_offer",next.id);val secondToken=tokens.issue()
        execute("INSERT INTO app_sessions(user_id,token_hash,expires_at) VALUES (?,?,clock_timestamp()+interval '1 year')",buyer.id,secondToken.hash)
        val duplicates=coroutineScope { listOf(buyer.hash,secondToken.hash).map{hash->async(Dispatchers.IO){barter.command(hash,request)}}.awaitAll() }
        assertEquals(1,duplicates.count{it.replayed});assertEquals(1L,economy.snapshot(buyer.hash).inventory["ancient_core"])
    }

    @Test fun `cancellation racing acceptance returns either escrow or exchanged item without duplication`() = runBlocking<Unit> {
        val seller=player(mapOf("ancient_core" to 1L));val buyer=player(mapOf("moon_crystal" to 1L));val offered=offer(seller)
        barter.barter(buyer.hash)
        val commands=listOf(seller to action(seller,"cancel_offer",offered.id),buyer to action(buyer,"accept_offer",offered.id))
        val results=coroutineScope{commands.map{(p,command)->async(Dispatchers.IO){runCatching{barter.command(p.hash,command)}}}.awaitAll()}
        assertEquals(1,results.count{it.isSuccess})
        val states=listOf(economy.snapshot(seller.hash),economy.snapshot(buyer.hash))
        assertEquals(1L,states.sumOf{it.inventory["ancient_core"]?:0L});assertEquals(1L,states.sumOf{it.inventory["moon_crystal"]?:0L})
        assertEquals(246L,states.sumOf{it.wallet.coins});assertEquals(18L,states.sumOf{it.wallet.pearls})
        assertEquals(0L,states.sumOf{it.storage.reserved})
    }

    @Test fun `reciprocal swaps lock accounts in one order and the stale loser may retry`() = runBlocking<Unit> {
        val a=player(mapOf("ancient_core" to 2L,"moon_crystal" to 1L));val b=player(mapOf("moon_crystal" to 2L,"ancient_core" to 1L))
        val oa=offer(a);val ob=offer(b,"moon_crystal","ancient_core")
        barter.barter(a.hash);barter.barter(b.hash)
        val commands=listOf(a to action(a,"accept_offer",ob.id),b to action(b,"accept_offer",oa.id))
        val results=coroutineScope{commands.map{(p,command)->async(Dispatchers.IO){runCatching{barter.command(p.hash,command)}}}.awaitAll()}
        assertEquals(1,results.count{it.isSuccess});assertEquals("ECONOMY_REVISION_CONFLICT",(results.single{it.isFailure}.exceptionOrNull() as AuthFailure).code)
        val (loser,command)=commands[results.indexOfFirst{it.isFailure}]
        barter.command(loser.hash,command.copy(expectedRevision=economy.snapshot(loser.hash).revision))
        assertEquals(0L,economy.snapshot(a.hash).inventory["ancient_core"]);assertEquals(3L,economy.snapshot(a.hash).inventory["moon_crystal"])
        assertEquals(0L,economy.snapshot(b.hash).inventory["moon_crystal"]);assertEquals(3L,economy.snapshot(b.hash).inventory["ancient_core"])
    }

    @Test fun `six offers one per seller are fixed across concurrent reads hidden ids and sold slots`() = runBlocking<Unit> {
        val sellers=List(8){player()};val all=sellers.flatMap { seller->List(3){offer(seller)} }
        val buyer=player(mapOf("moon_crystal" to 10L))
        val reads=coroutineScope{List(4){async(Dispatchers.IO){barter.barter(buyer.hash)}}.awaitAll()}
        val first=reads.first()
        assertEquals(buyer.publicId,first.ownerPublicId);assertEquals(6,first.offers.size)
        assertEquals(6,first.offers.map{it.sellerPublicId}.distinct().size)
        assertTrue(reads.all{it.offers==first.offers && it.showcase==first.showcase})
        assertEquals(1L,scalar("SELECT count(*) FROM economy_barter_showcases WHERE user_id=?",buyer.id))
        val hidden=all.first{candidate->first.offers.none{it.id==candidate.id}}
        assertEquals("ECONOMY_BARTER_SHOWCASE_CHANGED",assertFailsWith<AuthFailure>{barter.command(buyer.hash,action(buyer,"accept_offer",hidden.id))}.code)
        for(selected in first.offers) barter.command(buyer.hash,action(buyer,"accept_offer",selected.id))
        assertTrue(barter.barter(buyer.hash).offers.isEmpty());assertEquals(first.showcase,barter.barter(buyer.hash).showcase)
        assertEquals(6L,economy.snapshot(buyer.hash).inventory["ancient_core"])
        expire(buyer)
        assertTrue(barter.barter(buyer.hash).offers.isNotEmpty())
    }

    @Test fun `empty window does not refill and expiry requires a fresh server selection`() = runBlocking<Unit> {
        val seller=player();val buyer=player(mapOf("moon_crystal" to 1L));val empty=barter.barter(buyer.hash)
        val lot=offer(seller);val request=action(buyer,"accept_offer",lot.id)
        assertEquals("ECONOMY_BARTER_SHOWCASE_CHANGED",assertFailsWith<AuthFailure>{barter.command(buyer.hash,request)}.code)
        assertTrue(barter.barter(buyer.hash).offers.isEmpty());assertEquals(empty.showcase,barter.barter(buyer.hash).showcase)
        expire(buyer)
        assertEquals("ECONOMY_BARTER_SHOWCASE_CHANGED",assertFailsWith<AuthFailure>{barter.command(buyer.hash,request)}.code)
        assertEquals(lot.id,barter.barter(buyer.hash).offers.single().id)
        edit(buyer){it.copy(buildings=it.buildings+("home" to 2))}
        assertEquals("ECONOMY_BARTER_LOCKED",assertFailsWith<AuthFailure>{barter.command(buyer.hash,request)}.code)
        edit(buyer){it.copy(buildings=it.buildings+("home" to 3))}
        barter.command(buyer.hash,request)
        assertTrue(barter.command(buyer.hash,request).replayed)
    }

    @Test fun `lack of payment or a numeric overflow rolls back both participants status and ledgers`() = runBlocking<Unit> {
        val seller=player();val buyer=player(emptyMap());val lot=offer(seller);barter.barter(buyer.hash)
        val first=action(buyer,"accept_offer",lot.id)
        assertEquals("ECONOMY_RESOURCES",assertFailsWith<AuthFailure>{barter.command(buyer.hash,first)}.code)
        edit(buyer){it.copy(inventory=mapOf("moon_crystal" to 1L,"ancient_core" to ECONOMY_MAX_ITEMS))}
        val beforeBuyer=economy.snapshot(buyer.hash);val beforeSeller=economy.snapshot(seller.hash)
        assertEquals("ECONOMY_CAPACITY",assertFailsWith<AuthFailure>{barter.command(buyer.hash,first)}.code)
        assertEquals(beforeBuyer,economy.snapshot(buyer.hash).copy(serverTime=beforeBuyer.serverTime))
        assertEquals(beforeSeller,economy.snapshot(seller.hash).copy(serverTime=beforeSeller.serverTime))
        assertEquals("active",barter.barter(seller.hash).mine.single().status)
        assertEquals(0L,scalar("SELECT count(*) FROM economy_barter_receipts WHERE user_id=?",buyer.id))
        assertEquals(0L,scalar("SELECT count(*) FROM economy_ledger WHERE source_key=?","barter:accept:${lot.id}"))
        edit(buyer){it.copy(inventory=mapOf("moon_crystal" to 1L))}
        edit(seller){it.copy(inventory=it.inventory+("moon_crystal" to ECONOMY_MAX_ITEMS))}
        assertEquals("ECONOMY_CAPACITY",assertFailsWith<AuthFailure>{barter.command(buyer.hash,first)}.code)
        assertEquals(1L,economy.snapshot(buyer.hash).inventory["moon_crystal"])
    }

    @Test fun `full warehouses and preserved old overflow allow neutral swaps without freeing escrow space`() = runBlocking<Unit> {
        val seller=player(mapOf("ancient_core" to 1L,"wood" to 230L));val buyer=player(mapOf("moon_crystal" to 1L,"stone" to 299L))
        val sellerBefore=economy.snapshot(seller.hash);val buyerBefore=economy.snapshot(buyer.hash)
        val lot=offer(seller);val listed=economy.snapshot(seller.hash)
        assertEquals(sellerBefore.storage.overflow,listed.storage.overflow)
        assertEquals(1L,listed.storage.reserved)
        barter.barter(buyer.hash);barter.command(buyer.hash,action(buyer,"accept_offer",lot.id))
        assertEquals(sellerBefore.storage.overflow,economy.snapshot(seller.hash).storage.overflow)
        assertEquals(buyerBefore.storage.overflow,economy.snapshot(buyer.hash).storage.overflow)
        assertEquals(1L,economy.snapshot(buyer.hash).inventory["ancient_core"])
        assertEquals(1L,economy.snapshot(seller.hash).inventory["moon_crystal"])
    }

    @Test fun `banned sellers disappear without replacement and stale acceptance cannot exchange`() = runBlocking<Unit> {
        val seller=player();val buyer=player(mapOf("moon_crystal" to 1L));val lot=offer(seller);val shown=barter.barter(buyer.hash)
        execute("UPDATE app_users SET banned_at=clock_timestamp(),ban_reason='Barter test moderation' WHERE id=?",seller.id)
        assertTrue(barter.barter(buyer.hash).offers.isEmpty());assertEquals(shown.showcase,barter.barter(buyer.hash).showcase)
        assertEquals("ECONOMY_BARTER_NOT_FOUND",assertFailsWith<AuthFailure>{barter.command(buyer.hash,action(buyer,"accept_offer",lot.id))}.code)
        assertEquals(1L,economy.snapshot(buyer.hash).inventory["moon_crystal"])
    }

    @Test fun `request namespace fences block economy market and reward ids in both directions`() = runBlocking<Unit> {
        val p=player(mapOf("ancient_core" to 3L,"wood" to 3L,"berries" to 3L))
        val before=economy.snapshot(p.hash)
        val sell=EconomyCommand(UUID.randomUUID().toString(),p.publicId,before.revision,"sell","wood")
        economy.command(p.hash,sell)
        assertEquals("ECONOMY_REQUEST_CONFLICT",assertFailsWith<AuthFailure>{barter.command(p.hash,createCommand(p).copy(requestId=sell.requestId))}.code)
        val market=JdbcEconomyMarketRepository(source)
        val marketRequest=EconomyCommand(UUID.randomUUID().toString(),p.publicId,economy.snapshot(p.hash).revision,"create_listing","berries",totalPrice=30)
        market.command(p.hash,marketRequest)
        assertEquals("ECONOMY_REQUEST_CONFLICT",assertFailsWith<AuthFailure>{barter.command(p.hash,createCommand(p).copy(requestId=marketRequest.requestId))}.code)
        val rewardId=UUID.randomUUID()
        execute("""INSERT INTO game_reward_claims(user_id,request_id,origin_user_id,signature,kind,claim,accepted_revision,claimed_at)
            VALUES (?,?,?,'reward-fence','achievement','{}'::jsonb,0,clock_timestamp())""",p.id,rewardId,p.id)
        assertEquals("ECONOMY_REQUEST_CONFLICT",assertFailsWith<AuthFailure>{barter.command(p.hash,createCommand(p).copy(requestId=rewardId.toString()))}.code)
        val fresh=createCommand(p);barter.command(p.hash,fresh)
        val revision=economy.snapshot(p.hash).revision
        assertEquals("ECONOMY_REQUEST_CONFLICT",assertFailsWith<AuthFailure>{economy.command(p.hash,sell.copy(requestId=fresh.requestId,expectedRevision=revision))}.code)
        assertEquals("ECONOMY_REQUEST_CONFLICT",assertFailsWith<AuthFailure>{market.command(p.hash,marketRequest.copy(requestId=fresh.requestId,expectedRevision=revision))}.code)
        assertEquals("ECONOMY_REQUEST_CONFLICT",assertFailsWith<AuthFailure>{barter.command(p.hash,fresh.copy(requestedItemId="living_resin"))}.code)
    }

    @Test fun `lifecycle cancellation refunds once and copied receipt remains a source identity fence`() = runBlocking<Unit> {
        val from=player();val target=player();val original=createCommand(from);val offered=barter.command(from.hash,original).offer
        source.connection.use{c->
            c.economyRows("SELECT id FROM app_users WHERE id IN (?,?) ORDER BY id FOR NO KEY UPDATE",from.id,target.id){true}
            cancelEconomyBarterOffers(c,from.id);cancelEconomyBarterOffers(c,from.id)
            mergeEconomyBarterReceipts(c,target.id,from.id)
            c.commit()
        }
        assertEquals(3L,economy.snapshot(from.hash).inventory["ancient_core"])
        assertEquals(1L,scalar("SELECT count(*) FROM economy_ledger WHERE user_id=? AND source_key=?",from.id,"barter:cancel:${offered.id}"))
        assertEquals("ECONOMY_REQUEST_CONFLICT",assertFailsWith<AuthFailure>{barter.command(target.hash,original.copy(ownerPublicId=target.publicId,expectedRevision=economy.snapshot(target.hash).revision))}.code)
        assertEquals(offered,barter.command(from.hash,original).offer)
    }

    @Test fun `V39 upgrades populated V38 without changing balances active coin listings or paid receipts`() = runBlocking<Unit> {
        val database="barter_upgrade_${UUID.randomUUID().toString().replace("-","")}"
        source.connection.use{c->c.autoCommit=true;c.economyUpdate("CREATE DATABASE $database")}
        try {
            val isolatedConfig=config.copy(databaseUrl="jdbc:postgresql://${postgres.host}:${postgres.getMappedPort(5432)}/$database")
            DatabaseFactory.create(isolatedConfig).use{isolated->
                Flyway.configure().dataSource(isolated).locations("classpath:db/migration").target("38").load().migrate()
                val token=tokens.issue();val user=JdbcZhivRepository(isolated).bootstrap("До обмена",tokens.issue().hash,token.hash,365)
                val listing=UUID.randomUUID();val request=UUID.randomUUID()
                isolated.connection.use{c->
                    c.economyRows("SELECT id FROM app_users WHERE id=? FOR NO KEY UPDATE",user.id){true}
                    ensureEconomyProfile(c,user.id)
                    val old=readEconomyProfile(c,user.id).state
                    c.economyUpdate("UPDATE economy_profiles SET state=?::jsonb,revision=7 WHERE user_id=?",economyJson.encodeToString(old.copy(
                        wallet=EconomyWallet(123,9),inventory=mapOf("ancient_core" to 1L,"berries" to 2L),buildings=old.buildings+("home" to 3))),user.id)
                    c.economyUpdate("INSERT INTO economy_market_listings(id,seller_id,item_id,quantity,total_price) VALUES (?,?,'berries',1,3)",listing,user.id)
                    c.economyUpdate("INSERT INTO economy_market_receipts(user_id,request_id,signature,message,accepted_revision) VALUES (?,?,'old','Продано',7)",user.id,request)
                    c.commit()
                }
                fun rows(table:String)=isolated.connection.use{c->c.economyRows("SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]'::jsonb)::text FROM $table t"){it.getString(1)}.single()}
                val tables=listOf("economy_profiles","economy_market_listings","economy_market_receipts","economy_ledger","game_reward_claims")
                val before=tables.associateWith(::rows)
                DatabaseFactory.migrate(isolated);DatabaseFactory.migrate(isolated)
                assertEquals(before,tables.associateWith(::rows))
                val repository=JdbcEconomyBarterRepository(isolated)
                val command=EconomyBarterCommand(UUID.randomUUID().toString(),user.publicId,7,"create_offer","ancient_core","moon_crystal")
                val result=repository.command(token.hash,command)
                assertEquals(2L,result.state.storage.reserved,"coin listing and barter share warehouse escrow")
                assertEquals(EconomyWallet(123,9),result.state.wallet)
                assertTrue(repository.command(token.hash,command).replayed)
            }
        } finally {source.connection.use{c->c.autoCommit=true;c.economyUpdate("DROP DATABASE $database WITH (FORCE)")}}
    }

    @Test fun `HTTP barter authenticates trusted writes and rejects pricing extra fields and pagination`() = testApplication {
        application { installZhivApi(identities,identities,config,tokens,economy=economy,economyBarter=barter) }
        val p=player();val command=createCommand(p)
        assertEquals(HttpStatusCode.Unauthorized,client.get("/api/v1/economy/barter").status)
        val get=client.get("/api/v1/economy/barter"){cookie(config.cookieName,p.raw)}
        assertEquals(HttpStatusCode.OK,get.status);assertEquals("no-store",get.headers[HttpHeaders.CacheControl])
        for(query in listOf("cursor=x","limit=20","owner=someone"))
            assertEquals(HttpStatusCode.BadRequest,client.get("/api/v1/economy/barter?$query"){cookie(config.cookieName,p.raw)}.status)
        suspend fun post(body:String,origin:String="http://localhost")=client.post("/api/v1/economy/barter/commands"){
            cookie(config.cookieName,p.raw);header(HttpHeaders.Origin,origin);contentType(ContentType.Application.Json);setBody(body)
        }
        val json=payload(command)
        assertEquals(HttpStatusCode.Forbidden,post(json,"https://foreign.example").status)
        for(extra in listOf("\"coins\":1","\"pearls\":1","\"quantity\":1","\"totalPrice\":0","\"offerId\":null"))
            assertEquals(HttpStatusCode.BadRequest,post(json.dropLast(1)+",$extra}").status)
        assertEquals(HttpStatusCode.BadRequest,post(json.replace("\"expectedRevision\":${command.expectedRevision}","\"expectedRevision\":\"${command.expectedRevision}\"")).status)
        assertEquals(HttpStatusCode.PayloadTooLarge,post(" ".repeat(2049)+json).status)
        val created=post(json);assertEquals(HttpStatusCode.OK,created.status);assertEquals("no-store",created.headers[HttpHeaders.CacheControl])
        assertEquals(2L,economy.snapshot(p.hash).inventory["ancient_core"])
    }
}
