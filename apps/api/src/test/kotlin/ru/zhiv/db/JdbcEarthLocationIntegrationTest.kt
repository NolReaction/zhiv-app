package ru.zhiv.db

import com.zaxxer.hikari.HikariDataSource
import kotlinx.coroutines.*
import org.flywaydb.core.Flyway
import org.junit.jupiter.api.AfterAll
import org.junit.jupiter.api.BeforeAll
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.TestInstance
import org.testcontainers.containers.PostgreSQLContainer
import ru.zhiv.auth.*
import ru.zhiv.config.AppConfig
import ru.zhiv.earth.*
import ru.zhiv.security.TokenCodec
import java.time.Instant
import java.util.UUID
import kotlin.test.*

/** Real PostgreSQL only. CI starts Testcontainers; an explicitly supplied isolated
 * local database can run this class without Docker. No silent test skips.
 */
@TestInstance(TestInstance.Lifecycle.PER_CLASS)
class JdbcEarthLocationIntegrationTest {
    private class Postgres: PostgreSQLContainer<Postgres>("postgres:18-alpine")
    private var postgres: Postgres?=null
    private lateinit var source: HikariDataSource
    private lateinit var repo: JdbcEarthLocationRepository
    private val tokens=TokenCodec()
    private data class Account(val id: UUID,val publicId: String,val hash: ByteArray,val subject: String)
    @BeforeAll fun start() {
        val url=System.getenv("EARTH_GEO_TEST_DATABASE_URL")
        val config=if(url!=null) {
            require(url.startsWith("jdbc:postgresql://")) { "Explicit isolated PostgreSQL JDBC URL required" }
            AppConfig(url,System.getenv("EARTH_GEO_TEST_DATABASE_USER") ?: "postgres",System.getenv("EARTH_GEO_TEST_DATABASE_PASSWORD") ?: "",false,setOf("http://localhost"))
        } else {
            val pg=Postgres().also { it.start();postgres=it }
            AppConfig(pg.jdbcUrl,pg.username,pg.password,false,setOf("http://localhost"))
        }
        source=DatabaseFactory.create(config)
        // Exercise the deployed V61 -> V62 upgrade before any Earth fixtures exist.
        Flyway.configure().dataSource(source).locations("classpath:db/migration").target("61").load().migrate()
        val before=scalar("SELECT jsonb_agg(to_jsonb(h) ORDER BY installed_rank)::text FROM flyway_schema_history h")
        DatabaseFactory.migrate(source)
        assertEquals(before,scalar("SELECT jsonb_agg(to_jsonb(h) ORDER BY installed_rank)::text FROM flyway_schema_history h WHERE version::int<=61"))
        assertEquals("62",scalar("SELECT max(version::int) FROM flyway_schema_history"))
        repo=JdbcEarthLocationRepository(source)
    }
    @AfterAll fun close() { if(::source.isInitialized) source.close();postgres?.stop() }
    private fun execute(sql: String,vararg values: Any?)=source.connection.use { c ->
        c.prepareStatement(sql).use { s -> values.forEachIndexed { i,v -> s.setObject(i+1,v) };s.executeUpdate() }.also { c.commit() }
    }
    private fun scalar(sql: String,vararg values: Any?): String?=source.connection.use { c ->
        c.prepareStatement(sql).use { s -> values.forEachIndexed { i,v -> s.setObject(i+1,v) };s.executeQuery().use { r -> if(r.next()) r.getString(1) else null } }
    }
    private suspend fun account(): Account {
        val hash=tokens.issue().hash;val subject=UUID.randomUUID().toString();val auth=JdbcAuthRepository(source)
        val flow=LoginFlow(tokens.issue().hash,tokens.issue().hash,"vk","register",null,"Тест",null,"pkce",null,null)
        val id=auth.finish(flow,subject,hash,365,"Geo test")
        return Account(id,scalar("SELECT public_id FROM app_users WHERE id=?",id)!!,hash,subject)
    }
    private fun direct(a: Account,b: Account): UUID {
        val id=UUID.randomUUID()
        execute("INSERT INTO circles(id,kind,created_by_user_id,direct_user_low_id,direct_user_high_id) VALUES (?,'DIRECT',?,LEAST(?::uuid,?::uuid),GREATEST(?::uuid,?::uuid))",id,a.id,a.id,b.id,a.id,b.id)
        return id
    }
    private suspend fun enable(a: Account,circle: UUID,precision: String="APPROXIMATE",duration: Int?=60): EarthSharingSettings =
        repo.share(a.hash,EarthSharingWrite(a.publicId,repo.settings(a.hash).revision,"SHARING",precision,listOf(circle.toString()),duration))
    private fun fix(a: Account,settings: EarthSharingSettings,sequence: Long=1,captured: Instant=Instant.now())=
        EarthPositionWrite(a.publicId,settings.publicationEpoch!!,sequence,55.75555,37.61739,8.0,captured.toString())
    private suspend fun hidden(a: Account,mode: String="GHOST")=repo.share(a.hash,EarthSharingWrite(a.publicId,0,mode,"APPROXIMATE",emptyList(),null))
    private suspend fun rejected(code: String,action: suspend ()->Any) { assertEquals(code,assertFailsWith<AuthFailure> { action() }.code) }
    @Test fun `default off explicit recipient approximate storage and private latest only`()=runBlocking {
        val a=account();val b=account();val stranger=account();val circle=direct(a,b);direct(a,stranger)
        assertEquals("OFF",repo.settings(a.hash).mode);assertNull(repo.settings(a.hash).publicationEpoch)
        assertTrue(repo.people(b.hash).people.isEmpty())
        val settings=enable(a,circle);assertNotNull(settings.publicationEpoch);assertNull(repo.settings(a.hash).publicationEpoch)
        val request=fix(a,settings);val receipt=repo.publish(a.hash,request)
        val person=repo.people(b.hash).people.single()
        assertEquals(55.76,person.latitude);assertEquals(37.62,person.longitude);assertEquals(1500.0,person.accuracyMeters)
        assertEquals(a.publicId,person.user.publicId);assertTrue(repo.people(stranger.hash).people.isEmpty())
        assertEquals(120L,java.time.Duration.between(Instant.parse(person.updatedAt),Instant.parse(person.expiresAt)).seconds)
        assertEquals(receipt.expiresAt,person.expiresAt)
        assertEquals("1",scalar("SELECT count(*) FROM earth_latest_locations WHERE user_id=?",a.id))
        assertEquals("u",scalar("SELECT relpersistence FROM pg_class WHERE oid='earth_latest_locations'::regclass"))
    }
    @Test fun `ghost and off ignore stale revision and old enable cannot resurrect a point`()=runBlocking {
        val a=account();val b=account();val circle=direct(a,b);val settings=enable(a,circle,"PRECISE")
        repo.publish(a.hash,fix(a,settings))
        val mail=scalar("SELECT count(*) FROM player_mail_messages WHERE user_id=?",a.id)
        val notifications=scalar("SELECT count(*) FROM notification_events WHERE user_id=?",a.id)
        val ghost=hidden(a)
        assertEquals("GHOST",ghost.mode);assertEquals("PRECISE",ghost.precision);assertEquals(listOf(circle.toString()),ghost.recipientCircleIds)
        assertNull(ghost.publicationEpoch);assertTrue(repo.people(b.hash).people.isEmpty())
        assertEquals("0",scalar("SELECT count(*) FROM earth_latest_locations WHERE user_id=?",a.id))
        rejected("EARTH_PUBLICATION_CONFLICT") { repo.publish(a.hash,fix(a,settings,2)) }
        rejected("EARTH_REVISION_CONFLICT") { repo.share(a.hash,EarthSharingWrite(a.publicId,settings.revision,"SHARING","PRECISE",listOf(circle.toString()),60)) }
        assertEquals(mail,scalar("SELECT count(*) FROM player_mail_messages WHERE user_id=?",a.id))
        assertEquals(notifications,scalar("SELECT count(*) FROM notification_events WHERE user_id=?",a.id))
        assertTrue(hidden(a,"OFF").recipientCircleIds.isEmpty())
    }
    @Test fun `publisher session and scoped stop fence other browsers and delayed cleanup`()=runBlocking {
        val a=account();val b=account();val circle=direct(a,b);val first=enable(a,circle)
        val secondHash=tokens.issue().hash
        execute("INSERT INTO app_sessions(user_id,token_hash,expires_at) VALUES (?,?,clock_timestamp()+interval '1 day')",a.id,secondHash)
        rejected("EARTH_PUBLICATION_CONFLICT") { repo.publish(secondHash,fix(a,first)) }
        repo.publish(a.hash,fix(a,first))
        repo.stop(secondHash,EarthPositionStop(a.publicId,first.publicationEpoch!!))
        assertEquals(1,repo.people(b.hash).people.size)
        val second=enable(a,circle)
        repo.publish(a.hash,fix(a,second))
        repo.stop(a.hash,EarthPositionStop(a.publicId,first.publicationEpoch!!))
        assertEquals(1,repo.people(b.hash).people.size)
        repo.stop(a.hash,EarthPositionStop(a.publicId,second.publicationEpoch!!))
        assertTrue(repo.people(b.hash).people.isEmpty());assertEquals("SHARING",repo.settings(a.hash).mode)
        assertEquals(second.revision,repo.settings(a.hash).revision)
        rejected("EARTH_PUBLICATION_CONFLICT") { repo.publish(a.hash,fix(a,second,2)) }
    }
    @Test fun `single use fixes monotonic sequence upload cadence and capture age cannot renew TTL`()=runBlocking {
        val a=account();val b=account();val s=enable(a,direct(a,b));val request=fix(a,s)
        val receipt=repo.publish(a.hash,request)
        rejected("EARTH_PUBLICATION_CONFLICT") { repo.publish(a.hash,request) }
        rejected("EARTH_PUBLICATION_CONFLICT") { repo.publish(a.hash,request.copy(sequence=2)) }
        assertFailsWith<EarthRateLimited> { repo.publish(a.hash,request.copy(sequence=2,capturedAt=Instant.parse(request.capturedAt).plusSeconds(1).toString())) }
        assertEquals(receipt.expiresAt,repo.people(b.hash).people.single().expiresAt)
        execute("UPDATE earth_sharing_settings SET last_accepted_at=clock_timestamp()-interval '31 seconds' WHERE user_id=?",a.id)
        rejected("INVALID_EARTH_POSITION") { repo.publish(a.hash,request.copy(sequence=2,capturedAt=Instant.now().plusSeconds(11).toString())) }
        val newer=request.copy(sequence=2,capturedAt=Instant.now().plusSeconds(1).toString())
        repo.publish(a.hash,newer)
        assertEquals("1",scalar("SELECT count(*) FROM earth_latest_locations WHERE user_id=?",a.id))
        val old=account();val oldSettings=enable(old,direct(old,b))
        rejected("INVALID_EARTH_POSITION") { repo.publish(old.hash,fix(old,oldSettings,captured=Instant.now().minusSeconds(61))) }
    }
    @Test fun `expiry and duration hide synchronously and maintenance physically purges`()=runBlocking {
        val a=account();val b=account();val s=enable(a,direct(a,b));repo.publish(a.hash,fix(a,s))
        execute("UPDATE earth_latest_locations SET updated_at=updated_at-interval '121 seconds',expires_at=expires_at-interval '121 seconds' WHERE user_id=?",a.id)
        assertTrue(repo.people(b.hash).people.isEmpty());purgeEarthLocations(source)
        assertEquals("0",scalar("SELECT count(*) FROM earth_latest_locations WHERE user_id=?",a.id))
        val s2=enable(a,UUID.fromString(s.recipientCircleIds.single()));repo.publish(a.hash,fix(a,s2))
        execute("UPDATE earth_sharing_settings SET sharing_until=clock_timestamp()-interval '1 second' WHERE user_id=?",a.id)
        assertTrue(repo.people(b.hash).people.isEmpty());purgeEarthLocations(source)
        assertEquals("OFF",repo.settings(a.hash).mode);assertTrue(repo.settings(a.hash).recipientCircleIds.isEmpty())
        assertEquals("0",scalar("SELECT count(*) FROM earth_latest_locations WHERE user_id=?",a.id))
    }
    @Test fun `friend removal revokes both grants and readded relationship inherits nothing`()=runBlocking {
        val a=account();val b=account();val circle=direct(a,b);val s=enable(a,circle);val reverse=enable(b,circle)
        repo.publish(a.hash,fix(a,s));repo.publish(b.hash,fix(b,reverse))
        JdbcRelationshipRepository(source).removePerson(a.hash,circle)
        assertTrue(repo.settings(a.hash).revision>s.revision)
        assertTrue(repo.settings(b.hash).revision>reverse.revision)
        assertEquals("0",scalar("SELECT count(*) FROM earth_latest_locations WHERE user_id IN (?,?)",a.id,b.id))
        rejected("EARTH_PUBLICATION_CONFLICT") { repo.publish(a.hash,fix(a,s,2)) }
        assertTrue(repo.people(a.hash).people.isEmpty());assertTrue(repo.people(b.hash).people.isEmpty())
        assertEquals("0",scalar("SELECT count(*) FROM earth_sharing_recipients WHERE circle_id=?",circle))
        direct(a,b);assertTrue(repo.people(b.hash).people.isEmpty())
        rejected("INVALID_EARTH_SHARING") { enable(a,circle) }
    }
    @Test fun `session revocation ban and soft deletion physically clear and deny late updates`()=runBlocking {
        for(event in listOf("session","ban","delete")) {
            val a=account();val b=account();val s=enable(a,direct(a,b));repo.publish(a.hash,fix(a,s))
            when(event) {
                "session" -> execute("UPDATE app_sessions SET revoked_at=clock_timestamp() WHERE token_hash=?",a.hash)
                "ban" -> execute("UPDATE app_users SET banned_at=clock_timestamp() WHERE id=?",a.id)
                else -> execute("UPDATE app_users SET deleted_at=clock_timestamp() WHERE id=?",a.id)
            }
            assertTrue(repo.people(b.hash).people.isEmpty())
            assertEquals("0",scalar("SELECT count(*) FROM earth_latest_locations WHERE user_id=?",a.id))
            rejected("UNAUTHORIZED") { repo.publish(a.hash,fix(a,s,2)) }
        }
        for(column in listOf("banned_at","deleted_at")) {
            val a=account();val b=account();val s=enable(a,direct(a,b));repo.publish(a.hash,fix(a,s))
            execute("UPDATE app_users SET $column=clock_timestamp() WHERE id=?",b.id)
            assertTrue(repo.settings(a.hash).revision>s.revision)
            assertTrue(repo.settings(a.hash).recipientCircleIds.isEmpty())
            assertEquals("0",scalar("SELECT count(*) FROM earth_latest_locations WHERE user_id=?",a.id))
            rejected("EARTH_PUBLICATION_CONFLICT") { repo.publish(a.hash,fix(a,s,2)) }
        }
    }
    @Test fun `concurrent publish and ghost or friend removal cannot reopen access`()=runBlocking {
        for(mode in listOf("ghost","remove")) repeat(5) {
            val a=account();val b=account();val circle=direct(a,b);val s=enable(a,circle)
            val jobs=listOf(async(Dispatchers.Default) { runCatching { repo.publish(a.hash,fix(a,s)) } },async(Dispatchers.Default) {
                if(mode=="ghost") hidden(a) else JdbcRelationshipRepository(source).removePerson(a.hash,circle)
            })
            jobs.awaitAll()
            assertTrue(repo.people(b.hash).people.isEmpty())
            if(mode=="ghost") assertEquals("0",scalar("SELECT count(*) FROM earth_latest_locations WHERE user_id=?",a.id))
            else assertEquals("0",scalar("SELECT count(*) FROM earth_sharing_recipients WHERE circle_id=?",circle))
        }
    }
    @Test fun `real account merge revokes both publishers including kept session without transferring consent`()=runBlocking {
        val a=account();val b=account();val friend=account();val sa=enable(a,direct(a,friend));val sb=enable(b,direct(b,friend))
        repo.publish(a.hash,fix(a,sa));repo.publish(b.hash,fix(b,sb))
        val auth=JdbcAuthRepository(source);val browser=tokens.issue().hash
        for((role,owner) in listOf("current" to a,"other" to b)) {
            val flow=LoginFlow(tokens.issue().hash,browser,"vk","account",a.hash,null,null,"pkce",null,null,"merge",role)
            auth.create(flow);auth.recordAccountProof(auth.takeVk(flow.tokenHash,browser),owner.subject)
        }
        val preview=tokens.issue().hash;val choices=MergeChoices(providerChoices=mapOf("vk" to "current"))
        assertTrue(auth.previewMerge(a.hash,browser,choices,preview).conflicts.isEmpty())
        auth.confirmMerge(a.hash,browser,preview)
        assertTrue(repo.people(friend.hash).people.isEmpty());assertEquals("OFF",repo.settings(a.hash).mode)
        assertEquals("0",scalar("SELECT count(*) FROM earth_latest_locations WHERE user_id IN (?,?)",a.id,b.id))
        assertEquals("0",scalar("SELECT count(*) FROM earth_sharing_recipients WHERE owner_user_id IN (?,?)",a.id,b.id))
        rejected("EARTH_PUBLICATION_CONFLICT") { repo.publish(a.hash,fix(a,sa,2)) }
        rejected("UNAUTHORIZED") { repo.publish(b.hash,fix(b,sb,2)) }
    }
}
