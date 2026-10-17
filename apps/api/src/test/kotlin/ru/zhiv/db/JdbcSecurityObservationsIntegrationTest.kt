package ru.zhiv.db

import com.zaxxer.hikari.HikariDataSource
import io.ktor.client.request.get
import io.ktor.client.request.header
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpStatusCode
import io.ktor.server.testing.testApplication
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.encodeToString
import org.junit.jupiter.api.AfterAll
import org.junit.jupiter.api.BeforeAll
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.TestInstance
import org.testcontainers.containers.PostgreSQLContainer
import org.testcontainers.junit.jupiter.Container
import org.testcontainers.junit.jupiter.Testcontainers
import ru.zhiv.admin.AdminConfig
import ru.zhiv.admin.AdminPlayerCommand
import ru.zhiv.admin.SecurityObservationKind
import ru.zhiv.auth.AuthFailure
import ru.zhiv.config.AppConfig
import ru.zhiv.economy.*
import ru.zhiv.installZhivApi
import ru.zhiv.security.TokenCodec
import java.util.UUID
import kotlin.test.*

@Testcontainers(disabledWithoutDocker = true)
@TestInstance(TestInstance.Lifecycle.PER_CLASS)
class JdbcSecurityObservationsIntegrationTest {
    private class Postgres(image: String) : PostgreSQLContainer<Postgres>(image)
    companion object { @Container private val postgres = Postgres("postgres:18-alpine") }
    private lateinit var source: HikariDataSource
    private lateinit var identities: JdbcZhivRepository
    private lateinit var economy: JdbcEconomyRepository
    private lateinit var config: AppConfig
    private val tokens = TokenCodec()
    private data class Player(val id: UUID, val publicId: String, val hash: ByteArray, val raw: String)
    @BeforeAll fun setup() {
        config=AppConfig(postgres.jdbcUrl,postgres.username,postgres.password,false,setOf("http://localhost"))
        source=DatabaseFactory.create(config); DatabaseFactory.migrate(source)
        identities=JdbcZhivRepository(source); economy=JdbcEconomyRepository(source)
    }
    @AfterAll fun close() { source.close() }
    @BeforeEach fun clear() { execute("TRUNCATE app_users CASCADE") }
    private fun execute(sql: String,vararg values: Any?)=source.connection.use { c -> c.economyUpdate(sql,*values).also { c.commit() } }
    private suspend fun player(): Player {
        val token=tokens.issue();val user=identities.bootstrap("Игрок",tokens.issue().hash,token.hash,365)
        economy.snapshot(token.hash)
        return Player(user.id,user.publicId,token.hash,token.raw)
    }
    private fun admin(p: Player)=JdbcAdminRepository(source,AdminConfig(setOf(p.publicId)))
    private suspend fun sell(p: Player)=EconomyCommand(UUID.randomUUID().toString(),p.publicId,economy.snapshot(p.hash).revision,"sell","wood",1)
    private fun reviewCommand(p: Player)=AdminPlayerCommand(UUID.randomUUID().toString(),p.publicId,"Проверены серверные наблюдения","clear_signal")
    private suspend fun clearSignals(repo: JdbcAdminRepository,p: Player) {
        val command=reviewCommand(p)
        repo.managePlayer(p.hash,p.publicId,UUID.fromString(command.requestId),command)
    }
    private fun record(p: Player,kind: SecurityObservationKind,key: UUID=UUID.randomUUID(),action: String="market:cancel_listing") {
        source.connection.use { c ->
            c.economyRows("SELECT id FROM app_users WHERE id=? FOR NO KEY UPDATE",p.id) { true }
            recordSecurityObservation(c,ObservedSecurityFailure(p.id,kind,action,key,"DENIED","Отказ"))
            c.commit()
        }
    }

