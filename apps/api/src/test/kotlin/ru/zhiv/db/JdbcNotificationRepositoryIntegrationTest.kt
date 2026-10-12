package ru.zhiv.db

import com.zaxxer.hikari.HikariDataSource
import io.ktor.client.request.*
import io.ktor.http.*
import io.ktor.server.testing.testApplication
import kotlinx.coroutines.*
import kotlinx.serialization.encodeToString
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.TestInstance
import org.junit.jupiter.api.BeforeAll
import org.junit.jupiter.api.AfterAll
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.Assumptions
import org.testcontainers.DockerClientFactory
import org.testcontainers.containers.PostgreSQLContainer
import ru.zhiv.auth.AuthFailure
import ru.zhiv.config.AppConfig
import ru.zhiv.economy.*
import ru.zhiv.installZhivApi
import ru.zhiv.notifications.*
import ru.zhiv.security.TokenCodec
import java.time.Instant
import java.time.OffsetDateTime
import java.time.ZoneOffset
import java.util.Base64
import java.util.UUID
import java.util.concurrent.CopyOnWriteArrayList
import kotlin.test.*

@TestInstance(TestInstance.Lifecycle.PER_CLASS)
class JdbcNotificationRepositoryIntegrationTest {
    private class Postgres : PostgreSQLContainer<Postgres>("postgres:18-alpine")
    private var postgres: Postgres?=null
    private lateinit var source: HikariDataSource
    private lateinit var identities: JdbcZhivRepository
    private lateinit var repository: JdbcNotificationRepository
    private lateinit var config: AppConfig
    private val createdUsers=mutableListOf<UUID>()
    private val codec=TokenCodec()
    private val enabled=WebPushConfig("test-public","test-private","mailto:test@example.test")
    private val noQuiet=NotificationPreferences(quietHoursEnabled=false)
    private data class Player(val id: UUID,val owner: String,val hash: ByteArray,val raw: String,val session: UUID)
    @BeforeAll fun setup() {
        val url=System.getenv("TEST_DATABASE_URL")
        if(url==null) {
            Assumptions.assumeTrue(runCatching { DockerClientFactory.instance().isDockerAvailable }.getOrDefault(false),"PostgreSQL integration requires Docker or TEST_DATABASE_URL")
            postgres=Postgres().also { it.start() }
        }
        config=AppConfig(url ?: postgres!!.jdbcUrl,System.getenv("TEST_DATABASE_USER") ?: postgres?.username ?: "zhiv",
            System.getenv("TEST_DATABASE_PASSWORD") ?: postgres?.password ?: "zhiv",false,setOf("http://localhost"))
        source=DatabaseFactory.create(config)
        DatabaseFactory.migrate(source)
        identities=JdbcZhivRepository(source)
        repository=JdbcNotificationRepository(source,enabled)
    }
    @AfterEach fun cleanup() {
        if(::source.isInitialized) createdUsers.forEach { id ->
            listOf("notification_events","notification_batches","notification_subscriptions","notification_preferences").forEach { table ->
                execute("DELETE FROM $table WHERE user_id=?",id)
            }
        }
        createdUsers.clear()
    }
    @AfterAll fun close() { if(::source.isInitialized) source.close(); postgres?.stop() }
    private fun execute(sql: String,vararg args: Any?) = source.connection.use { c -> c.economyUpdate(sql,*args).also { c.commit() } }
    private fun scalar(sql: String,vararg args: Any?): String? = source.connection.use { c -> c.economyRows(sql,*args) { it.getString(1) }.firstOrNull() }
    private suspend fun player(): Player {
        val token=codec.issue()
        val user=identities.bootstrap("Мохлик",codec.issue().hash,token.hash,365)
        createdUsers.add(user.id)
        JdbcEconomyRepository(source).snapshot(token.hash)
        val session=UUID.fromString(scalar("SELECT id::text FROM app_sessions WHERE token_hash=?",token.hash))
        return Player(user.id,user.publicId,token.hash,token.raw,session)
    }
    private fun subscription(suffix: String=UUID.randomUUID().toString()): BrowserPushSubscription {
        val encoder=Base64.getUrlEncoder().withoutPadding()
        return BrowserPushSubscription("https://fcm.googleapis.com/fcm/send/$suffix",PushKeys(
            encoder.encodeToString(ByteArray(65).also { it[0]=4 }),encoder.encodeToString(ByteArray(16))))
    }
    private suspend fun connect(p: Player,prefs: NotificationPreferences=noQuiet): BrowserPushSubscription {
        repository.preferences(p.hash,p.owner,prefs)
        return subscription().also { repository.subscribe(p.hash,p.owner,it) }
    }
    private fun job(now: Instant,kind: String="production",target: String="workshop",finish: Instant=now.minusSeconds(1)) =
        EconomyJob(UUID.randomUUID().toString(),kind,target,startedAt=now.minusSeconds(300).toString(),finishesAt=finish.toString(),rewards=mapOf("wood" to 1))
    private fun jobs(p: Player,vararg jobs: EconomyJob) {
        val state=source.connection.use { readEconomyProfile(it,p.id).state }
        execute("UPDATE economy_profiles SET state=?::jsonb WHERE user_id=?",economyJson.encodeToString(state.copy(jobs=jobs.toList())),p.id)
    }
    private fun dispatcher(now: () -> Instant,sent: MutableList<PushPayload>,result: PushResult=PushResult.DELIVERED) =
        NotificationDispatcher(source,PushSender { _,payload -> sent.add(payload); result },now)
    private fun checkin(p: Player,at: Instant) {
        execute("""INSERT INTO check_ins(user_id,session_id,idempotency_key,checked_at,next_allowed_at,timezone_id,local_date)
            VALUES (?,?,?,?,?,'Europe/Moscow',?)""",p.id,p.session,UUID.randomUUID(),at.notificationSqlTime(),at.plusSeconds(30).notificationSqlTime(),at.atOffset(ZoneOffset.UTC).toLocalDate())
    }

