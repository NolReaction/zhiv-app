package ru.zhiv.db

import com.zaxxer.hikari.HikariDataSource
import io.ktor.client.request.*
import io.ktor.client.statement.bodyAsText
import io.ktor.http.*
import io.ktor.server.testing.testApplication
import kotlinx.coroutines.*
import kotlinx.serialization.encodeToString
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.AfterAll
import org.junit.jupiter.api.BeforeAll
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.Assumptions
import org.junit.jupiter.api.TestInstance
import org.testcontainers.DockerClientFactory
import org.testcontainers.containers.PostgreSQLContainer
import ru.zhiv.auth.AuthFailure
import ru.zhiv.auth.issueMobileToken
import ru.zhiv.config.AppConfig
import ru.zhiv.economy.*
import ru.zhiv.installZhivApi
import ru.zhiv.notifications.*
import ru.zhiv.security.TokenCodec
import java.time.Instant
import java.time.ZoneId
import java.time.temporal.ChronoUnit
import java.time.format.DateTimeFormatter
import java.util.UUID
import java.util.Base64
import java.util.concurrent.atomic.AtomicInteger
import kotlin.test.*

@TestInstance(TestInstance.Lifecycle.PER_CLASS)
class JdbcNativeNotificationRepositoryIntegrationTest {
    private class Postgres : PostgreSQLContainer<Postgres>("postgres:18-alpine")
    private var postgres: Postgres?=null
    private lateinit var source: HikariDataSource
    private lateinit var identities: JdbcZhivRepository
    private lateinit var repository: JdbcNativeNotificationRepository
    private lateinit var preferences: JdbcNotificationRepository
    private lateinit var config: AppConfig
    private val codec=TokenCodec()
    private val createdUsers=mutableListOf<UUID>()
    private val noQuiet=NotificationPreferences(quietHoursEnabled=false,rateLimitsEnabled=false,checkinReminder=true)
    private data class Player(val id: UUID,val owner: String,val hash: ByteArray,val raw: String,val session: UUID,val platform: String)
    @BeforeAll fun setup() {
        val url=System.getenv("TEST_DATABASE_URL")
        if(url==null) {
            Assumptions.assumeTrue(runCatching { DockerClientFactory.instance().isDockerAvailable }.getOrDefault(false),"PostgreSQL integration requires Docker or TEST_DATABASE_URL")
            postgres=Postgres().also { it.start() }
        }
        config=AppConfig(url ?: postgres!!.jdbcUrl,System.getenv("TEST_DATABASE_USER") ?: postgres?.username ?: "zhiv",
            System.getenv("TEST_DATABASE_PASSWORD") ?: postgres?.password ?: "zhiv",false,setOf("http://localhost"))
        source=DatabaseFactory.create(config); DatabaseFactory.migrate(source)
        identities=JdbcZhivRepository(source)
        repository=JdbcNativeNotificationRepository(source) { true }
        preferences=JdbcNotificationRepository(source)
    }
    @AfterEach fun cleanup() {
        if(::source.isInitialized) createdUsers.forEach { user ->
            listOf("native_notification_subscriptions","notification_subscriptions","notification_events","notification_batches","notification_preferences","player_mail_messages").forEach { table -> execute("DELETE FROM $table WHERE user_id=?",user) }
        }
        createdUsers.clear()
    }
    @AfterAll fun close() { if(::source.isInitialized) source.close(); postgres?.stop() }
    private fun execute(sql: String,vararg args: Any?) = source.connection.use { c -> c.economyUpdate(sql,*args).also { c.commit() } }
    private fun scalar(sql: String,vararg args: Any?): String? = source.connection.use { c -> c.economyRows(sql,*args) { it.getString(1) }.firstOrNull() }
    private suspend fun player(platform: String="ios"): Player {
        val raw=issueMobileToken(codec); val hash=codec.hash(raw)
        val user=identities.bootstrap("Мохлик",codec.issue().hash,hash,365)
        createdUsers.add(user.id)
        execute("UPDATE app_sessions SET mobile_platform=? WHERE token_hash=?",platform,hash)
        JdbcEconomyRepository(source).snapshot(hash)
        val session=UUID.fromString(scalar("SELECT id::text FROM app_sessions WHERE token_hash=?",hash))
        return Player(user.id,user.publicId,hash,raw,session,platform)
    }
    private fun nextSession(player: Player): Player {
        val raw=issueMobileToken(codec);val hash=codec.hash(raw);val id=UUID.randomUUID()
        execute("INSERT INTO app_sessions(id,user_id,token_hash,mobile_platform,expires_at) VALUES (?,?,?,?,clock_timestamp()+interval '1 day')",id,player.id,hash,player.platform)
        return player.copy(hash=hash,raw=raw,session=id)
    }
    private fun token(platform: String="ios") = if(platform=="ios") UUID.randomUUID().toString().replace("-", "").repeat(2) else "test:"+UUID.randomUUID()
    private suspend fun connect(player: Player,value: String=token(player.platform),prefs: NotificationPreferences=noQuiet): String {
        preferences.preferences(player.hash,player.owner,prefs)
        assertTrue(repository.subscribe(player.hash,player.owner,player.platform,value).subscription.subscribed)
        return value
    }
    private fun now(): Instant = Instant.now().truncatedTo(ChronoUnit.MICROS)
    private fun mail(player: Player,at: Instant): UUID {
        val id=UUID.randomUUID()
        source.connection.use { c ->
            c.economyUpdate("""INSERT INTO player_mail_messages(id,user_id,source_key,type,title,body,notify,created_at)
                VALUES (?,?,?,'event','Private title','Private financial correction and location',true,?)""",id,player.id,"test:$id",at.notificationSqlTime())
            enqueueMailNotification(c,player.id,id,at.notificationSqlTime()); c.commit()
        }
        return id
    }
    private fun worker(at: () -> Instant,sender: NativePushSender) = NotificationDispatcher(source,PushSender { _,_ -> error("Native-only account must not use Web Push") },at,
        nativeSender=sender,webConfigured=false)
    private fun checkin(player: Player,at: Instant) {
        execute("""INSERT INTO check_ins(user_id,session_id,idempotency_key,checked_at,next_allowed_at,timezone_id,local_date)
            VALUES (?,?,?,?,?,'Europe/Moscow',?)""",player.id,player.session,UUID.randomUUID(),at.notificationSqlTime(),at.plusSeconds(30).notificationSqlTime(),at.atZone(ZoneId.of("Europe/Moscow")).toLocalDate())
    }
    @Test fun `configuration owner platform and exact mobile session gate registration`() = runBlocking<Unit> {
        val a=player(); val b=player("android")
        val disabled=JdbcNativeNotificationRepository(source)
        assertFalse(disabled.snapshot(a.hash,a.owner,"ios").delivery.configured)
        assertEquals("NATIVE_PUSH_NOT_CONFIGURED",assertFailsWith<AuthFailure> { disabled.subscribe(a.hash,a.owner,"ios",token()) }.code)
        assertEquals("NOTIFICATION_OWNER_CHANGED",assertFailsWith<AuthFailure> { repository.subscribe(a.hash,b.owner,"ios",token()) }.code)
        assertEquals("NATIVE_PUSH_PLATFORM_MISMATCH",assertFailsWith<AuthFailure> { repository.subscribe(a.hash,a.owner,"android",token("android")) }.code)
        execute("UPDATE app_sessions SET mobile_platform=NULL WHERE id=?",a.session)
        assertEquals("NATIVE_PUSH_PLATFORM_MISMATCH",assertFailsWith<AuthFailure> { repository.snapshot(a.hash,a.owner,"ios") }.code)
        assertEquals("0",scalar("SELECT count(*) FROM native_notification_subscriptions WHERE user_id=?",a.id))
    }
    @Test fun `rotation is session scoped and stale or foreign owners cannot reclaim a device token`() = runBlocking<Unit> {
        val a=player();val b=player();val original=connect(a)
        assertEquals("NATIVE_PUSH_SUBSCRIPTION_CONFLICT",assertFailsWith<AuthFailure> { repository.subscribe(b.hash,b.owner,"ios",original) }.code)
        val rotated=token();repository.subscribe(a.hash,a.owner,"ios",rotated)
        assertEquals("1",scalar("SELECT count(*) FROM native_notification_subscriptions WHERE user_id=?",a.id))
        assertEquals(rotated,scalar("SELECT token FROM native_notification_subscriptions WHERE user_id=?",a.id))
        val newer=nextSession(a);repository.subscribe(newer.hash,newer.owner,"ios",rotated)
        assertFalse(repository.snapshot(a.hash,a.owner,"ios").subscription.subscribed)
        assertEquals("NATIVE_PUSH_SUBSCRIPTION_CONFLICT",assertFailsWith<AuthFailure> { repository.subscribe(a.hash,a.owner,"ios",rotated) }.code)
        repository.unsubscribe(a.hash,a.owner,"ios")
        assertTrue(repository.snapshot(newer.hash,newer.owner,"ios").subscription.subscribed)
        execute("UPDATE app_sessions SET revoked_at=clock_timestamp() WHERE id=?",newer.session)
        assertEquals("0",scalar("SELECT count(*) FROM native_notification_subscriptions WHERE user_id=?",a.id))
        assertTrue(repository.subscribe(b.hash,b.owner,"ios",rotated).subscription.subscribed)
    }
    @Test fun `new native registration schedules checkin and new generic mail but no game timers or past letters`() = runBlocking<Unit> {
        val p=player(); val at=now(); mail(p,at)
        checkin(p,at.minusSeconds(86402)); connect(p)
        val economy=source.connection.use { readEconomyProfile(it,p.id).state }
        val job=EconomyJob(UUID.randomUUID().toString(),"production","workshop",startedAt=at.minusSeconds(60).toString(),finishesAt=at.minusSeconds(1).toString(),rewards=mapOf("wood" to 1))
        execute("UPDATE economy_profiles SET state=?::jsonb WHERE user_id=?",economyJson.encodeToString(economy.copy(jobs=listOf(job))),p.id)
        assertEquals("1",scalar("SELECT count(*) FROM notification_events WHERE user_id=? AND category='checkin'",p.id))
        assertEquals("0",scalar("SELECT count(*) FROM notification_events WHERE user_id=? AND category IN ('production','mail')",p.id))
        mail(p,at)
        val sent=mutableListOf<PushPayload>();val worker=worker({at},NativePushSender { subscription,payload ->
            assertEquals("ios",subscription.platform);sent.add(payload);PushResult.DELIVERED
        })
        worker.tick();worker.tick()
        assertEquals(1,sent.size);val payload=sent.single()
        assertEquals(p.owner,payload.ownerPublicId)
        assertEquals("/?notification=mailbox&owner=${p.owner}",payload.url)
        assertNotNull(UUID.fromString(payload.tag))
        assertFalse(payload.body.contains("Private"));assertFalse(payload.title.contains("Private"))
        assertEquals("2",scalar("SELECT count(*) FROM notification_events WHERE user_id=? AND state='delivered'",p.id))
    }
    @Test fun `native mail honors categories quiet hours visibility and shared web budget`() = runBlocking<Unit> {
        val p=player();var at=now()
        connect(p,prefs=noQuiet.copy(administrationMessages=false));mail(p,at)
        val sent=mutableListOf<PushPayload>();val worker=worker({at},NativePushSender { _,payload -> sent.add(payload);PushResult.DELIVERED })
        worker.tick();assertTrue(sent.isEmpty())
        preferences.preferences(p.hash,p.owner,noQuiet.copy(rateLimitsEnabled=true,maxPerDay=1))
        // This row can represent a successful delivery to another browser device.
        execute("INSERT INTO notification_batches(id,user_id,reserved_at,state,finished_at) VALUES (?,?,?,'delivered',?)",UUID.randomUUID(),p.id,at.notificationSqlTime(),at.notificationSqlTime())
        mail(p,at);worker.tick();assertTrue(sent.isEmpty())
        at=at.plusSeconds(86400);worker.tick();assertEquals(1,sent.size)
        at=at.plusSeconds(1)
        val timeFormat=DateTimeFormatter.ofPattern("HH:mm").withZone(ZoneId.of("UTC"))
        preferences.preferences(p.hash,p.owner,noQuiet.copy(quietHoursEnabled=true,timeZone="UTC",
            quietStart=timeFormat.format(at.minusSeconds(3600)),quietEnd=timeFormat.format(at.plusSeconds(3600))))
        val quietMail=mail(p,at);worker.tick();assertEquals(1,sent.size)
        assertEquals("pending",scalar("SELECT state FROM notification_events WHERE user_id=? AND source_key=?",p.id,"mail:$quietMail"))
        preferences.preferences(p.hash,p.owner,noQuiet)
        execute("UPDATE notification_preferences SET last_visible_at=? WHERE user_id=?",at.notificationSqlTime(),p.id)
        worker.tick();assertEquals(1,sent.size)
        assertEquals("dismissed",scalar("SELECT state FROM notification_events WHERE user_id=? AND source_key=?",p.id,"mail:$quietMail"))
    }
    @Test fun `revocation read or owner ban between reservation and delivery prevents native send`() = runBlocking<Unit> {
        for(change in listOf("revoke","read","ban")) {
            val p=player();connect(p);val at=now();val id=mail(p,at);var clockCalls=0;var sends=0
            val worker=worker({
                if(++clockCalls==2) when(change) {
                    "revoke" -> execute("UPDATE app_sessions SET revoked_at=clock_timestamp() WHERE id=?",p.session)
                    "read" -> execute("UPDATE player_mail_messages SET read_at=clock_timestamp() WHERE id=?",id)
                    else -> execute("UPDATE app_users SET banned_at=clock_timestamp() WHERE id=?",p.id)
                }
                at
            },NativePushSender { _,_ -> sends++;PushResult.DELIVERED })
            worker.tick();assertEquals(0,sends,change);assertEquals(2,clockCalls)
        }
    }
    @Test fun `new checkin between reservation and native delivery replaces the old reminder`() = runBlocking<Unit> {
        val p=player();val at=now();checkin(p,at.minusSeconds(86402));connect(p)
        var calls=0;var sends=0
        worker({
            if(++calls==2) checkin(p,at)
            at
        },NativePushSender { _,_ -> sends++;PushResult.DELIVERED }).tick()
        assertEquals(2,calls);assertEquals(0,sends)
        assertEquals("1",scalar("SELECT count(*) FROM notification_events WHERE user_id=? AND category='checkin' AND state='pending' AND due_at>?::timestamptz",p.id,at.notificationSqlTime()))
    }
    @Test fun `native retries respect provider deadline and uncertain sends are never replayed`() = runBlocking<Unit> {
        val p=player("android");connect(p);var at=now();mail(p,at);var sends=0
        val deadline=at.plusSeconds(900)
        val sender=object : NativePushSender {
            override fun send(subscription: NativePushSubscription,payload: PushPayload): PushResult { sends++;return if(sends==1) PushResult.RETRY else PushResult.UNCERTAIN }
            override fun retryNotBefore(platform: String): Instant = deadline
        }
        val worker=worker({at},sender);worker.tick();assertEquals(1,sends)
        at=at.plusSeconds(899);worker.tick();assertEquals(1,sends)
        at=deadline;worker.tick();worker.tick();assertEquals(2,sends)
        assertEquals("uncertain",scalar("SELECT state FROM notification_events WHERE user_id=?",p.id))
        assertEquals("2",scalar("SELECT attempts::text FROM notification_events WHERE user_id=?",p.id))
    }
    @Test fun `dead native token is removed but provider configuration errors preserve registration`() = runBlocking<Unit> {
        for(result in listOf(PushResult.REJECTED,PushResult.EXPIRED)) {
            val p=player();connect(p);val at=now();mail(p,at)
            worker({at},NativePushSender { _,_ -> result }).tick()
            assertEquals(if(result==PushResult.EXPIRED) "0" else "1",scalar("SELECT count(*) FROM native_notification_subscriptions WHERE user_id=?",p.id))
        }
    }
    @Test fun `unconfigured provider defers without consuming attempts and expired session is removed`() = runBlocking<Unit> {
        val p=player();connect(p);var at=now();mail(p,at)
        val worker=NotificationDispatcher(source,PushSender { _,_ -> error("No configured transport") },{at},webConfigured=false)
        worker.tick()
        assertEquals("pending",scalar("SELECT state FROM notification_events WHERE user_id=?",p.id))
        assertEquals("0",scalar("SELECT attempts::text FROM notification_events WHERE user_id=?",p.id))
        // Preserve session time constraints while expiring it.
        execute("UPDATE app_sessions SET created_at=clock_timestamp()-interval '2 days',last_seen_at=clock_timestamp()-interval '1 day',expires_at=clock_timestamp()-interval '1 hour' WHERE id=?",p.session)
        at=at.plusSeconds(301);worker.tick()
        assertEquals("0",scalar("SELECT count(*) FROM native_notification_subscriptions WHERE user_id=?",p.id))
        assertEquals("dismissed",scalar("SELECT state FROM notification_events WHERE user_id=?",p.id))
        assertEquals("UNAUTHORIZED",assertFailsWith<AuthFailure> { repository.snapshot(p.hash,p.owner,p.platform) }.code)
    }
    @Test fun `two workers share a single native reservation and delivery`() = runBlocking<Unit> {
        val p=player();connect(p);val at=now();mail(p,at);val sent=AtomicInteger()
        val sender=NativePushSender { _,_ -> sent.incrementAndGet();PushResult.DELIVERED }
        coroutineScope { listOf(worker({at},sender),worker({at},sender)).map { dispatcher ->
            async(Dispatchers.IO) { dispatcher.tick() }
        }.awaitAll() }
        assertEquals(1,sent.get())
        assertEquals("1",scalar("SELECT count(*) FROM notification_batches WHERE user_id=? AND state='delivered'",p.id))
    }
    @Test fun `web and native subscriptions share a five device account limit`() = runBlocking<Unit> {
        val p=player();connect(p)
        repeat(4) { connect(nextSession(p)) }
        val sixth=nextSession(p)
        assertEquals("PUSH_DEVICE_LIMIT",assertFailsWith<AuthFailure> { repository.subscribe(sixth.hash,sixth.owner,"ios",token()) }.code)
        val encoder=Base64.getUrlEncoder().withoutPadding()
        val web=JdbcNotificationRepository(source,WebPushConfig("test-public","test-private","mailto:test@example.test"))
        val subscription=BrowserPushSubscription("https://fcm.googleapis.com/fcm/send/${UUID.randomUUID()}",
            PushKeys(encoder.encodeToString(ByteArray(65).also { it[0]=4 }),encoder.encodeToString(ByteArray(16))))
        assertEquals("PUSH_DEVICE_LIMIT",assertFailsWith<AuthFailure> { web.subscribe(sixth.hash,sixth.owner,subscription) }.code)
        repository.unsubscribe(p.hash,p.owner,p.platform)
        assertTrue(web.subscribe(sixth.hash,sixth.owner,subscription).subscription.subscribed)
        assertEquals("PUSH_DEVICE_LIMIT",assertFailsWith<AuthFailure> { repository.subscribe(p.hash,p.owner,"ios",token()) }.code)
    }
    @Test fun `native routes reject cookies and cross platform requests and never disclose tokens`() = runBlocking<Unit> {
        val p=player();val value=token()
        testApplication {
            application { installZhivApi(identities,identities,config,tokenCodec=codec,
                notifications=preferences,nativeNotifications=repository) }
            val endpoint="/api/v1/notifications/native?expectedOwnerPublicId=${p.owner}&platform=ios"
            val cookie=client.get(endpoint) { header(HttpHeaders.Cookie,"${config.cookieName}=${p.raw}") }
            assertEquals(HttpStatusCode.Unauthorized,cookie.status)
            val mismatched=client.get(endpoint.replace("platform=ios","platform=android")) { bearerAuth(p.raw) }
            assertEquals(HttpStatusCode.Conflict,mismatched.status)
            val response=client.post("/api/v1/notifications/native/subscriptions") {
                bearerAuth(p.raw);contentType(ContentType.Application.Json)
                setBody(notificationJson.encodeToString(NativeNotificationSubscribeRequest(p.owner,"ios",value)))
            }
            assertEquals(HttpStatusCode.OK,response.status)
            assertEquals("no-store",response.headers[HttpHeaders.CacheControl])
            assertFalse(response.bodyAsText().contains(value))
            val removed=client.delete("/api/v1/notifications/native/subscriptions") {
                bearerAuth(p.raw);contentType(ContentType.Application.Json)
                setBody(notificationJson.encodeToString(NativeNotificationUnsubscribeRequest(p.owner,"ios")))
            }
            assertEquals(HttpStatusCode.OK,removed.status)
            assertFalse(repository.snapshot(p.hash,p.owner,"ios").subscription.subscribed)
            val android=player("android")
            val longestToken="A".repeat(4096)
            val large=client.post("/api/v1/notifications/native/subscriptions") {
                bearerAuth(android.raw);contentType(ContentType.Application.Json)
                setBody(notificationJson.encodeToString(NativeNotificationSubscribeRequest(android.owner,"android",longestToken)))
            }
            assertEquals(HttpStatusCode.OK,large.status,"Native body limit accepts the entire documented token range")
            val invalid=client.post("/api/v1/notifications/native/subscriptions") {
                bearerAuth(android.raw);contentType(ContentType.Application.Json)
                setBody(notificationJson.encodeToString(NativeNotificationSubscribeRequest(android.owner,"android",longestToken+"A")))
            }
            assertEquals(HttpStatusCode.BadRequest,invalid.status)
            assertFalse(invalid.bodyAsText().contains(longestToken))
        }
    }
}