    @Test fun `only semantic request tampering is observed after rollback and duplicate denied retries are bounded`()=runBlocking<Unit> {
        val p=player();val repo=admin(p);val request=sell(p)
        val accepted=economy.command(p.hash,request)
        assertTrue(economy.command(p.hash,request).replayed)
        assertEquals("ECONOMY_REQUEST_CONFLICT",assertFailsWith<AuthFailure>{economy.command(p.hash,request.copy(expectedRevision=accepted.state.revision))}.code)
        assertTrue(repo.security(p.hash,p.publicId).signals.isEmpty())
        assertEquals("ECONOMY_OWNER_CHANGED",assertFailsWith<AuthFailure>{economy.command(p.hash,request.copy(ownerPublicId="0000-0000-0000"))}.code)
        assertEquals("ECONOMY_REVISION_CONFLICT",assertFailsWith<AuthFailure>{economy.command(p.hash,request.copy(requestId=UUID.randomUUID().toString()))}.code)
        assertEquals("ECONOMY_RESOURCES",assertFailsWith<AuthFailure>{economy.command(p.hash,request.copy(requestId=UUID.randomUUID().toString(),
            expectedRevision=accepted.state.revision,quantity=100))}.code)
        assertTrue(repo.security(p.hash,p.publicId).signals.isEmpty())
        repeat(3) { assertEquals("ECONOMY_REQUEST_CONFLICT",assertFailsWith<AuthFailure>{economy.command(p.hash,request.copy(quantity=2))}.code) }
        val signal=repo.security(p.hash,p.publicId).signals.single()
        assertEquals("ECONOMY_REQUEST_TAMPER",signal.code);assertEquals(1L,signal.count);assertEquals(1L,signal.pendingCount)
        assertEquals(request.requestId,signal.lastRequestId);assertEquals("economy:sell",signal.lastAction);assertEquals("active",signal.status)
        assertNotNull(repo.player(p.hash,p.publicId).securitySignalAt)
        assertEquals(accepted.state.revision,economy.snapshot(p.hash).revision)
        assertEquals(accepted.state.inventory,economy.snapshot(p.hash).inventory)
        assertEquals(accepted.state.wallet,economy.snapshot(p.hash).wallet)
        assertNull(repo.player(p.hash,p.publicId).bannedAt)
        clearSignals(repo,p)
        assertNull(repo.player(p.hash,p.publicId).securitySignalAt)
        val cleared=repo.security(p.hash,p.publicId).signals.single()
        assertEquals("reviewed",cleared.status);assertEquals(0L,cleared.pendingCount);assertNotNull(cleared.reviewedAt)
        assertFailsWith<AuthFailure>{economy.command(p.hash,request.copy(quantity=2))}
        assertEquals("reviewed",repo.security(p.hash,p.publicId).signals.single().status)
        val next=sell(p);economy.command(p.hash,next)
        assertFailsWith<AuthFailure>{economy.command(p.hash,next.copy(quantity=2))}
        assertEquals("active",repo.security(p.hash,p.publicId).signals.single().status)
        assertEquals(2L,repo.security(p.hash,p.publicId).signals.single().count)
    }

    @Test fun `cross endpoint request reuse is rejected and observable without changing balances`()=runBlocking<Unit> {
        val p=player();val accepted=sell(p);economy.command(p.hash,accepted)
        val before=economy.snapshot(p.hash)
        val attempt=accepted.copy(action="create_listing",targetId="wood",totalPrice=10,expectedRevision=before.revision)
        assertEquals("ECONOMY_REQUEST_CONFLICT",assertFailsWith<AuthFailure>{JdbcEconomyMarketRepository(source).command(p.hash,attempt)}.code)
        assertEquals("market:create_listing",admin(p).security(p.hash,p.publicId).signals.single().lastAction)
        assertEquals(before.wallet,economy.snapshot(p.hash).wallet);assertEquals(before.revision,economy.snapshot(p.hash).revision)
    }

