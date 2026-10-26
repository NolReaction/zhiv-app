package ru.zhiv.db

import com.zaxxer.hikari.HikariDataSource
import kotlinx.coroutines.*
import org.flywaydb.core.Flyway
import org.junit.jupiter.api.AfterAll
import org.junit.jupiter.api.Assumptions
import org.junit.jupiter.api.BeforeAll
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.TestInstance
import org.testcontainers.DockerClientFactory
import org.testcontainers.containers.PostgreSQLContainer
import ru.zhiv.auth.*
import ru.zhiv.config.AppConfig
import ru.zhiv.earth.*
import ru.zhiv.security.TokenCodec
import java.time.Instant
import java.util.UUID
import kotlin.test.*

/** Real PostgreSQL only. Main backend CI requires this suite with zero skips.
 * BuildKit has no Docker daemon, so an unavailable Docker environment skips the
 * class unless an explicit isolated EARTH_GEO_TEST_DATABASE_URL is supplied.
 * Container startup, migration and SQL failures are never converted to skips.
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
            Assumptions.assumeTrue(runCatching { DockerClientFactory.instance().isDockerAvailable }.getOrDefault(false),
                "PostgreSQL integration requires Docker or EARTH_GEO_TEST_DATABASE_URL")
            val pg=Postgres().also { it.start();postgres=it }
            AppConfig(pg.jdbcUrl,pg.username,pg.password,false,setOf("http://localhost"))
        }
        source=DatabaseFactory.create(config)
        // Exercise V65 -> latest (V70) on an already published point; migration must not extend old retention.
        Flyway.configure().dataSource(source).locations("classpath:db/migration").target("65").load().migrate()
        repo=JdbcEarthLocationRepository(source)
        val legacy=runBlocking {
            val a=account();val b=account();val circle=direct(a,b);val epoch=UUID.randomUUID()
            execute("""INSERT INTO earth_sharing_settings(user_id,mode,revision,precision,sharing_until,publication_epoch,publisher_session_id)
                SELECT ?,'SHARING',1,'APPROXIMATE',clock_timestamp()+interval '1 hour',?,id FROM app_sessions WHERE token_hash=?""",a.id,epoch,a.hash)
            execute("INSERT INTO earth_sharing_recipients(owner_user_id,circle_id,recipient_user_id) VALUES (?,?,?)",a.id,circle,b.id)
            execute("""WITH moment AS (SELECT clock_timestamp() AS now)
                INSERT INTO earth_latest_locations(user_id,publication_epoch,latitude,longitude,accuracy_meters,precision,updated_at,expires_at,accepted_at)
                SELECT ?,?::uuid,55.75,37.62,1500,'APPROXIMATE',now,now+interval '120 seconds',now FROM moment""",a.id,epoch)
            Triple(a,b,scalar("SELECT updated_at::text || '/' || expires_at::text FROM earth_latest_locations WHERE user_id=?",a.id))
        }
        val before=scalar("SELECT jsonb_agg(to_jsonb(h) ORDER BY installed_rank)::text FROM flyway_schema_history h")
        DatabaseFactory.migrate(source)
        assertEquals(before,scalar("SELECT jsonb_agg(to_jsonb(h) ORDER BY installed_rank)::text FROM flyway_schema_history h WHERE version::int<=65"))
        assertEquals("78",scalar("SELECT max(version::int) FROM flyway_schema_history"))
        runBlocking {
            assertEquals(legacy.third,scalar("SELECT updated_at::text || '/' || expires_at::text FROM earth_latest_locations WHERE user_id=?",legacy.first.id),"upgrade preserves the original fix and deadline")
            assertEquals(1,repo.people(legacy.second.hash).people.size)
            assertTrue(repo.settings(legacy.first.hash).frozenCircleIds.isEmpty())
            assertEquals("APPROXIMATE",repo.settings(legacy.first.hash).precision,"new defaults do not rewrite existing consent")
            assertEquals("0",scalar("SELECT count(*) FROM earth_frozen_locations WHERE owner_user_id=?",legacy.first.id))
            assertEquals("1",scalar("SELECT count(*) FROM earth_latest_locations WHERE user_id=? AND publisher_session_id IS NOT NULL",legacy.first.id))
        }
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
    private suspend fun freeze(a: Account,frozen: List<UUID>,remaining: List<String>?=null): EarthSharingSettings {
        val current=repo.settings(a.hash)
        return repo.share(a.hash,EarthSharingWrite(a.publicId,current.revision,"SHARING",current.precision,
            remaining ?: current.recipientCircleIds,null,frozen.map { it.toString() },true))
    }
    private fun allowNextFix(a: Account) = execute(
        "UPDATE earth_sharing_settings SET last_accepted_at=clock_timestamp()-interval '31 seconds' WHERE user_id=?",a.id)

    @Test fun `new consent defaults precise and permanent without automatically selecting friends`()=runBlocking {
        val a=account();val b=account();val other=account();val circle=direct(a,b);direct(a,other)
        val defaults=repo.settings(a.hash)
        assertEquals("OFF",defaults.mode);assertEquals("PRECISE",defaults.precision)
        assertNull(defaults.sharingUntil);assertNull(defaults.publicationEpoch);assertTrue(defaults.recipientCircleIds.isEmpty())
        rejected("EARTH_PUBLICATION_CONFLICT") { repo.resume(a.hash,EarthSharingResume(a.publicId,defaults.revision)) }
        val grant=repo.share(a.hash,EarthSharingWrite(a.publicId,defaults.revision,"SHARING",defaults.precision,listOf(circle.toString()),null))
        repo.publish(a.hash,fix(a,grant))
        assertEquals(55.75555,repo.people(b.hash).people.single().latitude)
        assertNull(grant.sharingUntil);assertTrue(repo.people(other.hash).people.isEmpty())
        val privacyFirst=account()
        assertEquals("PRECISE",hidden(privacyFirst).precision,"materializing settings does not use the historical SQL default")
        assertEquals("PRECISE",scalar("SELECT precision FROM earth_sharing_settings WHERE user_id=?",privacyFirst.id))
    }
    @Test fun `resume rotates session bound lease without changing finite consent or frozen points`()=runBlocking {
        val a=account();val b=account();val d=account();val other=account()
        val ab=direct(a,b);val ad=direct(a,d);direct(a,other)
        val grant=repo.share(a.hash,EarthSharingWrite(a.publicId,0,"SHARING","APPROXIMATE",listOf(ab.toString(),ad.toString()),60))
        repo.publish(a.hash,fix(a,grant));val frozen=freeze(a,listOf(ab));val before=repo.people(b.hash).people
        repo.stop(a.hash,EarthPositionStop(a.publicId,grant.publicationEpoch!!))
        val secondHash=tokens.issue().hash
        execute("INSERT INTO app_sessions(user_id,token_hash,expires_at) VALUES (?,?,clock_timestamp()+interval '1 day')",a.id,secondHash)
        val resumed=repo.resume(secondHash,EarthSharingResume(a.publicId,frozen.revision))
        assertEquals(frozen.revision+1,resumed.revision);assertNotEquals(grant.publicationEpoch,resumed.publicationEpoch)
        assertEquals(grant.sharingUntil,resumed.sharingUntil);assertEquals("APPROXIMATE",resumed.precision)
        assertEquals(frozen.recipientCircleIds,resumed.recipientCircleIds);assertEquals(frozen.frozenCircleIds,resumed.frozenCircleIds)
        assertEquals(before,repo.people(b.hash).people);assertNull(repo.settings(a.hash).publicationEpoch)
        assertEquals(before.single().updatedAt,repo.people(d.hash).people.single().updatedAt,"lease rotation retains the original common capture")
        assertEquals(grant.publicationEpoch,scalar("SELECT publication_epoch::text FROM earth_latest_locations WHERE user_id=?",a.id))
        rejected("EARTH_REVISION_CONFLICT") { repo.resume(secondHash,EarthSharingResume(a.publicId,frozen.revision)) }
        rejected("EARTH_OWNER_MISMATCH") { repo.resume(b.hash,EarthSharingResume(a.publicId,resumed.revision)) }
        rejected("EARTH_PUBLICATION_CONFLICT") { repo.publish(a.hash,fix(a,resumed)) }
        repo.stop(a.hash,EarthPositionStop(a.publicId,grant.publicationEpoch!!))
        repo.publish(secondHash,fix(a,resumed).copy(latitude=56.2345))
        assertEquals(56.23,repo.people(d.hash).people.single().latitude);assertEquals(before,repo.people(b.hash).people)
        assertTrue(repo.people(other.hash).people.isEmpty());assertEquals(grant.sharingUntil,repo.settings(a.hash).sharingUntil)
    }
    @Test fun `resume requires unexpired active consent and explicit ghost exit never thaws recipients`()=runBlocking {
        val a=account();val b=account();val circle=direct(a,b);val grant=enable(a,circle)
        repo.publish(a.hash,fix(a,grant));val ghost=hidden(a)
        rejected("EARTH_PUBLICATION_CONFLICT") { repo.resume(a.hash,EarthSharingResume(a.publicId,ghost.revision)) }
        val resumed=repo.resume(a.hash,EarthSharingResume(a.publicId,ghost.revision,true))
        assertEquals("SHARING",resumed.mode);assertNotNull(resumed.publicationEpoch);assertEquals(grant.sharingUntil,resumed.sharingUntil)
        val frozen=freeze(a,listOf(circle));val before=repo.people(b.hash).people
        rejected("EARTH_PUBLICATION_CONFLICT") { repo.resume(a.hash,EarthSharingResume(a.publicId,frozen.revision)) }
        val frozenGhost=hidden(a)
        val noPublisher=repo.resume(a.hash,EarthSharingResume(a.publicId,frozenGhost.revision,true))
        assertEquals("SHARING",noPublisher.mode);assertNull(noPublisher.publicationEpoch)
        assertEquals(listOf(circle.toString()),noPublisher.frozenCircleIds);assertEquals(grant.sharingUntil,noPublisher.sharingUntil)
        assertEquals(before,repo.people(b.hash).people)
        val off=hidden(a,"OFF")
        rejected("EARTH_PUBLICATION_CONFLICT") { repo.resume(a.hash,EarthSharingResume(a.publicId,noPublisher.revision,true)) }
        rejected("EARTH_PUBLICATION_CONFLICT") { repo.resume(a.hash,EarthSharingResume(a.publicId,off.revision,true)) }
        val expired=enable(a,circle)
        execute("UPDATE earth_sharing_settings SET sharing_until=clock_timestamp()-interval '1 second' WHERE user_id=?",a.id)
        rejected("EARTH_PUBLICATION_CONFLICT") { repo.resume(a.hash,EarthSharingResume(a.publicId,expired.revision,true)) }
    }
    @Test fun `recipient addition preserves exact deadline precision ghost and old point privacy`()=runBlocking {
        val a=account();val b=account();val d=account();val ab=direct(a,b);val ad=direct(a,d)
        val grant=enable(a,ab,"PRECISE");repo.publish(a.hash,fix(a,grant));val before=repo.people(b.hash).people
        val ghost=hidden(a)
        val add=EarthSharingWrite(a.publicId,ghost.revision,"SHARING","PRECISE",listOf(ab.toString(),ad.toString()),480,preserveSharingUntil=true)
        val added=repo.share(a.hash,add)
        assertEquals("GHOST",added.mode);assertNull(added.publicationEpoch);assertEquals(grant.sharingUntil,added.sharingUntil)
        assertEquals(before,repo.people(b.hash).people);assertTrue(repo.people(d.hash).people.isEmpty())
        rejected("INVALID_EARTH_SHARING") { repo.share(a.hash,add.copy(expectedRevision=added.revision,precision="APPROXIMATE")) }
        rejected("INVALID_EARTH_SHARING") { repo.share(a.hash,add.copy(expectedRevision=added.revision,durationMinutes=null)) }
        rejected("INVALID_EARTH_SHARING") { repo.share(a.hash,add.copy(expectedRevision=added.revision,recipientCircleIds=listOf(ad.toString()))) }
        val resumed=repo.resume(a.hash,EarthSharingResume(a.publicId,added.revision,true))
        assertEquals(before,repo.people(b.hash).people);assertTrue(repo.people(d.hash).people.isEmpty(),"restoring old row must not bypass a new recipient capture fence")
        repo.publish(a.hash,fix(a,resumed,captured=Instant.now().plusMillis(1)))
        assertEquals(grant.sharingUntil,repo.people(d.hash).people.single().expiresAt)
        val expired=repo.settings(a.hash)
        execute("UPDATE earth_sharing_settings SET sharing_until=clock_timestamp()-interval '1 second' WHERE user_id=?",a.id)
        rejected("INVALID_EARTH_SHARING") { repo.share(a.hash,add.copy(expectedRevision=expired.revision)) }
    }
    @Test fun `default off explicit recipient approximate storage and private latest only`()=runBlocking {
        val a=account();val b=account();val stranger=account();val circle=direct(a,b);direct(a,stranger)
        assertEquals("OFF",repo.settings(a.hash).mode);assertNull(repo.settings(a.hash).publicationEpoch)
        assertTrue(repo.people(b.hash).people.isEmpty())
        val settings=enable(a,circle,duration=null);assertNotNull(settings.publicationEpoch);assertNull(repo.settings(a.hash).publicationEpoch)
        val request=fix(a,settings);val receipt=repo.publish(a.hash,request)
        val person=repo.people(b.hash).people.single()
        assertEquals(55.76,person.latitude);assertEquals(37.62,person.longitude);assertEquals(1500.0,person.accuracyMeters)
        assertEquals(a.publicId,person.user.publicId);assertTrue(repo.people(stranger.hash).people.isEmpty())
        assertEquals(86_400L,java.time.Duration.between(Instant.parse(person.updatedAt),Instant.parse(person.expiresAt)).seconds)
        assertEquals(receipt.expiresAt,person.expiresAt)
        assertEquals("1",scalar("SELECT count(*) FROM earth_latest_locations WHERE user_id=?",a.id))
        assertEquals("u",scalar("SELECT relpersistence FROM pg_class WHERE oid='earth_latest_locations'::regclass"))
    }
    @Test fun `ghost and off ignore stale revision and old enable cannot resurrect a point`()=runBlocking {
        val a=account();val b=account();val circle=direct(a,b);val settings=enable(a,circle,"PRECISE")
        repo.publish(a.hash,fix(a,settings))
        val before=repo.people(b.hash).people
        val mail=scalar("SELECT count(*) FROM player_mail_messages WHERE user_id=?",a.id)
        val notifications=scalar("SELECT count(*) FROM notification_events WHERE user_id=?",a.id)
        val ghost=hidden(a)
        assertEquals("GHOST",ghost.mode);assertEquals("PRECISE",ghost.precision);assertEquals(listOf(circle.toString()),ghost.recipientCircleIds)
        assertNull(ghost.publicationEpoch);assertEquals(before,repo.people(b.hash).people)
        assertEquals(settings.sharingUntil,ghost.sharingUntil)
        assertEquals("1",scalar("SELECT count(*) FROM earth_latest_locations WHERE user_id=?",a.id))
        rejected("EARTH_PUBLICATION_CONFLICT") { repo.publish(a.hash,fix(a,settings,2)) }
        rejected("EARTH_REVISION_CONFLICT") { repo.share(a.hash,EarthSharingWrite(a.publicId,settings.revision,"SHARING","PRECISE",listOf(circle.toString()),60)) }
        assertEquals(mail,scalar("SELECT count(*) FROM player_mail_messages WHERE user_id=?",a.id))
        assertEquals(notifications,scalar("SELECT count(*) FROM notification_events WHERE user_id=?",a.id))
        assertTrue(hidden(a,"OFF").recipientCircleIds.isEmpty())
        assertTrue(repo.people(b.hash).people.isEmpty())
        hidden(a)
        assertTrue(repo.people(b.hash).people.isEmpty(),"OFF to GHOST cannot restore a point or permission")
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
        assertEquals(1,repo.people(b.hash).people.size);assertEquals("SHARING",repo.settings(a.hash).mode)
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
        execute("UPDATE earth_latest_locations SET updated_at=updated_at-interval '86401 seconds',expires_at=expires_at-interval '86401 seconds' WHERE user_id=?",a.id)
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
        for(mode in listOf("SHARING","GHOST")) for(event in listOf("session","ban","delete")) {
            val a=account();val b=account();val s=enable(a,direct(a,b));repo.publish(a.hash,fix(a,s))
            if(mode=="GHOST") hidden(a)
            when(event) {
                "session" -> execute("UPDATE app_sessions SET revoked_at=clock_timestamp() WHERE token_hash=?",a.hash)
                "ban" -> execute("UPDATE app_users SET banned_at=clock_timestamp(),ban_reason='Earth privacy regression' WHERE id=?",a.id)
                else -> execute("UPDATE app_users SET deleted_at=clock_timestamp() WHERE id=?",a.id)
            }
            assertTrue(repo.people(b.hash).people.isEmpty())
            assertEquals("0",scalar("SELECT count(*) FROM earth_latest_locations WHERE user_id=?",a.id))
            rejected("UNAUTHORIZED") { repo.publish(a.hash,fix(a,s,2)) }
        }
        for(event in listOf("ban","delete")) {
            val a=account();val b=account();val s=enable(a,direct(a,b));repo.publish(a.hash,fix(a,s))
            if(event=="ban") execute("UPDATE app_users SET banned_at=clock_timestamp(),ban_reason='Earth privacy regression' WHERE id=?",b.id)
            else execute("UPDATE app_users SET deleted_at=clock_timestamp() WHERE id=?",b.id)
            assertTrue(repo.settings(a.hash).revision>s.revision)
            assertTrue(repo.settings(a.hash).recipientCircleIds.isEmpty())
            assertEquals("0",scalar("SELECT count(*) FROM earth_latest_locations WHERE user_id=?",a.id))
            rejected("EARTH_PUBLICATION_CONFLICT") { repo.publish(a.hash,fix(a,s,2)) }
        }
    }
    @Test fun `concurrent publish and ghost or friend removal cannot resume live sharing`()=runBlocking {
        for(mode in listOf("ghost","remove")) repeat(5) {
            val a=account();val b=account();val circle=direct(a,b);val s=enable(a,circle)
            val publication=async(Dispatchers.Default) { runCatching { repo.publish(a.hash,fix(a,s)) } }
            val privacy=async(Dispatchers.Default) {
                if(mode=="ghost") hidden(a) else JdbcRelationshipRepository(source).removePerson(a.hash,circle)
            }
            val published=publication.await().isSuccess
            privacy.await()
            if(mode=="ghost") {
                assertEquals("GHOST",repo.settings(a.hash).mode)
                assertNull(repo.settings(a.hash).publicationEpoch)
                assertEquals(if(published) 1 else 0,repo.people(b.hash).people.size,"only a fix committed before GHOST can remain")
                rejected("EARTH_PUBLICATION_CONFLICT") { repo.publish(a.hash,fix(a,s,2)) }
            } else {
                assertTrue(repo.people(b.hash).people.isEmpty())
                assertEquals("0",scalar("SELECT count(*) FROM earth_sharing_recipients WHERE circle_id=?",circle))
            }
        }
    }
    @Test fun `real account merge revokes both publishers including kept session without transferring consent`()=runBlocking {
        val a=account();val b=account();val friend=account();val sa=enable(a,direct(a,friend));val sb=enable(b,direct(b,friend))
        repo.publish(a.hash,fix(a,sa));repo.publish(b.hash,fix(b,sb))
        freeze(a,listOf(UUID.fromString(sa.recipientCircleIds.single())))
        freeze(b,listOf(UUID.fromString(sb.recipientCircleIds.single())))
        assertEquals("2",scalar("SELECT count(*) FROM earth_frozen_locations WHERE owner_user_id IN (?,?)",a.id,b.id))
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
        assertEquals("0",scalar("SELECT count(*) FROM earth_frozen_locations WHERE owner_user_id IN (?,?)",a.id,b.id))
        rejected("EARTH_PUBLICATION_CONFLICT") { repo.publish(a.hash,fix(a,sa,2)) }
        rejected("UNAUTHORIZED") { repo.publish(b.hash,fix(b,sb,2)) }
    }
    @Test fun `ghost and scoped pause preserve the same point without adding recipients or renewing time`()=runBlocking {
        val a=account();val b=account();val c=account();val ab=direct(a,b);val ac=direct(a,c)
        val shared=enable(a,ab,"PRECISE",null)
        assertTrue(repo.people(b.hash).people.isEmpty())
        repo.publish(a.hash,fix(a,shared))
        val point=repo.people(b.hash).people.single()
        repo.stop(a.hash,EarthPositionStop(a.publicId,shared.publicationEpoch!!))
        assertEquals(point,repo.people(b.hash).people.single())
        val command=EarthSharingWrite(a.publicId,0,"GHOST","APPROXIMATE",listOf(ac.toString()),480)
        repeat(2) {
            val frozen=repo.share(a.hash,command)
            assertNull(frozen.publicationEpoch);assertNull(frozen.sharingUntil)
            assertEquals(listOf(ab.toString()),frozen.recipientCircleIds)
            assertEquals(point,repo.people(b.hash).people.single())
            assertTrue(repo.people(c.hash).people.isEmpty())
        }
        rejected("EARTH_PUBLICATION_CONFLICT") { repo.publish(a.hash,fix(a,shared,2)) }
        val resumed=enable(a,ab,"PRECISE",null)
        assertTrue(repo.people(b.hash).people.isEmpty(),"new consent cannot reuse a pre-ghost fix")
        repo.publish(a.hash,fix(a,resumed))
        repo.stop(a.hash,EarthPositionStop(a.publicId,shared.publicationEpoch!!))
        assertEquals(1,repo.people(b.hash).people.size,"late stop is limited to the revoked epoch")
    }
    @Test fun `ghost keeps original timed consent and expiry and maintenance removes an expired frozen point`()=runBlocking {
        val a=account();val b=account();val shared=enable(a,direct(a,b),duration=60)
        repo.publish(a.hash,fix(a,shared))
        val point=repo.people(b.hash).people.single()
        assertEquals(shared.sharingUntil,point.expiresAt)
        val frozen=hidden(a)
        assertEquals(shared.sharingUntil,frozen.sharingUntil)
        assertEquals(point,repo.people(b.hash).people.single())
        execute("UPDATE earth_sharing_settings SET sharing_until=clock_timestamp()-interval '1 second' WHERE user_id=?",a.id)
        assertTrue(repo.people(b.hash).people.isEmpty())
        purgeEarthLocations(source)
        assertEquals("OFF",repo.settings(a.hash).mode)
        assertTrue(repo.settings(a.hash).recipientCircleIds.isEmpty())
        assertEquals("0",scalar("SELECT count(*) FROM earth_latest_locations WHERE user_id=?",a.id))
        hidden(a)
        assertTrue(repo.people(b.hash).people.isEmpty())
    }
    @Test fun `friend removal revokes a frozen point and no repeated ghost request can restore it`()=runBlocking {
        val a=account();val b=account();val circle=direct(a,b);val shared=enable(a,circle)
        repo.publish(a.hash,fix(a,shared));hidden(a)
        assertEquals(1,repo.people(b.hash).people.size)
        JdbcRelationshipRepository(source).removePerson(a.hash,circle)
        assertTrue(repo.people(b.hash).people.isEmpty())
        assertEquals("0",scalar("SELECT count(*) FROM earth_latest_locations WHERE user_id=?",a.id))
        direct(a,b);hidden(a)
        assertTrue(repo.people(b.hash).people.isEmpty())
        assertTrue(repo.settings(a.hash).recipientCircleIds.isEmpty())
    }

    @Test fun `one friend freezes while other recipients keep the same live epoch and no recipient sees a privacy flag`()=runBlocking {
        val a=account();val b=account();val c=account();val ab=direct(a,b);val ac=direct(a,c)
        val sharing=repo.share(a.hash,EarthSharingWrite(a.publicId,0,"SHARING","PRECISE",listOf(ab.toString(),ac.toString()),60))
        repo.publish(a.hash,fix(a,sharing))
        val before=repo.people(b.hash).people.single()
        val paused=freeze(a,listOf(ab))
        assertEquals(listOf(ab.toString()),paused.frozenCircleIds)
        assertNull(paused.publicationEpoch);assertEquals(sharing.sharingUntil,paused.sharingUntil)
        assertEquals(sharing.publicationEpoch,scalar("SELECT publication_epoch::text FROM earth_sharing_settings WHERE user_id=?",a.id))
        assertEquals(before,repo.people(b.hash).people.single())
        allowNextFix(a)
        repo.publish(a.hash,fix(a,sharing,2,Instant.now().plusSeconds(1)).copy(latitude=56.0,longitude=38.0))
        assertEquals(before,repo.people(b.hash).people.single(),"frozen friend never gets the later common fix")
        assertEquals(56.0,repo.people(c.hash).people.single().latitude)
        assertEquals("1",scalar("SELECT count(*) FROM earth_frozen_locations WHERE owner_user_id=?",a.id))
        assertEquals("u",scalar("SELECT relpersistence FROM pg_class WHERE oid='earth_frozen_locations'::regclass"))
        val publicJson=kotlinx.serialization.json.Json.encodeToString(EarthPeopleResponse.serializer(),repo.people(b.hash))
        assertFalse(publicJson.contains("frozen"));assertFalse(publicJson.contains("GHOST"))
        hidden(a)
        assertEquals(listOf(ab.toString()),repo.settings(a.hash).frozenCircleIds)
        assertEquals(before,repo.people(b.hash).people.single())
        assertEquals(56.0,repo.people(c.hash).people.single().latitude)
        rejected("EARTH_PUBLICATION_CONFLICT") { repo.publish(a.hash,fix(a,sharing,3)) }
    }
    @Test fun `unfreeze waits for a fresh capture and immediate refreeze cannot copy the hidden common point`()=runBlocking {
        val a=account();val b=account();val c=account();val ab=direct(a,b);val ac=direct(a,c)
        val sharing=repo.share(a.hash,EarthSharingWrite(a.publicId,0,"SHARING","PRECISE",listOf(ab.toString(),ac.toString()),null))
        repo.publish(a.hash,fix(a,sharing));freeze(a,listOf(ab))
        allowNextFix(a);repo.publish(a.hash,fix(a,sharing,2,Instant.now().plusSeconds(1)).copy(latitude=56.0))
        freeze(a,emptyList())
        assertTrue(repo.people(b.hash).people.isEmpty(),"restoring live cannot reveal a fix sent while this friend was frozen")
        freeze(a,listOf(ab))
        assertTrue(repo.people(b.hash).people.isEmpty(),"freeze cannot bypass the fresh-upload boundary")
        assertEquals("0",scalar("SELECT count(*) FROM earth_frozen_locations WHERE owner_user_id=?",a.id))
        freeze(a,emptyList())
        allowNextFix(a);repo.publish(a.hash,fix(a,sharing,3,Instant.now().plusSeconds(2)).copy(latitude=57.0))
        assertEquals(57.0,repo.people(b.hash).people.single().latitude)
        assertEquals(57.0,repo.people(c.hash).people.single().latitude)
    }
    @Test fun `a newly selected frozen friend never inherits a pre-consent point and existing frozen data survives a new epoch`()=runBlocking {
        val a=account();val b=account();val c=account();val ab=direct(a,b);val ac=direct(a,c)
        val initial=enable(a,ab,"PRECISE",60);repo.publish(a.hash,fix(a,initial))
        freeze(a,listOf(ab));val before=repo.people(b.hash).people.single()
        val current=repo.settings(a.hash)
        val next=repo.share(a.hash,EarthSharingWrite(a.publicId,current.revision,"SHARING","APPROXIMATE",
            listOf(ab.toString(),ac.toString()),480,listOf(ab.toString(),ac.toString())))
        assertEquals(before,repo.people(b.hash).people.single())
        assertTrue(repo.people(c.hash).people.isEmpty())
        repo.publish(a.hash,fix(a,next))
        assertEquals(before,repo.people(b.hash).people.single(),"original precision, timestamps and session stay on the snapshot")
        assertTrue(repo.people(c.hash).people.isEmpty(),"a new frozen grant does not read subsequent common fixes")
        freeze(a,listOf(ab))
        assertTrue(repo.people(c.hash).people.isEmpty())
        allowNextFix(a);repo.publish(a.hash,fix(a,next,2,Instant.now().plusSeconds(1)))
        assertEquals(1500.0,repo.people(c.hash).people.single().accuracyMeters)
    }
    @Test fun `narrow privacy writes cannot add recipients renew timed access resume ghost or survive stale CAS`()=runBlocking {
        val a=account();val b=account();val c=account();val ab=direct(a,b);val ac=direct(a,c)
        val sharing=enable(a,ab);repo.publish(a.hash,fix(a,sharing));freeze(a,listOf(ab))
        val current=repo.settings(a.hash)
        rejected("INVALID_EARTH_SHARING") { repo.share(a.hash,EarthSharingWrite(a.publicId,current.revision,"SHARING","PRECISE",
            listOf(ab.toString(),ac.toString()),null,listOf(ac.toString()),true)) }
        rejected("EARTH_REVISION_CONFLICT") { repo.share(a.hash,EarthSharingWrite(a.publicId,sharing.revision,"SHARING","PRECISE",
            listOf(ab.toString()),null,emptyList(),true)) }
        hidden(a)
        val ghost=freeze(a,listOf(ab))
        assertEquals("GHOST",ghost.mode);assertEquals(sharing.sharingUntil,ghost.sharingUntil)
        assertNull(ghost.publicationEpoch)
        assertEquals("0",scalar("SELECT count(*) FROM earth_sharing_settings WHERE user_id=? AND publication_epoch IS NOT NULL",a.id))
        rejected("EARTH_PUBLICATION_CONFLICT") { repo.publish(a.hash,fix(a,sharing,2)) }
        val off=freeze(a,emptyList(),emptyList())
        assertEquals("OFF",off.mode);assertTrue(off.recipientCircleIds.isEmpty());assertTrue(off.frozenCircleIds.isEmpty())
        assertEquals("0",scalar("SELECT count(*) FROM earth_frozen_locations WHERE owner_user_id=?",a.id))
        hidden(a)
        assertTrue(repo.people(b.hash).people.isEmpty())
    }
    @Test fun `removing one geo recipient preserves another live publisher and removing the final recipient revokes everything`()=runBlocking {
        val a=account();val b=account();val c=account();val ab=direct(a,b);val ac=direct(a,c)
        val sharing=repo.share(a.hash,EarthSharingWrite(a.publicId,0,"SHARING","PRECISE",listOf(ab.toString(),ac.toString()),60))
        repo.publish(a.hash,fix(a,sharing));freeze(a,listOf(ab))
        val removed=freeze(a,emptyList(),listOf(ac.toString()))
        assertEquals("SHARING",removed.mode);assertEquals(sharing.sharingUntil,removed.sharingUntil)
        assertEquals(listOf(ac.toString()),removed.recipientCircleIds)
        assertTrue(repo.people(b.hash).people.isEmpty());assertEquals(1,repo.people(c.hash).people.size)
        assertEquals("0",scalar("SELECT count(*) FROM earth_frozen_locations WHERE owner_user_id=?",a.id))
        allowNextFix(a);repo.publish(a.hash,fix(a,sharing,2,Instant.now().plusSeconds(1)).copy(latitude=56.0))
        assertEquals(56.0,repo.people(c.hash).people.single().latitude)
        freeze(a,emptyList(),emptyList())
        assertTrue(repo.people(c.hash).people.isEmpty())
        rejected("EARTH_PUBLICATION_CONFLICT") { repo.publish(a.hash,fix(a,sharing,3)) }
    }
    @Test fun `frozen snapshots expire at their own original deadline and are physically purged`()=runBlocking {
        val a=account();val b=account();val ab=direct(a,b);val sharing=enable(a,ab,"PRECISE",null)
        repo.publish(a.hash,fix(a,sharing));freeze(a,listOf(ab))
        val before=repo.people(b.hash).people.single()
        freeze(a,listOf(ab));assertEquals(before,repo.people(b.hash).people.single())
        execute("UPDATE earth_frozen_locations SET updated_at=updated_at-interval '86401 seconds',expires_at=expires_at-interval '86401 seconds' WHERE owner_user_id=?",a.id)
        assertTrue(repo.people(b.hash).people.isEmpty())
        purgeEarthLocations(source)
        assertEquals("0",scalar("SELECT count(*) FROM earth_frozen_locations WHERE owner_user_id=?",a.id))
        assertEquals(listOf(ab.toString()),repo.settings(a.hash).frozenCircleIds)
        assertTrue(repo.people(b.hash).people.isEmpty(),"expiration never falls back to a later common point")
    }
    @Test fun `frozen snapshots retain their originating session and lifecycle revocation removes them`()=runBlocking {
        for(event in listOf("session","friend","owner-ban","recipient-ban","owner-delete")) {
            val a=account();val b=account();val ab=direct(a,b);val sharing=enable(a,ab)
            repo.publish(a.hash,fix(a,sharing));freeze(a,listOf(ab));hidden(a)
            assertEquals(1,repo.people(b.hash).people.size)
            when(event) {
                "session" -> execute("UPDATE app_sessions SET revoked_at=clock_timestamp() WHERE token_hash=?",a.hash)
                "friend" -> JdbcRelationshipRepository(source).removePerson(a.hash,ab)
                "owner-ban" -> execute("UPDATE app_users SET banned_at=clock_timestamp(),ban_reason='Earth frozen regression' WHERE id=?",a.id)
                "recipient-ban" -> execute("UPDATE app_users SET banned_at=clock_timestamp(),ban_reason='Earth frozen regression' WHERE id=?",b.id)
                else -> execute("UPDATE app_users SET deleted_at=clock_timestamp() WHERE id=?",a.id)
            }
            if(event!="recipient-ban") assertTrue(repo.people(b.hash).people.isEmpty())
            assertEquals("0",scalar("SELECT count(*) FROM earth_frozen_locations WHERE owner_user_id=?",a.id))
        }
    }

    @Test fun `global OFF and GHOST cannot be weakened by a stale narrow edit flag`()=runBlocking {
        for(mode in listOf("OFF","GHOST")) {
            val a=account();val b=account();val ab=direct(a,b);val sharing=enable(a,ab)
            repo.publish(a.hash,fix(a,sharing));freeze(a,listOf(ab))
            val result=repo.share(a.hash,EarthSharingWrite(a.publicId,0,mode,"PRECISE",emptyList(),null,listOf(ab.toString()),true))
            assertEquals(mode,result.mode);assertNull(result.publicationEpoch)
            rejected("EARTH_PUBLICATION_CONFLICT") { repo.publish(a.hash,fix(a,sharing,2)) }
            if(mode=="OFF") {
                assertTrue(result.recipientCircleIds.isEmpty());assertTrue(result.frozenCircleIds.isEmpty())
                assertTrue(repo.people(b.hash).people.isEmpty())
                assertEquals("0",scalar("SELECT count(*) FROM earth_frozen_locations WHERE owner_user_id=?",a.id))
            } else {
                assertEquals(listOf(ab.toString()),result.frozenCircleIds)
                assertEquals(1,repo.people(b.hash).people.size)
            }
        }
    }

    @Test fun `shortened frozen consent is permanent and a later longer share cannot resurrect its previous deadline`()=runBlocking {
        val a=account();val b=account();val ab=direct(a,b);val sharing=enable(a,ab,"PRECISE",null)
        repo.publish(a.hash,fix(a,sharing));freeze(a,listOf(ab))
        val original=repo.people(b.hash).people.single()
        val current=repo.settings(a.hash)
        val shortened=repo.share(a.hash,EarthSharingWrite(a.publicId,current.revision,"SHARING","PRECISE",
            listOf(ab.toString()),60,listOf(ab.toString())))
        val shortPoint=repo.people(b.hash).people.single()
        assertEquals(original.updatedAt,shortPoint.updatedAt)
        assertEquals(shortened.sharingUntil,shortPoint.expiresAt)
        assertTrue(Instant.parse(shortPoint.expiresAt).isBefore(Instant.parse(original.expiresAt)))
        val extended=repo.share(a.hash,EarthSharingWrite(a.publicId,shortened.revision,"SHARING","PRECISE",
            listOf(ab.toString()),480,listOf(ab.toString())))
        assertTrue(Instant.parse(checkNotNull(extended.sharingUntil)).isAfter(Instant.parse(shortPoint.expiresAt)))
        assertEquals(shortPoint,repo.people(b.hash).people.single(),"later permission cannot widen an already tightened snapshot")
        assertEquals("1",scalar("SELECT count(*) FROM earth_frozen_locations WHERE owner_user_id=? AND expires_at=?::timestamptz",a.id,shortPoint.expiresAt))
        execute("UPDATE earth_frozen_locations SET updated_at=updated_at-interval '3601 seconds',expires_at=expires_at-interval '3601 seconds' WHERE owner_user_id=?",a.id)
        assertTrue(repo.people(b.hash).people.isEmpty(),"longer active consent cannot revive the expired old snapshot")
    }

    @Test fun `a fix captured before unfreeze stays hidden even when its new upload arrives after unfreeze`()=runBlocking {
        val a=account();val b=account();val c=account();val ab=direct(a,b);val ac=direct(a,c)
        val sharing=repo.share(a.hash,EarthSharingWrite(a.publicId,0,"SHARING","PRECISE",listOf(ab.toString(),ac.toString()),null))
        repo.publish(a.hash,fix(a,sharing,captured=Instant.now().minusSeconds(20)))
        freeze(a,listOf(ab))
        val late=fix(a,sharing,2,Instant.now().minusSeconds(10)).copy(latitude=56.0)
        val restored=freeze(a,emptyList())
        assertTrue(Instant.parse(late.capturedAt).isBefore(Instant.parse(restored.serverTime)))
        allowNextFix(a);repo.publish(a.hash,late)
        assertEquals(56.0,repo.people(c.hash).people.single().latitude,"live recipients continue to receive the valid monotonic upload")
        assertTrue(repo.people(b.hash).people.isEmpty(),"accepting an older capture after consent cannot satisfy a fresh-fix boundary")
        assertEquals("1",scalar("""SELECT count(*) FROM earth_latest_locations p JOIN earth_sharing_recipients g ON g.owner_user_id=p.user_id
            WHERE p.user_id=? AND g.circle_id=? AND p.updated_at<=g.live_after AND p.accepted_at>g.live_after""",a.id,ab))
        freeze(a,listOf(ab))
        assertTrue(repo.people(b.hash).people.isEmpty(),"refreeze cannot copy the delayed pre-consent capture")
        assertEquals("0",scalar("SELECT count(*) FROM earth_frozen_locations WHERE owner_user_id=?",a.id))
        freeze(a,emptyList())
        allowNextFix(a);repo.publish(a.hash,fix(a,sharing,3,Instant.now().plusSeconds(1)).copy(latitude=57.0))
        assertEquals(57.0,repo.people(b.hash).people.single().latitude)
    }

}