    @Test fun `unconfigured server saves preferences but never pretends to subscribe`() = runBlocking<Unit> {
        val p=player(); val disabled=JdbcNotificationRepository(source)
        val view=disabled.snapshot(p.hash,p.owner)
        assertFalse(view.delivery.configured); assertFalse(view.subscription.subscribed)
        assertTrue(view.preferences.productionCompleted); assertFalse(view.preferences.checkinReminder)
        assertEquals("PUSH_NOT_CONFIGURED",assertFailsWith<AuthFailure> { disabled.subscribe(p.hash,p.owner,subscription()) }.code)
    }
    @Test fun `subscription is scoped to exact login session and another owner cannot take endpoint`() = runBlocking<Unit> {
        val a=player(); val b=player(); val sub=connect(a)
        assertTrue(repository.snapshot(a.hash,a.owner).subscription.subscribed)
        assertFalse(repository.snapshot(b.hash,b.owner).subscription.subscribed)
        assertEquals("NOTIFICATION_OWNER_CHANGED",assertFailsWith<AuthFailure> { repository.snapshot(a.hash,b.owner) }.code)
        assertEquals("PUSH_SUBSCRIPTION_CONFLICT",assertFailsWith<AuthFailure> { repository.subscribe(b.hash,b.owner,sub) }.code)
        repository.unsubscribe(b.hash,b.owner,sub.endpoint)
        assertTrue(repository.snapshot(a.hash,a.owner).subscription.subscribed)
        execute("UPDATE app_sessions SET revoked_at=clock_timestamp() WHERE id=?",a.session)
        assertEquals("0",scalar("SELECT count(*) FROM notification_subscriptions WHERE user_id=?",a.id))
        assertTrue(repository.subscribe(b.hash,b.owner,sub).subscription.subscribed)
    }
    @Test fun `existing live jobs materialize on consent and claimed jobs are removed atomically`() = runBlocking<Unit> {
        val p=player(); val now=Instant.now(); val j=job(now)
        jobs(p,j)
        assertEquals("0",scalar("SELECT count(*) FROM notification_events WHERE user_id=?",p.id))
        connect(p)
        assertEquals("1",scalar("SELECT count(*) FROM notification_events WHERE user_id=? AND category='production'",p.id))
        jobs(p)
        assertEquals("0",scalar("SELECT count(*) FROM notification_events WHERE user_id=?",p.id))
    }
    @Test fun `due jobs group into one spoiler-free push and unrelated saves do not repeat it`() = runBlocking<Unit> {
        val p=player(); connect(p); val now=Instant.now()
        val a=job(now,"exploration","fishing_short").copy(rewards=mapOf("fish_mythical_secret" to 1))
        val b=job(now,"construction","home")
        jobs(p,a,b,job(now))
        val sent=CopyOnWriteArrayList<PushPayload>(); val worker=dispatcher({now},sent)
        worker.tick(); worker.tick(); assertEquals(1,sent.size)
        assertContains(sent.single().body,"Мохлик вернулся"); assertContains(sent.single().body,"Стройка")
        assertFalse(sent.single().body.contains("mythical")); assertEquals(p.owner,sent.single().ownerPublicId)
        assertContains(sent.single().url,"owner=${p.owner}")
        jobs(p,a,b); repository.preferences(p.hash,p.owner,noQuiet.copy(maxPerDay=1)); worker.tick()
        assertEquals(1,sent.size)
    }
    @Test fun `garden only notifies after collection actually finishes`() = runBlocking<Unit> {
        val p=player(); connect(p); var now=Instant.now()
        val j=job(now,target="garden").copy(rewards=mapOf("berries" to 2),collection=EconomyCollection("berry_harvest",30,null,null))
        jobs(p,j); assertEquals("0",scalar("SELECT count(*) FROM notification_events WHERE user_id=?",p.id))
        val sent=CopyOnWriteArrayList<PushPayload>(); val worker=dispatcher({now},sent)
        jobs(p,j.copy(collection=EconomyCollection("berry_harvest",30,now.toString(),now.plusSeconds(30).toString())))
        worker.tick(); assertTrue(sent.isEmpty())
        now=now.plusSeconds(31); worker.tick(); assertEquals(1,sent.size)
    }
    @Test fun `cancel and construction speedup suppress pending reminders`() = runBlocking<Unit> {
        val p=player(); connect(p); val now=Instant.now()
        jobs(p,job(now,"construction","workshop"),job(now,"exploration","forest"))
        jobs(p) // Both real commands remove their job in the economy transaction.
        val sent=CopyOnWriteArrayList<PushPayload>(); dispatcher({now},sent).tick(); assertTrue(sent.isEmpty())
    }
    @Test fun `quiet hours and account budget defer rather than multiply device pushes`() = runBlocking<Unit> {
        val p=player(); var now=Instant.now().atOffset(ZoneOffset.UTC).withHour(23).withMinute(30).withSecond(0).toInstant()
        connect(p,noQuiet.copy(quietHoursEnabled=true,timeZone="UTC",quietStart="23:00",quietEnd="10:00"))
        jobs(p,job(now)); val sent=CopyOnWriteArrayList<PushPayload>(); val worker=dispatcher({now},sent)
        worker.tick(); assertTrue(sent.isEmpty())
        now=now.plusSeconds(11*3600); worker.tick(); assertEquals(1,sent.size)
        jobs(p,job(now)); worker.tick(); assertEquals(1,sent.size)
        now=now.plusSeconds(2*3600); worker.tick(); assertEquals(2,sent.size)
        jobs(p,job(now)); now=now.plusSeconds(2*3600); worker.tick(); assertEquals(2,sent.size)
    }
    @Test fun `presence suppresses notifications while playing instead of sending them after leaving`() = runBlocking<Unit> {
        val p=player(); connect(p); var now=Instant.now(); repository.presence(p.hash,p.owner)
        jobs(p,job(now)); val sent=CopyOnWriteArrayList<PushPayload>(); val worker=dispatcher({now},sent)
        worker.tick(); assertTrue(sent.isEmpty()); now=now.plusSeconds(300); worker.tick(); assertTrue(sent.isEmpty())
    }
    @Test fun `checkin reminder needs real event and strictly more than twenty four hours`() = runBlocking<Unit> {
        val p=player(); var now=Instant.now(); connect(p,noQuiet.copy(checkinReminder=true))
        val sent=CopyOnWriteArrayList<PushPayload>(); val worker=dispatcher({now},sent)
        worker.tick(); assertTrue(sent.isEmpty())
        checkin(p,now.minusSeconds(86400)); worker.tick(); assertTrue(sent.isEmpty())
        now=now.plusSeconds(2); worker.tick(); assertEquals(1,sent.size)
        assertContains(sent.single().url,"notification=checkin")
        now=now.plusSeconds(3*86400); worker.tick(); assertEquals(1,sent.size)
    }
    @Test fun `fresh checkin invalidates old queued reminder before send`() = runBlocking<Unit> {
        val p=player(); val now=Instant.now(); connect(p,noQuiet.copy(checkinReminder=true))
        checkin(p,now.minusSeconds(2*86400)); checkin(p,now.minusSeconds(60))
        val sent=CopyOnWriteArrayList<PushPayload>(); dispatcher({now},sent).tick(); assertTrue(sent.isEmpty())
        assertEquals("1",scalar("SELECT count(*) FROM notification_events WHERE user_id=? AND category='checkin'",p.id))
    }
    @Test fun `merged checkin history uses the newest real event across both identities`() = runBlocking<Unit> {
        val a=player(); val b=player(); val now=Instant.now()
        checkin(b,now.minusSeconds(60))
        connect(a,noQuiet.copy(checkinReminder=true))
        assertEquals("0",scalar("SELECT count(*) FROM notification_events WHERE user_id=?",a.id))
        execute("INSERT INTO account_merge_sources(source_user_id,target_user_id) VALUES (?,?)",b.id,a.id)
        assertEquals("1",scalar("SELECT count(*) FROM notification_events WHERE user_id=? AND category='checkin'",a.id))
        val sent=CopyOnWriteArrayList<PushPayload>(); dispatcher({now},sent).tick(); assertTrue(sent.isEmpty())
    }
    @Test fun `two workers serialize reservation and send one message`() = runBlocking<Unit> {
        val p=player(); connect(p); val now=Instant.now(); jobs(p,job(now))
        val sent=CopyOnWriteArrayList<PushPayload>(); val worker=dispatcher({now},sent)
        coroutineScope { List(2) { async(Dispatchers.IO) { worker.tick() } }.awaitAll() }
        assertEquals(1,sent.size)
    }
    @Test fun `provider expired subscription is removed and transient rejection has bounded retries`() = runBlocking<Unit> {
        val p=player(); connect(p); var now=Instant.now(); jobs(p,job(now))
        val sent=CopyOnWriteArrayList<PushPayload>(); val worker=dispatcher({now},sent,PushResult.RETRY)
        worker.tick(); now=now.plusSeconds(301); worker.tick(); now=now.plusSeconds(1801); worker.tick(); now=now.plusSeconds(3600); worker.tick()
        assertEquals(3,sent.size)
        jobs(p,job(now)); dispatcher({now},sent,PushResult.EXPIRED).tick()
        assertFalse(repository.snapshot(p.hash,p.owner).subscription.subscribed)
    }
    @Test fun `transport ambiguity is terminal and not retried after restart`() = runBlocking<Unit> {
        val p=player(); connect(p); var now=Instant.now(); jobs(p,job(now))
        val sent=CopyOnWriteArrayList<PushPayload>(); dispatcher({now},sent,PushResult.UNCERTAIN).tick()
        now=now.plusSeconds(4000); dispatcher({now},sent).tick(); assertEquals(1,sent.size)
        assertEquals("uncertain",scalar("SELECT state FROM notification_events WHERE user_id=?",p.id))
    }
    @Test fun `deleting account clears private preferences subscriptions and queued work`() = runBlocking<Unit> {
        val p=player(); connect(p); jobs(p,job(Instant.now()))
        execute("UPDATE app_users SET deleted_at=clock_timestamp(),updated_at=clock_timestamp() WHERE id=?",p.id)
        listOf("notification_preferences","notification_subscriptions","notification_events").forEach {
            assertEquals("0",scalar("SELECT count(*) FROM $it WHERE user_id=?",p.id))
        }
    }
    @Test fun `HTTP notification routes require session owner trusted origin and bounded body`() = testApplication {
        val p=runBlocking { player() }
        application { installZhivApi(identities,identities,config,codec,notifications=repository) }
        assertEquals(HttpStatusCode.Unauthorized,client.get("/api/v1/notifications?expectedOwnerPublicId=${p.owner}").status)
        val get=client.get("/api/v1/notifications?expectedOwnerPublicId=${p.owner}") { header(HttpHeaders.Cookie,"${config.cookieName}=${p.raw}") }
        assertEquals(HttpStatusCode.OK,get.status); assertEquals("no-store",get.headers[HttpHeaders.CacheControl])
        val write=client.put("/api/v1/notifications/preferences") {
            header(HttpHeaders.Cookie,"${config.cookieName}=${p.raw}");header(HttpHeaders.Origin,"https://evil.test")
            contentType(ContentType.Application.Json);setBody(notificationJson.encodeToString(NotificationPreferencesRequest(p.owner,noQuiet)))
        }
        assertEquals(HttpStatusCode.Forbidden,write.status)
        val large=client.post("/api/v1/notifications/subscriptions") {
            header(HttpHeaders.Cookie,"${config.cookieName}=${p.raw}");header(HttpHeaders.Origin,"http://localhost")
            contentType(ContentType.Application.Json);setBody("{\"large\":\""+"a".repeat(5000)+"\"}")
        }
        assertEquals(HttpStatusCode.PayloadTooLarge,large.status)
    }
}