    @Test fun `foreign market and barter cancellation require three distinct attempts inside one window`()=runBlocking<Unit> {
        val p=player();val seller=player();val market=JdbcEconomyMarketRepository(source);val barter=JdbcEconomyBarterRepository(source)
        for (actor in listOf(p,seller)) source.connection.use { c ->
            val old=readEconomyProfile(c,actor.id).state
            c.economyUpdate("UPDATE economy_profiles SET state=?::jsonb WHERE user_id=?",economyJson.encodeToString(old.copy(
                inventory=old.inventory+mapOf("ancient_core" to 2L),buildings=old.buildings+mapOf("home" to 3,"bridge" to 1),completedExplorations=1)),actor.id)
            c.commit()
        }
        market.command(seller.hash,EconomyCommand(UUID.randomUUID().toString(),seller.publicId,economy.snapshot(seller.hash).revision,"create_listing","wood",1,30))
        val listing=market.market(seller.hash).mine.single()
        val offer=barter.command(seller.hash,EconomyBarterCommand(UUID.randomUUID().toString(),seller.publicId,economy.snapshot(seller.hash).revision,
            "create_offer","ancient_core","moon_crystal")).offer
        val repo=admin(p)
        repeat(3) {
            assertEquals("ECONOMY_MARKET_OWNER",assertFailsWith<AuthFailure>{market.command(p.hash,EconomyCommand(UUID.randomUUID().toString(),p.publicId,
                economy.snapshot(p.hash).revision,"cancel_listing",listing.id))}.code)
            assertEquals("ECONOMY_BARTER_OWNER",assertFailsWith<AuthFailure>{barter.command(p.hash,EconomyBarterCommand(UUID.randomUUID().toString(),p.publicId,
                economy.snapshot(p.hash).revision,"cancel_offer",offerId=offer.id))}.code)
            assertEquals(if(it<2) null else true,repo.player(p.hash,p.publicId).securitySignalAt?.let { true })
        }
        assertEquals(setOf("active"),repo.security(p.hash,p.publicId).signals.map { it.status }.toSet())
        assertEquals(listOf(3L,3L),repo.security(p.hash,p.publicId).signals.map { it.count })
        assertEquals(listing.id,market.market(seller.hash).mine.single().id);assertEquals(offer.id,barter.barter(seller.hash).mine.single().id)
        clearSignals(repo,p)
        record(p,SecurityObservationKind.MARKET_OWNERSHIP_DENIED)
        assertNull(repo.player(p.hash,p.publicId).securitySignalAt)
        execute("UPDATE player_security_observations SET window_started_at=clock_timestamp()-interval '31 minutes' WHERE user_id=?",p.id)
        val expired=repo.security(p.hash,p.publicId).signals.first { it.code=="MARKET_OWNERSHIP_DENIED" }
        assertEquals("context",expired.status);assertEquals(0L,expired.pendingCount)
        record(p,SecurityObservationKind.MARKET_OWNERSHIP_DENIED)
        assertEquals(1L,repo.security(p.hash,p.publicId).signals.first { it.code=="MARKET_OWNERSHIP_DENIED" }.pendingCount)
        assertNull(repo.player(p.hash,p.publicId).securitySignalAt)
    }

    @Test fun `recorder failure preserves original denial and rolls back its partial observation`()=runBlocking<Unit> {
        val p=player();val request=sell(p);val accepted=economy.command(p.hash,request)
        execute("""CREATE FUNCTION security_observation_test_failure() RETURNS trigger LANGUAGE plpgsql AS $$
            BEGIN RAISE EXCEPTION 'forced test failure'; END $$""")
        execute("CREATE TRIGGER security_observation_test_failure BEFORE INSERT ON player_security_observations FOR EACH ROW EXECUTE FUNCTION security_observation_test_failure()")
        try {
            assertEquals("ECONOMY_REQUEST_CONFLICT",assertFailsWith<AuthFailure>{economy.command(p.hash,request.copy(quantity=2))}.code)
            assertTrue(admin(p).security(p.hash,p.publicId).signals.isEmpty())
            assertEquals(accepted.state.wallet,economy.snapshot(p.hash).wallet)
        } finally {
            execute("DROP TRIGGER security_observation_test_failure ON player_security_observations")
            execute("DROP FUNCTION security_observation_test_failure()")
        }
    }

