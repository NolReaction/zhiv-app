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
import ru.zhiv.world.WorldJourney
import ru.zhiv.world.WorldResources
import ru.zhiv.world.WorldState
import ru.zhiv.world.worldJson
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
    private val noQuiet=NotificationPreferences(quietHoursEnabled=false,rateLimitsEnabled=true)
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
    private fun legacyJourney(p: Player,finishedAt: Instant) {
        val journey=WorldJourney(UUID.randomUUID().toString(),"first_path",finishedAt.minusSeconds(60).toString(),
            finishedAt.toString(),WorldResources(),emptyList(),true,3)
        val state=worldJson.encodeToString(WorldState(journeys=listOf(journey)))
        execute("""INSERT INTO world_profiles(user_id,state) VALUES (?,?::jsonb)
            ON CONFLICT(user_id) DO UPDATE SET state=jsonb_set(world_profiles.state,'{journeys}',EXCLUDED.state->'journeys')""",p.id,state)
    }
    private fun dispatcher(now: () -> Instant,sent: MutableList<PushPayload>,result: PushResult=PushResult.DELIVERED) =
        NotificationDispatcher(source,PushSender { _,payload -> sent.add(payload); result },now)
    private fun checkin(p: Player,at: Instant) {
        execute("""INSERT INTO check_ins(user_id,session_id,idempotency_key,checked_at,next_allowed_at,timezone_id,local_date)
            VALUES (?,?,?,?,?,'Europe/Moscow',?)""",p.id,p.session,UUID.randomUUID(),at.notificationSqlTime(),at.plusSeconds(30).notificationSqlTime(),at.atOffset(ZoneOffset.UTC).toLocalDate())
    }

    @Test fun `unconfigured server saves preferences but never pretends to subscribe`() = runBlocking<Unit> {
        val p=player(); val disabled=JdbcNotificationRepository(source)
        assertEquals("0",scalar("SELECT count(*) FROM notification_preferences WHERE user_id=?",p.id))
        val view=disabled.snapshot(p.hash,p.owner)
        assertFalse(view.delivery.configured); assertFalse(view.subscription.subscribed)
        assertTrue(view.preferences.productionCompleted); assertFalse(view.preferences.checkinReminder)
        assertFalse(view.preferences.rateLimitsEnabled); assertTrue(view.preferences.quietHoursEnabled)
        assertEquals("false",scalar("SELECT preferences->>'rateLimitsEnabled' FROM notification_preferences WHERE user_id=?",p.id))
        assertFalse(JdbcNotificationRepository(source).snapshot(p.hash,p.owner).preferences.rateLimitsEnabled)
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
        assertEquals("Новости полянки",sent.single().title)
        assertContains(sent.single().body,"Мохлик вернулся"); assertContains(sent.single().body,"Стройка")
        assertFalse(sent.single().body.contains("mythical")); assertEquals(p.owner,sent.single().ownerPublicId)
        assertContains(sent.single().url,"owner=${p.owner}")
        jobs(p,a,b); repository.preferences(p.hash,p.owner,noQuiet.copy(maxPerDay=1)); worker.tick()
        assertEquals(1,sent.size)
    }
    @Test fun `ripe berries notify before collection and collection never repeats the same source`() = runBlocking<Unit> {
        val p=player(); connect(p); var now=Instant.now()
        val j=job(now,target="garden").copy(rewards=mapOf("berries" to 20),collection=EconomyCollection("berry_harvest",30,null,null))
        jobs(p,j); assertEquals("1",scalar("SELECT count(*) FROM notification_events WHERE user_id=?",p.id))
        val sent=CopyOnWriteArrayList<PushPayload>(); val worker=dispatcher({now},sent)
        worker.tick(); assertEquals(1,sent.size)
        assertEquals("Ресурсы готовы",sent.single().title); assertContains(sent.single().body,"20 ягод готовы к сбору")
        jobs(p,j.copy(collection=EconomyCollection("berry_harvest",30,now.toString(),now.plusSeconds(30).toString())))
        worker.tick(); assertEquals(1,sent.size)
        now=now.plusSeconds(31); worker.tick(); assertEquals(1,sent.size)
    }
    @Test fun `collection started before first delivery shifts reminder to actual collection finish`() = runBlocking<Unit> {
        val p=player(); connect(p); var now=Instant.now()
        val j=job(now,target="garden").copy(rewards=mapOf("berries" to 20),collection=EconomyCollection("berry_harvest",30,null,null))
        jobs(p,j)
        jobs(p,j.copy(collection=EconomyCollection("berry_harvest",30,now.toString(),now.plusSeconds(30).toString())))
        val sent=CopyOnWriteArrayList<PushPayload>(); val worker=dispatcher({now},sent)
        worker.tick(); assertTrue(sent.isEmpty())
        now=now.plusSeconds(31); worker.tick(); assertEquals(1,sent.size)
        assertContains(sent.single().body,"Урожай собран"); assertContains(sent.single().body,"20 ягод")
        assertFalse(sent.single().body.contains("готовы к сбору"))
    }
    @Test fun `ripe berry reminder waits for travelling actor while garden fiber and cooking are immediately actionable`() = runBlocking<Unit> {
        val p=player(); connect(p,noQuiet.copy(rateLimitsEnabled=false)); var now=Instant.now()
        val crop=job(now,target="garden",finish=now.minusSeconds(172800)).copy(rewards=mapOf("berries" to 20),collection=EconomyCollection("berry_harvest",8,null,null))
        val trip=job(now,"exploration","forest",now.plusSeconds(600))
        val fiber=job(now,target="garden").copy(recipeId="garden_fiber",rewards=mapOf("fiber" to 3))
        val cooking=job(now,target="dryer").copy(rewards=mapOf("dried_berries" to 2))
        jobs(p,crop,trip,fiber,cooking)
        val sent=CopyOnWriteArrayList<PushPayload>(); val worker=dispatcher({now},sent)
        worker.tick(); assertEquals(1,sent.size); assertFalse(sent.single().body.contains("готовы к сбору"))
        assertEquals("pending",scalar("SELECT state FROM notification_events WHERE user_id=? AND source_key=?",p.id,"job:${crop.id}"))
        assertEquals("0",scalar("SELECT attempts FROM notification_events WHERE user_id=? AND source_key=?",p.id,"job:${crop.id}"))
        now=now.plusSeconds(601); worker.tick(); assertEquals(2,sent.size)
        assertContains(sent.last().body,"Мохлик вернулся"); assertContains(sent.last().body,"20 ягод")
        assertEquals("delivered",scalar("SELECT state FROM notification_events WHERE user_id=? AND source_key=?",p.id,"job:${crop.id}"))
    }
    @Test fun `another completed unclaimed harvest defers ripe crop without consuming attempts or losing its source`() = runBlocking<Unit> {
        val p=player(); connect(p,noQuiet.copy(rateLimitsEnabled=false)); var now=Instant.now()
        val crop=job(now,target="garden").copy(rewards=mapOf("berries" to 20),collection=EconomyCollection("berry_harvest",8,null,null))
        val collected=crop.copy(id=UUID.randomUUID().toString(),collection=EconomyCollection("berry_harvest",8,
            now.minusSeconds(30).toString(),now.minusSeconds(22).toString()))
        jobs(p,crop,collected)
        val sent=CopyOnWriteArrayList<PushPayload>(); val worker=dispatcher({now},sent)
        worker.tick(); assertEquals(1,sent.size); assertContains(sent.single().body,"Урожай собран")
        assertEquals("0",scalar("SELECT attempts FROM notification_events WHERE user_id=? AND source_key=?",p.id,"job:${crop.id}"))
        jobs(p,crop); now=now.plusSeconds(301); worker.tick()
        assertEquals(2,sent.size); assertContains(sent.last().body,"20 ягод готовы к сбору")
    }
    @Test fun `legacy world journey keeps ripe berries pending until removed even after its recorded finish`() = runBlocking<Unit> {
        val p=player(); connect(p,noQuiet.copy(rateLimitsEnabled=false)); var now=Instant.now()
        legacyJourney(p,now.minusSeconds(1))
        val crop=job(now,target="garden").copy(rewards=mapOf("berries" to 20),collection=EconomyCollection("berry_harvest",8,null,null))
        jobs(p,crop); val sent=CopyOnWriteArrayList<PushPayload>(); val worker=dispatcher({now},sent)
        worker.tick(); assertTrue(sent.isEmpty())
        assertEquals("0",scalar("SELECT count(*) FROM notification_batches WHERE user_id=?",p.id))
        execute("UPDATE world_profiles SET state=jsonb_set(state,'{journeys}','[]'::jsonb) WHERE user_id=?",p.id)
        now=now.plusSeconds(301); worker.tick(); assertEquals(1,sent.size)
    }
    @Test fun `actor starts travelling between reservation and delivery so ripe notification is postponed`() = runBlocking<Unit> {
        val p=player(); connect(p,noQuiet.copy(rateLimitsEnabled=false)); var now=Instant.now()
        val crop=job(now,target="garden").copy(rewards=mapOf("berries" to 20),collection=EconomyCollection("berry_harvest",8,null,null))
        jobs(p,crop); var calls=0; val sent=CopyOnWriteArrayList<PushPayload>()
        val worker=dispatcher({
            if(++calls==2) jobs(p,crop,job(now,"exploration","forest",now.plusSeconds(600)))
            now
        },sent)
        worker.tick(); assertTrue(sent.isEmpty())
        assertEquals("pending",scalar("SELECT state FROM notification_events WHERE user_id=? AND source_key=?",p.id,"job:${crop.id}"))
        assertEquals("0",scalar("SELECT attempts FROM notification_events WHERE user_id=? AND source_key=?",p.id,"job:${crop.id}"))
        now=now.plusSeconds(601); worker.tick(); assertEquals(1,sent.size); assertContains(sent.single().body,"20 ягод")
    }
    @Test fun `claim between reservation and delivery suppresses stale payload and releases batch`() = runBlocking<Unit> {
        val p=player(); connect(p); val now=Instant.now(); jobs(p,job(now))
        var calls=0; val sent=CopyOnWriteArrayList<PushPayload>()
        dispatcher({ if(++calls==2) jobs(p); now },sent).tick()
        assertTrue(sent.isEmpty()); assertEquals("0",scalar("SELECT count(*) FROM notification_events WHERE user_id=?",p.id))
        assertEquals("dismissed",scalar("SELECT state FROM notification_batches WHERE user_id=?",p.id))
    }
    @Test fun `harvest held over a day by collection or legacy journey becomes fresh once and remains deduplicated`() = runBlocking<Unit> {
        listOf(false,true).forEach { legacy ->
            val p=player(); connect(p,noQuiet.copy(rateLimitsEnabled=false)); var now=Instant.now()
            val crop=job(now,target="garden",finish=now.minusSeconds(3*86400)).copy(rewards=mapOf("berries" to 20),collection=EconomyCollection("berry_harvest",8,null,null))
            val blocker=crop.copy(id=UUID.randomUUID().toString(),collection=EconomyCollection("berry_harvest",8,
                now.minusSeconds(2*86400+8).toString(),now.minusSeconds(2*86400).toString()))
            if(legacy) legacyJourney(p,now.minusSeconds(2*86400))
            jobs(p,*if(legacy) arrayOf(crop) else arrayOf(crop,blocker))
            // An existing waiting row wakes after the long hold. It must not
            // expire according to the old growth timer while actor-owned.
            execute("UPDATE notification_events SET next_attempt_at=? WHERE user_id=?",now.minusSeconds(1).notificationSqlTime(),p.id)
            val sent=CopyOnWriteArrayList<PushPayload>(); val worker=dispatcher({now},sent)
            worker.tick(); assertTrue(sent.isEmpty())
            assertEquals("pending",scalar("SELECT state FROM notification_events WHERE user_id=? AND source_key=?",p.id,"job:${crop.id}"))
            assertEquals("0",scalar("SELECT attempts FROM notification_events WHERE user_id=? AND source_key=?",p.id,"job:${crop.id}"))
            if(legacy) execute("UPDATE world_profiles SET state=jsonb_set(state,'{journeys}','[]'::jsonb) WHERE user_id=?",p.id)
            else jobs(p,crop)
            now=Instant.now().plusSeconds(1); worker.tick()
            assertEquals(1,sent.size); assertContains(sent.single().body,"20 ягод готовы к сбору")
            val available=scalar("SELECT harvest_ready_at::text FROM notification_events WHERE user_id=? AND source_key=?",p.id,"job:${crop.id}")
            assertNotNull(available)
            now=now.plusSeconds(90000); worker.tick(); jobs(p,crop); worker.tick()
            assertEquals(1,sent.size); assertEquals(available,scalar("SELECT harvest_ready_at::text FROM notification_events WHERE user_id=? AND source_key=?",p.id,"job:${crop.id}"))
        }
    }
    @Test fun `claiming returned trip between reservation and send cannot regress harvest freshness to old ripening`() = runBlocking<Unit> {
        val p=player(); connect(p,noQuiet.copy(rateLimitsEnabled=false)); val now=Instant.now()
        val crop=job(now,target="garden",finish=now.minusSeconds(2*86400)).copy(rewards=mapOf("berries" to 20),collection=EconomyCollection("berry_harvest",8,null,null))
        jobs(p,crop,job(now,"exploration","forest",now.minusSeconds(1)))
        var calls=0; val sent=CopyOnWriteArrayList<PushPayload>()
        dispatcher({ if(++calls==2) jobs(p,crop); now },sent).tick()
        assertEquals(1,sent.size); assertContains(sent.single().body,"20 ягод готовы к сбору")
        assertEquals("Ресурсы готовы",sent.single().title)
    }
    @Test fun `cancelling active trip makes old ripe harvest actionable without waiting for the cancelled deadline`() = runBlocking<Unit> {
        val p=player(); connect(p,noQuiet.copy(rateLimitsEnabled=false)); var now=Instant.now()
        val crop=job(now,target="garden",finish=now.minusSeconds(2*86400)).copy(rewards=mapOf("berries" to 20),collection=EconomyCollection("berry_harvest",8,null,null))
        jobs(p,crop,job(now,"exploration","forest",now.plusSeconds(3600))); jobs(p,crop)
        now=Instant.now().plusSeconds(1); val sent=CopyOnWriteArrayList<PushPayload>(); dispatcher({now},sent).tick()
        assertEquals(1,sent.size); assertContains(sent.single().body,"20 ягод готовы к сбору")
    }
    @Test fun `free old harvest expires and rechecking a fresh harvest does not extend its age indefinitely`() = runBlocking<Unit> {
        val p=player(); connect(p,noQuiet.copy(rateLimitsEnabled=false)); var now=Instant.now()
        val crop=job(now,target="garden",finish=now.minusSeconds(2*86400)).copy(rewards=mapOf("berries" to 20),collection=EconomyCollection("berry_harvest",8,null,null))
        jobs(p,crop); val sent=CopyOnWriteArrayList<PushPayload>(); val worker=dispatcher({now},sent,PushResult.RETRY)
        worker.tick(); assertTrue(sent.isEmpty()); assertEquals("dismissed",scalar("SELECT state FROM notification_events WHERE user_id=?",p.id))
        val fresh=crop.copy(id=UUID.randomUUID().toString(),finishesAt=now.minusSeconds(1).toString())
        jobs(p,fresh); worker.tick(); assertEquals(1,sent.size)
        val available=scalar("SELECT harvest_ready_at::text FROM notification_events WHERE user_id=?",p.id)
        now=now.plusSeconds(86401); worker.tick(); assertEquals(1,sent.size)
        assertEquals("dismissed",scalar("SELECT state FROM notification_events WHERE user_id=?",p.id))
        assertEquals(available,scalar("SELECT harvest_ready_at::text FROM notification_events WHERE user_id=?",p.id))
    }
    @Test fun `payload quantities use latest saved job at send rather than reservation snapshot or current recipe`() = runBlocking<Unit> {
        val p=player(); connect(p); val now=Instant.now()
        val j=job(now,target="garden").copy(recipeId="garden_fiber",rewards=mapOf("fiber" to 17)); jobs(p,j)
        var calls=0; val sent=CopyOnWriteArrayList<PushPayload>()
        dispatcher({ if(++calls==2) jobs(p,j.copy(rewards=mapOf("fiber" to 23))); now },sent).tick()
        assertEquals(1,sent.size); assertContains(sent.single().body,"23"); assertFalse(sent.single().body.contains("17"))
    }
    @Test fun `production summary warns when combined rewards exceed warehouse space including both escrows`() = runBlocking<Unit> {
        val p=player(); connect(p); val now=Instant.now()
        val state=source.connection.use { readEconomyProfile(it,p.id).state }
        val capacity=EconomyRules.storage(state).capacity
        execute("UPDATE economy_profiles SET state=?::jsonb WHERE user_id=?",economyJson.encodeToString(state.copy(inventory=mapOf("wood" to capacity-10))),p.id)
        execute("INSERT INTO economy_market_listings(id,seller_id,item_id,quantity,total_price) VALUES (?,?,'wood',3,10)",UUID.randomUUID(),p.id)
        execute("INSERT INTO economy_barter_offers(id,seller_id,offered_item_id,requested_item_id) VALUES (?,?,'ancient_coin','moon_shard')",UUID.randomUUID(),p.id)
        val crop=job(now,target="garden").copy(rewards=mapOf("berries" to 4),collection=EconomyCollection("berry_harvest",8,null,null))
        jobs(p,crop,job(now).copy(rewards=mapOf("planks" to 3)))
        val sent=CopyOnWriteArrayList<PushPayload>(); dispatcher({now},sent).tick()
        assertEquals(1,sent.size); assertContains(sent.single().body,"Освободите место в кладовой")
        assertFalse(sent.single().body.contains("Можно забрать")); assertFalse(sent.single().body.contains("чтобы Мохлик собрал"))
    }
    @Test fun `cancel and construction speedup suppress pending reminders`() = runBlocking<Unit> {
        val p=player(); connect(p); val now=Instant.now()
        jobs(p,job(now,"construction","workshop"),job(now,"exploration","forest"))
        jobs(p) // Both real commands remove their job in the economy transaction.
        val sent=CopyOnWriteArrayList<PushPayload>(); dispatcher({now},sent).tick(); assertTrue(sent.isEmpty())
    }
    @Test fun `quiet hours and account budget defer rather than multiply device pushes`() = runBlocking<Unit> {
        // Whole seconds are deliberate: PostgreSQL stores microseconds while
        // Instant.now() may retain nanos and round a budget boundary upwards.
        val p=player(); var now=Instant.parse("2026-10-12T23:30:00Z")
        connect(p,noQuiet.copy(quietHoursEnabled=true,timeZone="UTC",quietStart="23:00",quietEnd="10:00"))
        jobs(p,job(now)); val sent=CopyOnWriteArrayList<PushPayload>(); val worker=dispatcher({now},sent)
        worker.tick(); assertTrue(sent.isEmpty())
        now=Instant.parse("2026-10-13T09:59:59Z"); worker.tick(); assertTrue(sent.isEmpty())
        now=now.plusSeconds(1); worker.tick(); assertEquals(1,sent.size)
        jobs(p,job(now)); worker.tick(); assertEquals(1,sent.size)
        now=now.plusSeconds(2*3600-1); worker.tick(); assertEquals(1,sent.size)
        now=now.plusSeconds(1); worker.tick(); assertEquals(2,sent.size)
        jobs(p,job(now)); now=now.plusSeconds(2*3600); worker.tick(); assertEquals(2,sent.size)
        now=Instant.parse("2026-10-14T09:59:59Z"); worker.tick(); assertEquals(2,sent.size)
        now=now.plusSeconds(1); worker.tick(); assertEquals(3,sent.size)
    }
    @Test fun `presence suppresses notifications while playing instead of sending them after leaving`() = runBlocking<Unit> {
        val p=player(); connect(p); var now=Instant.now(); repository.presence(p.hash,p.owner)
        jobs(p,job(now)); val sent=CopyOnWriteArrayList<PushPayload>(); val worker=dispatcher({now},sent)
        worker.tick(); assertTrue(sent.isEmpty()); now=now.plusSeconds(300); worker.tick(); assertTrue(sent.isEmpty())
    }
    @Test fun `disabling frequency releases deferred work bypasses both budgets and survives reload`() = runBlocking<Unit> {
        val p=player(); connect(p); var now=Instant.now()
        val sent=CopyOnWriteArrayList<PushPayload>(); val worker=dispatcher({now},sent)
        jobs(p,job(now)); worker.tick(); assertEquals(1,sent.size)
        jobs(p,job(now)); worker.tick(); assertEquals(1,sent.size)
        val allEvents=noQuiet.copy(rateLimitsEnabled=false)
        assertFalse(repository.preferences(p.hash,p.owner,allEvents).preferences.rateLimitsEnabled)
        assertEquals(allEvents,JdbcNotificationRepository(source,enabled).snapshot(p.hash,p.owner).preferences)
        // Saving preferences resets retries to the real DB clock, so the test
        // clock must also move beyond that save even on a slow CI database.
        now=maxOf(now.plusSeconds(1),Instant.now().plusSeconds(1)); worker.tick(); assertEquals(2,sent.size)
        jobs(p,job(now)); worker.tick(); assertEquals(3,sent.size)
        repository.preferences(p.hash,p.owner,noQuiet)
        jobs(p,job(now)); worker.tick(); assertEquals(3,sent.size)
        assertEquals("pending",scalar("SELECT state FROM notification_events WHERE user_id=?",p.id))
    }
    @Test fun `disabled frequency still respects independent quiet hours and does not repeat a source`() = runBlocking<Unit> {
        val p=player(); var now=Instant.parse("2026-10-12T23:30:00Z")
        connect(p,noQuiet.copy(rateLimitsEnabled=false,quietHoursEnabled=true,timeZone="UTC",quietStart="23:00",quietEnd="10:00"))
        jobs(p,job(now)); val sent=CopyOnWriteArrayList<PushPayload>(); val worker=dispatcher({now},sent)
        worker.tick(); assertTrue(sent.isEmpty())
        now=Instant.parse("2026-10-13T10:00:00Z"); worker.tick(); assertEquals(1,sent.size)
        worker.tick(); assertEquals(1,sent.size)
        jobs(p,job(now)); worker.tick(); assertEquals(2,sent.size)
        jobs(p,job(now)); worker.tick(); assertEquals(3,sent.size)
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