    @Test fun `summary storage is bounded and merge preserves active reviews without combining weak windows`()=runBlocking<Unit> {
        val p=player();val other=player();val kind=SecurityObservationKind.MARKET_OWNERSHIP_DENIED
        record(p,kind);record(other,kind)
        source.connection.use { c -> mergeSecurityObservations(c,p.id,other.id);c.commit() }
        assertNull(admin(p).player(p.hash,p.publicId).securitySignalAt)
        assertEquals(2L,admin(p).security(p.hash,p.publicId).signals.single().count)
        val duplicate=UUID.randomUUID()
        repeat(6) { record(p,SecurityObservationKind.ECONOMY_REQUEST_TAMPER,action="economy:sell") }
        repeat(5) { record(other,SecurityObservationKind.ECONOMY_REQUEST_TAMPER,action="economy:sell") }
        record(other,SecurityObservationKind.ECONOMY_REQUEST_TAMPER,duplicate,action="economy:sell")
        source.connection.use { c -> mergeSecurityObservations(c,p.id,other.id);c.commit() }
        repeat(5) { record(p,SecurityObservationKind.ECONOMY_REQUEST_TAMPER,action="economy:sell") }
        val beforeRetry=admin(p).security(p.hash,p.publicId).signals.first { it.code=="ECONOMY_REQUEST_TAMPER" }.count
        clearSignals(admin(p),p)
        record(p,SecurityObservationKind.ECONOMY_REQUEST_TAMPER,duplicate,action="economy:sell")
        assertEquals(beforeRetry,admin(p).security(p.hash,p.publicId).signals.first { it.code=="ECONOMY_REQUEST_TAMPER" }.count)
        assertNull(admin(p).player(p.hash,p.publicId).securitySignalAt)
        repeat(25) { record(p,SecurityObservationKind.ECONOMY_REQUEST_TAMPER,action="economy:sell") }
        val lengths=source.connection.use { c -> c.economyRows("SELECT cardinality(recent_request_ids) FROM player_security_observations WHERE user_id=?",p.id){it.getInt(1)} }
        assertTrue(lengths.all { it<=16 });assertTrue(lengths.size<=3)
        execute("DELETE FROM app_users WHERE id=?",p.id)
        assertEquals(0,source.connection.use { c -> c.economyRows("SELECT count(*) FROM player_security_observations WHERE user_id=?",p.id){it.getInt(1)}.single() })
    }

    @Test fun `unwatch leaves automatic evidence and old manual reason cannot describe a later legacy observation`()=runBlocking<Unit> {
        val p=player();val repo=admin(p)
        for (action in listOf("watch","unwatch")) {
            val command=AdminPlayerCommand(UUID.randomUUID().toString(),p.publicId,"Ручная проверка поведения игрока",action)
            repo.managePlayer(p.hash,p.publicId,UUID.fromString(command.requestId),command)
        }
        record(p,SecurityObservationKind.ECONOMY_REQUEST_TAMPER,action="economy:sell")
        assertFalse(repo.security(p.hash,p.publicId).watchlisted)
        assertNotNull(repo.security(p.hash,p.publicId).securitySignalAt)
        assertNull(repo.security(p.hash,p.publicId).manualWatchReason)
        execute("UPDATE app_users SET tap_watchlisted=true WHERE id=?",p.id)
        assertTrue(repo.security(p.hash,p.publicId).manualWatchReason!!.contains("точная причина не сохранена"))
    }

    @Test fun `security endpoint authenticates admins and returns private no-store observations`()=testApplication {
        val p=runBlocking { player() };val outsider=runBlocking { player() }
        application { installZhivApi(identities,identities,config,admin=admin(p)) }
        val path="/api/v1/admin/users/${outsider.publicId}/security"
        assertEquals(HttpStatusCode.Unauthorized,client.get(path).status)
        assertEquals(HttpStatusCode.Forbidden,client.get(path){header(HttpHeaders.Cookie,"${config.cookieName}=${outsider.raw}")}.status)
        val response=client.get(path){header(HttpHeaders.Cookie,"${config.cookieName}=${p.raw}")}
        assertEquals(HttpStatusCode.OK,response.status);assertEquals("no-store",response.headers[HttpHeaders.CacheControl])
    }
}
