package ru.zhiv.db

import com.zaxxer.hikari.HikariDataSource
import io.ktor.client.request.*
import io.ktor.client.statement.bodyAsText
import io.ktor.http.*
import io.ktor.server.testing.testApplication
import kotlinx.coroutines.*
import kotlinx.serialization.json.*
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
import ru.zhiv.admin.AdminAnalyticsQuery
import ru.zhiv.admin.AdminAnalyticsEventsQuery
import ru.zhiv.admin.AdminPlayerCommand
import ru.zhiv.economy.*
import ru.zhiv.identity.PlayerTag
import ru.zhiv.auth.AuthFailure
import ru.zhiv.config.AppConfig
import ru.zhiv.installZhivApi
import ru.zhiv.security.TokenCodec
import java.sql.SQLException
import java.time.LocalDate
import java.time.OffsetDateTime
import java.time.ZoneOffset
import java.util.UUID
import kotlin.test.*

@Testcontainers(disabledWithoutDocker = true)
@TestInstance(TestInstance.Lifecycle.PER_CLASS)
class JdbcAdminRepositoryIntegrationTest {
    private class Postgres(image: String) : PostgreSQLContainer<Postgres>(image)
    companion object { @Container private val postgres = Postgres("postgres:18-alpine") }
    private lateinit var source: HikariDataSource
    private lateinit var identities: JdbcZhivRepository
    private lateinit var config: AppConfig
    private val tokens = TokenCodec()
    private data class User(val id: UUID, val publicId: String, val hash: ByteArray, val raw: String)
    @BeforeAll fun setup() {
        config = AppConfig(postgres.jdbcUrl, postgres.username, postgres.password, false, setOf("http://localhost"))
        source = DatabaseFactory.create(config)
        DatabaseFactory.migrate(source)
        identities = JdbcZhivRepository(source)
    }
    @AfterAll fun close() { source.close() }
    @BeforeEach fun clear() { execute("TRUNCATE app_users CASCADE") }
    private fun execute(sql: String, vararg values: Any?): Int = source.connection.use { c ->
        c.prepareStatement(sql).use { s ->
            values.forEachIndexed { i, value -> s.setObject(i + 1, value) }; s.executeUpdate()
        }.also { c.commit() }
    }
    private fun scalar(sql: String, vararg values: Any?): String? = source.connection.use { c ->
        c.prepareStatement(sql).use { s ->
            values.forEachIndexed { i, value -> s.setObject(i + 1, value) }
            s.executeQuery().use { r -> if (r.next()) r.getString(1) else null }
        }
    }
    private suspend fun user(name: String = "Участник"): User {
        val token = tokens.issue()
        val snapshot = identities.bootstrap(name, tokens.issue().hash, token.hash, 365)
        return User(snapshot.id, snapshot.publicId, token.hash, token.raw)
    }
    private fun repository(vararg admins: User) = JdbcAdminRepository(source, AdminConfig(admins.map { it.publicId }.toSet()))
    private fun extraSession(user: User): ByteArray = tokens.issue().hash.also {
        execute("INSERT INTO app_sessions(user_id,token_hash,expires_at) VALUES (?,?,clock_timestamp()+interval '1 year')", user.id, it)
    }
    private fun created(user: User, day: LocalDate) {
        execute("UPDATE app_users SET created_at=? WHERE id=?", day.atTime(12, 0).atOffset(ZoneOffset.UTC), user.id)
    }
    private fun checkIn(user: User, day: LocalDate, timeZone: String = "UTC") {
        val at = day.atTime(12, 30).atOffset(ZoneOffset.UTC)
        execute("""
            INSERT INTO check_ins(user_id,session_id,idempotency_key,checked_at,next_allowed_at,timezone_id,local_date)
            SELECT user_id,id,?, ?, ? + interval '30 seconds',?, (? AT TIME ZONE ?)::date
            FROM app_sessions WHERE token_hash=?
        """.trimIndent(), UUID.randomUUID(), at, at, timeZone, at, timeZone, user.hash)
    }

    private fun analyticsEntry(
        player: User, kind: String, at: String, coins: Long = 0, pearls: Long = 0,
        items: Map<String, Long> = emptyMap(), target: String? = null, quantity: Long = 1,
        currencyScale: Int = 10, pearlScale: Int = 50, requestId: UUID = UUID.randomUUID(),
    ): UUID {
        if (target != null) {
            val command = EconomyCommand(requestId.toString(), player.publicId, 0, kind, target, quantity)
            execute("""INSERT INTO economy_commands(user_id,request_id,signature,message,accepted_revision,created_at)
                VALUES (?,?,?,'Private command receipt',1,?::timestamptz)""",
                player.id, requestId, economyJson.encodeToString(command), at)
        }
        execute("""INSERT INTO economy_ledger(user_id,source_key,kind,coins,pearls,items,currency_scale,pearl_scale,created_at)
            VALUES (?,?,?,?,?,?::jsonb,?,?,?::timestamptz)""",
            player.id, "command:$requestId", kind, coins, pearls, economyJson.encodeToString(items), currencyScale, pearlScale, at)
        return requestId
    }

    @Test fun `analytics separate escrow and passive receipts while normalizing every historic currency leg`() = runBlocking<Unit> {
        val admin = user("Администратор"); val peerAdmin = user("Второй администратор")
        val active = user("Покупатель"); val passive = user("Продавец"); val retired = user("Удалённый")
        val repo = repository(admin, peerAdmin)
        val at = "2020-01-02T12:00:00Z"
        analyticsEntry(active,"sell",at,coins=3,pearls=2,items=mapOf("wood" to -2L),target="wood",currencyScale=1,pearlScale=1)
        analyticsEntry(active,"buy_fishing_item",at,coins=-20,pearls=-7,items=mapOf("bait" to 1L),target="bait")
        analyticsEntry(active,"market_create",at,items=mapOf("wood" to -5L))
        analyticsEntry(active,"market_cancel",at,items=mapOf("wood" to 3L))
        analyticsEntry(active,"barter_create",at,items=mapOf("living_resin" to -1L))
        analyticsEntry(active,"barter_cancel",at,items=mapOf("living_resin" to 1L))
        analyticsEntry(passive,"market_sell",at,coins=40)
        analyticsEntry(passive,"barter_exchange",at,items=mapOf("moon_crystal" to 1L))
        // A V40-era pearl receipt must use its own denomination, independently of coins.
        analyticsEntry(passive,"market_sell",at,coins=10,pearls=3,currencyScale=10,pearlScale=10)
        for (kind in listOf("legacy_conversion","account_merge","merged_receipt",
            "dev_grant_currency","dev_grant_item","dev_set_building_level")) {
            analyticsEntry(active,kind,"2019-01-01T00:00:00Z",coins=999_999)
            analyticsEntry(active,kind,at,coins=999_999)
        }
        analyticsEntry(admin,"sell",at,coins=900,target="wood")
        analyticsEntry(peerAdmin,"sell",at,coins=800,target="wood")
        analyticsEntry(retired,"sell",at,coins=700,target="wood")
        execute("UPDATE app_users SET deleted_at=clock_timestamp() WHERE id=?",retired.id)
        val query = AdminAnalyticsQuery(from="2020-01-02",to="2020-01-04")
        val ledgerBefore = scalar("SELECT jsonb_agg(to_jsonb(e) ORDER BY user_id,source_key)::text FROM economy_ledger e")
        val report = repo.analytics(admin.hash,query)
        assertEquals(1L,report.summary.activePlayers)
        assertEquals(9L,report.summary.events)
        assertEquals(1L,report.summary.spendingPlayers)
        val resources = report.resources.associateBy { it.resourceId }
        assertEquals(80L,resources.getValue("coins").received)
        assertEquals(20L,resources.getValue("coins").spent)
        assertEquals(60L,resources.getValue("coins").net)
        assertEquals(115L,resources.getValue("pearls").received)
        assertEquals(7L,resources.getValue("pearls").spent)
        assertEquals(108L,resources.getValue("pearls").net)
        val wood = resources.getValue("wood")
        assertEquals(0L,wood.received); assertEquals(2L,wood.spent)
        assertEquals(5L,wood.reserved); assertEquals(3L,wood.returned); assertEquals(-4L,wood.net)
        val resin = resources.getValue("living_resin")
        assertEquals(0L,resin.received); assertEquals(0L,resin.spent); assertEquals(0L,resin.net)
        assertEquals(1L,resin.reserved); assertEquals(1L,resin.returned)
        assertEquals("escrow",report.flows.single { it.kind=="market_create" }.category)
        assertEquals(5L,report.flows.single { it.kind=="market_create" }.spent)
        assertEquals("trade",report.flows.first { it.kind=="market_sell" }.category)
        assertEquals(listOf(1L,0L,0L),report.daily.map { it.players })
        assertEquals(listOf(9L,0L,0L),report.daily.map { it.events })
        assertEquals(2L,report.coverage.matchingPlayers)
        assertEquals("2020-01-02T12:00:00Z",report.coverage.firstRecordedAt)
        val everyone = repo.analytics(admin.hash,query.copy(scope="all"))
        assertEquals(3L,everyone.summary.activePlayers); assertEquals(11L,everyone.summary.events)
        assertEquals(1780L,everyone.resources.single { it.resourceId=="coins" }.received)
        assertEquals(ledgerBefore,scalar("SELECT jsonb_agg(to_jsonb(e) ORDER BY user_id,source_key)::text FROM economy_ledger e"))
        for (table in listOf("economy_profiles","world_profiles","economy_conversion_audit"))
            assertEquals("0",scalar("SELECT count(*) FROM $table"),"Observation must not initialize $table")
    }

    @Test fun `analytics report actual meal portions and order payments without summing player counts or guessing old cards`() = runBlocking<Unit> {
        val admin = user("Администратор"); val player = user("Повар"); val other = user("Заказчик")
        val at = "2020-01-02T12:00:00Z"
        analyticsEntry(player,"eat_food",at,items=mapOf("fish_soup" to -1L),target="fish_soup")
        analyticsEntry(player,"feed_builder",at,items=mapOf("fish_soup" to -1L),target="fish_soup")
        analyticsEntry(other,"eat_food",at,items=mapOf("hearty_fish" to -1L),target="hearty_fish")
        val completed = analyticsEntry(player,"complete_resident_order",at,coins=750,items=mapOf("wood" to -15L),target="order2_1_0_0_123")
        execute("UPDATE economy_ledger SET context=?::jsonb WHERE user_id=? AND source_key=?", """{"targetId":"builder_wood_supply"}""",player.id,"command:$completed")
        analyticsEntry(player,"complete_resident_order",at,coins=90,target="order_1_2_3")
        analyticsEntry(player,"replace_resident_order",at,target="builder_wood_supply")
        analyticsEntry(other,"replace_resident_order",at,pearls=-10,target="builder_wood_supply")
        analyticsEntry(other,"replace_resident_order",at,pearls=-1,target="plesk_river_catch",pearlScale=10)
        analyticsEntry(admin,"complete_resident_order",at,coins=99_999,target="builder_wood_supply")
        analyticsEntry(player,"eat_food","2020-01-01T00:00:00Z",items=mapOf("fish_soup" to -1L),target="fish_soup")
        val repo = repository(admin)
        val query = AdminAnalyticsQuery(from="2020-01-02",to="2020-01-02")
        val report = repo.analytics(admin.hash,query)
        with(report.gameplay) {
            assertEquals(3L,mealsConsumed); assertEquals(2L,foodPlayers)
            assertEquals(2L,ordersCompleted); assertEquals(1L,orderPlayers); assertEquals(840L,orderCoinsEarned)
            assertEquals(3L,orderReplacements); assertEquals(2L,paidOrderReplacements); assertEquals(15L,orderPearlsSpent)
        }
        with(report.meals.single { it.itemId=="fish_soup" }) {
            assertEquals(1L,heroPortions); assertEquals(1L,builderPortions); assertEquals(1L,players)
        }
        with(report.orders.single { it.templateId=="builder_wood_supply" }) {
            assertEquals(1L,this.completed); assertEquals(2L,replacements); assertEquals(1L,paidReplacements)
            assertEquals(750L,coinsEarned); assertEquals(10L,pearlsSpent); assertEquals(2L,players)
        }
        assertEquals(90L,report.orders.single { it.templateId==null }.coinsEarned)
        assertEquals(1L,report.coverage.unattributedEvents)
        val unknown = repo.analyticsEvents(admin.hash,AdminAnalyticsEventsQuery(query=query,kind="complete_resident_order"))
            .events.single { it.coins==90L }
        assertNull(unknown.targetId); assertFalse(unknown.contextKnown)
    }

    @Test fun `presence analytics keeps UTC days historical signals current watchlist and scope separate`() = runBlocking<Unit> {
        val admin = user("Администратор"); val player = user("Наблюдаемый"); val quiet = user("Спокойный"); val deleted = user("Удалённый")
        fun day(who: User, date: String, millis: Long, flagged: Boolean = false) {
            execute("INSERT INTO game_presence_daily(user_id,day,online_millis,flagged_at) VALUES (?,?::date,?,?::timestamptz)",
                who.id,date,millis,if (flagged) date+"T23:00:00Z" else null)
        }
        day(player,"2020-01-01",1000); day(player,"2020-01-02",72_060_500,true); day(player,"2020-01-03",72_100_500,true)
        day(quiet,"2020-01-02",60_500); day(admin,"2020-01-02",80_000_000,true); day(deleted,"2020-01-02",80_000_000,true)
        execute("UPDATE app_users SET deleted_at=clock_timestamp() WHERE id=?",deleted.id)
        // A moderator removed observation after the flagged days; history must remain visible.
        execute("UPDATE app_users SET tap_watchlisted=false WHERE id=?",player.id)
        val repo = repository(admin)
        val query = AdminAnalyticsQuery(from="2020-01-02",to="2020-01-04")
        val p = repo.analytics(admin.hash,query).presence
        assertEquals("2020-01-01T00:00:00.000Z",p.coverageFrom)
        assertEquals(2L,p.players); assertEquals(144_221L,p.onlineSeconds); assertEquals(1L,p.flaggedPlayers)
        assertEquals(listOf("2020-01-02","2020-01-03","2020-01-04"),p.daily.map { it.date })
        assertEquals(listOf(72_121L,72_100L,0L),p.daily.map { it.onlineSeconds })
        assertEquals(2,p.reviewDays.size); assertTrue(p.reviewDays.all { !it.watchlisted && it.publicId==player.publicId })
        assertFalse(p.reviewDaysTruncated)
        assertEquals(3L,repo.analytics(admin.hash,query.copy(scope="all")).presence.players)
        val exact = repo.analytics(admin.hash,query.copy(q=quiet.publicId)).presence
        assertEquals(1L,exact.players); assertEquals(60L,exact.onlineSeconds); assertTrue(exact.reviewDays.isEmpty())
        val empty = repo.analytics(admin.hash,query.copy(q="Несуществующий")).presence
        assertEquals(0L,empty.players); assertNull(empty.coverageFrom)
        assertEquals("0",scalar("SELECT count(*) FROM economy_profiles"))
    }

    @Test fun `analytics reconstruct job targets and first observed construction before filtering the period`() = runBlocking<Unit> {
        val admin = user(); val established = user("Первый"); val newcomer = user("Второй")
        val unknown = user("Без старого чека"); val producer = user("Производитель"); val inactive = user("Без событий")
        val repo = repository(admin)
        analyticsEntry(established,"start_construction","2020-01-01T10:00:00Z",target="home")
        val workshop = analyticsEntry(established,"start_construction","2020-01-02T10:00:00Z",items=mapOf("wood" to -10L),target="workshop")
        analyticsEntry(established,"claim_job","2020-01-02T11:00:00Z",target=workshop.toString())
        val quarry = analyticsEntry(newcomer,"start_construction","2020-01-03T10:00:00Z",target="quarry")
        analyticsEntry(newcomer,"speedup_construction","2020-01-03T11:00:00Z",pearls=-5,target=quarry.toString())
        val missingContext = analyticsEntry(unknown,"start_construction","2020-01-03T12:00:00Z")
        execute("""INSERT INTO economy_commands(user_id,request_id,signature,message,accepted_revision)
            VALUES (?,?,'retired non-JSON receipt','Old private receipt',1)""",unknown.id,missingContext)
        // Different players may reuse a request UUID: job attribution must include its owner.
        val production = analyticsEntry(producer,"start_production","2020-01-02T08:00:00Z",target="grow_berries",quantity=3,requestId=quarry)
        analyticsEntry(producer,"start_collection","2020-01-03T08:00:00Z",target=production.toString())
        analyticsEntry(producer,"claim_job","2020-01-03T09:00:00Z",items=mapOf("berries" to 12L),target=production.toString())
        // Surviving historical context may contain a missing or non-UUID job reference.
        analyticsEntry(producer,"cancel_exploration","2020-01-03T13:00:00Z",target="missing-job-context")
        for ((player,buildings) in listOf(established to mapOf("home" to 5,"workshop" to 2),
            newcomer to mapOf("home" to 2,"quarry" to 1),inactive to mapOf("home" to 4))) {
            val state = EconomyRules.initial().copy(buildings=buildings,fishingCastSeed="never-expose-this-seed")
            execute("INSERT INTO economy_profiles(user_id,state) VALUES (?,?::jsonb)",player.id,economyJson.encodeToString(state))
        }
        val before = scalar("SELECT jsonb_agg(to_jsonb(e) ORDER BY user_id)::text FROM economy_profiles e")
        val query = AdminAnalyticsQuery(from="2020-01-02",to="2020-01-03")
        val report = repo.analytics(admin.hash,query)
        assertEquals(3L,report.summary.constructionStarts); assertEquals(2L,report.summary.constructionClaims)
        assertEquals(3L,report.summary.constructionPlayers)
        assertEquals(1L,report.construction.single { it.buildingId=="workshop" }.claims)
        assertEquals(1L,report.construction.single { it.buildingId=="quarry" }.claims)
        assertEquals(mapOf<String?,Long>("quarry" to 1L,null to 1L),report.firstConstructions.associate { it.buildingId to it.players })
        assertEquals(2L,report.coverage.unattributedEvents)
        assertEquals("2020-01-01T10:00:00Z",report.coverage.firstRecordedAt)
        assertEquals(5L,report.coverage.matchingPlayers); assertEquals(3L,report.coverage.initializedPlayers)
        assertEquals(setOf(2,4,5),report.buildingLevels.filter { it.buildingId=="home" }.map { it.level }.toSet())
        val quiet = repo.analytics(admin.hash,query.copy(from="2020-01-04",to="2020-01-04"))
        assertEquals(report.buildingLevels.toSet(),quiet.buildingLevels.toSet())
        assertTrue(quiet.firstConstructions.isEmpty()); assertEquals(0L,quiet.summary.events)
        val events = repo.analyticsEvents(admin.hash,AdminAnalyticsEventsQuery(query=query,limit=100)).events
        assertEquals("workshop",events.single { it.publicId==established.publicId && it.kind=="claim_job" }.targetId)
        assertEquals("quarry",events.single { it.kind=="speedup_construction" }.targetId)
        assertEquals("grow_berries",events.single { it.kind=="start_collection" }.targetId)
        assertEquals("grow_berries",events.single { it.publicId==producer.publicId && it.kind=="claim_job" }.targetId)
        assertEquals(3L,events.single { it.kind=="start_production" }.quantity)
        assertNull(events.single { it.publicId==unknown.publicId }.targetId)
        assertFalse(events.single { it.publicId==unknown.publicId }.contextKnown)
        assertNull(events.single { it.kind=="cancel_exploration" }.targetId)
        val serialized = Json.encodeToString(report) + Json.encodeToString(events)
        for (privateValue in listOf("never-expose-this-seed","Private command receipt","signature","expectedRevision"))
            assertFalse(serialized.contains(privateValue))
        assertEquals(before,scalar("SELECT jsonb_agg(to_jsonb(e) ORDER BY user_id)::text FROM economy_profiles e"))
    }

    @Test fun `analytics journal filters the selected resource leg and keeps anchored pages stable`() = runBlocking<Unit> {
        val admin = user(); val player = user("100%_торговец"); val other = user("Другой торговец")
        val lookalike = user(player.publicId)
        val repo = repository(admin)
        val today = LocalDate.parse(scalar("SELECT (clock_timestamp() AT TIME ZONE 'UTC')::date")!!)
        val at = today.minusDays(1).atTime(12,0).atOffset(ZoneOffset.UTC).toString()
        val repeatedId = analyticsEntry(player,"sell",at,coins=100,items=mapOf("wood" to -5L),target="wood")
        analyticsEntry(player,"buy_fishing_item",at,coins=-40,items=mapOf("wood" to 2L),target="wood")
        analyticsEntry(player,"buy_fishing_item",at,pearls=-3,items=mapOf("bait" to 1L),target="bait")
        analyticsEntry(other,"sell",at,coins=20,items=mapOf("wood" to -1L),target="wood",requestId=repeatedId)
        analyticsEntry(lookalike,"sell",at,coins=500,target="stone")
        val query = AdminAnalyticsQuery(from=today.minusDays(1).toString(),to=today.toString(),q="%_")
        suspend fun filtered(resource: String="",direction: String="all") =
            repo.analyticsEvents(admin.hash,AdminAnalyticsEventsQuery(query=query,resource=resource,direction=direction,limit=100))
        assertEquals(3L,filtered().total)
        for (publicId in listOf(player.publicId,player.publicId.lowercase())) {
            val personal = repo.analyticsEvents(admin.hash,AdminAnalyticsEventsQuery(query=query.copy(q=publicId),limit=100))
            assertEquals(3L,personal.total)
            assertTrue(personal.events.all { it.publicId==player.publicId },"A public ID drilldown must ignore another player's display name")
            assertEquals(1L,repo.analytics(admin.hash,query.copy(q=publicId)).coverage.matchingPlayers)
        }
        val woodIn = filtered("wood","in")
        assertEquals(1L,woodIn.total); assertEquals(-40L,woodIn.events.single().coins)
        assertEquals(2L,woodIn.events.single().items["wood"])
        assertEquals("sell",filtered("wood","out").events.single().kind)
        assertEquals(-40L,filtered("coins","out").events.single().coins)
        assertEquals(0L,filtered("pearls","in").total)
        assertEquals(3L,filtered(direction="in").total); assertEquals(3L,filtered(direction="out").total)
        val journal = AdminAnalyticsEventsQuery(query=query.copy(q="торговец"),limit=2)
        val first = repo.analyticsEvents(admin.hash,journal)
        val original = repo.analyticsEvents(admin.hash,journal.copy(limit=100,at=first.endAt))
        assertEquals(4L,first.total); assertEquals(4,original.events.map { it.id }.toSet().size)
        // A committed event after the snapshot anchor must not move the second page.
        analyticsEntry(other,"sell",first.endAt,coins=30,target="stone")
        val second = repo.analyticsEvents(admin.hash,journal.copy(offset=2,at=first.endAt))
        assertEquals(4L,second.total); assertEquals(first.endAt,second.endAt)
        assertEquals(original.events.map { it.id },(first.events+second.events).map { it.id })
        assertEquals(5L,repo.analyticsEvents(admin.hash,journal).total)
        assertTrue(repo.analyticsEvents(admin.hash,journal.copy(offset=4,at=first.endAt)).events.isEmpty())
        assertEquals(0L,repo.analyticsEvents(admin.hash,journal.copy(query=query.copy(q="' OR true --"))).total)
    }

    @Test fun `analytics use inclusive UTC dates with empty days and never initialize a new player`() = runBlocking<Unit> {
        val admin = user(); val player = user("Новый игрок"); val repo = repository(admin)
        analyticsEntry(player,"sell","2020-01-01T23:59:59.999999Z",coins=100,target="wood")
        analyticsEntry(player,"sell","2020-01-02T00:00:00Z",coins=10,target="wood")
        analyticsEntry(player,"sell","2020-01-04T23:59:59.999999Z",coins=20,target="wood")
        analyticsEntry(player,"sell","2020-01-05T00:00:00Z",coins=200,target="wood")
        val query = AdminAnalyticsQuery(from="2020-01-02",to="2020-01-04",q=player.publicId)
        val report = repo.analytics(admin.hash,query)
        assertEquals("2020-01-02T00:00:00Z",report.startAt); assertEquals("2020-01-05T00:00:00Z",report.endAt)
        assertEquals(listOf("2020-01-02","2020-01-03","2020-01-04"),report.daily.map { it.date })
        assertEquals(listOf(1L,0L,1L),report.daily.map { it.events })
        assertEquals(30L,report.resources.single { it.resourceId=="coins" }.received)
        assertEquals(0L,report.coverage.initializedPlayers); assertTrue(report.buildingLevels.isEmpty())
        val empty = repo.analytics(admin.hash,query.copy(q="Несуществующий игрок"))
        assertEquals(0L,empty.summary.events); assertEquals(0L,empty.coverage.matchingPlayers)
        assertNull(empty.coverage.firstRecordedAt); assertEquals(3,empty.daily.size)
        assertTrue(empty.daily.all { it.players==0L && it.events==0L && it.constructionStarts==0L })
        assertTrue(empty.resources.isEmpty()); assertTrue(empty.actions.isEmpty()); assertTrue(empty.flows.isEmpty())
        assertEquals("0",scalar("SELECT count(*) FROM economy_profiles"))
        assertEquals("0",scalar("SELECT count(*) FROM economy_conversion_audit"))
    }

    @Test fun `HTTP analytics authorize before reads and reject duplicate invalid or oversized filters`() = testApplication {
        val admin = user(); val visitor = user(); val repo = repository(admin)
        application { installZhivApi(identities,identities,config,admin=repo) }
        val cookie = "${config.cookieName}=${admin.raw}"
        for (path in listOf("/api/v1/admin/analytics","/api/v1/admin/analytics/events")) {
            assertEquals(HttpStatusCode.Unauthorized,client.get(path) { header("X-Role","admin") }.status)
            assertEquals(HttpStatusCode.Forbidden,client.get(path) {
                header(HttpHeaders.Cookie,"${config.cookieName}=${visitor.raw}"); header("X-Admin-Public-Id",admin.publicId)
            }.status)
            val accepted = client.get(path) { header(HttpHeaders.Cookie,cookie) }
            assertEquals(HttpStatusCode.OK,accepted.status)
            assertEquals("no-store",accepted.headers[HttpHeaders.CacheControl])
            assertEquals("noindex, nofollow",accepted.headers["X-Robots-Tag"])
            for (filter in listOf("from=2020-01-01&from=2020-01-02", "to=2020-01-01&to=2020-01-02",
                "q=a&q=b", "scope=players&scope=all", "from=2020-01-01", "to=2020-01-01",
                "from=2020-02-30&to=2020-03-01", "from=2020-01-03&to=2020-01-02", "from=0000-01-01&to=0000-01-02",
                "from=2020-01-01&to=2021-01-01", "from=2999-01-01&to=2999-01-02", "scope=unknown", "q=${"x".repeat(101)}")) {
                assertEquals(HttpStatusCode.BadRequest,client.get("$path?$filter") { header(HttpHeaders.Cookie,cookie) }.status,filter)
            }
        }
        for (filter in listOf("kind=sell&kind=claim_job", "resource=wood&resource=coins", "direction=in&direction=out",
            "offset=0&offset=1", "limit=1&limit=2", "at=2020-01-01T00:00:00Z&at=2020-01-02T00:00:00Z",
            "limit=101", "limit=0", "offset=-1", "offset=100001", "direction=unknown", "at=not-an-instant",
            "at=2999-01-01T00:00:00Z", "from=2020-01-02&to=2020-01-03&at=2020-01-01T00:00:00Z",
            "kind=bad%20kind", "resource=bad%20resource")) {
            assertEquals(HttpStatusCode.BadRequest,client.get("/api/v1/admin/analytics/events?$filter") {
                header(HttpHeaders.Cookie,cookie)
            }.status,filter)
        }
        assertEquals("0",scalar("SELECT count(*) FROM economy_profiles"))
        execute("UPDATE app_sessions SET revoked_at=clock_timestamp() WHERE token_hash=?",admin.hash)
        for (path in listOf("/api/v1/admin/analytics","/api/v1/admin/analytics/events"))
            assertEquals(HttpStatusCode.Unauthorized,client.get(path) { header(HttpHeaders.Cookie,cookie) }.status)
        assertEquals(403,assertFailsWith<AuthFailure> { repository().analytics(visitor.hash,AdminAnalyticsQuery()) }.status)
        assertEquals(401,assertFailsWith<AuthFailure> { repo.analyticsEvents(tokens.issue().hash,AdminAnalyticsEventsQuery()) }.status)
        assertEquals(403,assertFailsWith<AuthFailure> { repo.analytics(visitor.hash,AdminAnalyticsQuery(from="invalid")) }.status)
        assertEquals(401,assertFailsWith<AuthFailure> { repo.analyticsEvents(tokens.issue().hash,AdminAnalyticsEventsQuery(limit=0)) }.status)
    }

    @Test fun `all operations deny absent sessions ordinary accounts and an empty administrator allowlist`() = runBlocking<Unit> {
        val admin = user("Администратор"); val visitor = user()
        val repo = repository(admin)
        assertEquals(admin.publicId, repo.access(admin.hash).publicId)
        assertEquals(401, assertFailsWith<AuthFailure> { repo.access(tokens.issue().hash) }.status)
        assertEquals(403, assertFailsWith<AuthFailure> { repository().access(admin.hash) }.status)
        val denied = listOf<suspend () -> Any>(
            { repo.economy(visitor.hash,"","updated",0,25) },
            { repo.economyPlayer(visitor.hash,admin.publicId) },
            { repo.player(visitor.hash,admin.publicId) },
            { repo.tapActivity(visitor.hash,admin.publicId) },
            { repo.managePlayer(visitor.hash,admin.publicId,UUID.randomUUID(),AdminPlayerCommand(UUID.randomUUID().toString(),admin.publicId,"Attempt unauthorized grant","grant_resource","wood",10)) },
            { repo.access(visitor.hash) }, { repo.overview(visitor.hash, 7) },
            { repo.users(visitor.hash, "", "created", 0, 25) }, { repo.audit(visitor.hash, 0, 25) },
            { repo.revokeSessions(visitor.hash, admin.publicId, UUID.randomUUID(), admin.publicId, "Проверка защиты доступа") },
        )
        for (operation in denied) assertEquals(403, assertFailsWith<AuthFailure> { operation() }.status)
        execute("UPDATE app_sessions SET revoked_at=clock_timestamp() WHERE token_hash=?", admin.hash)
        assertEquals(401, assertFailsWith<AuthFailure> { repo.overview(admin.hash, 30) }.status)
        assertEquals(401, assertFailsWith<AuthFailure> { repo.economy(admin.hash,"","updated",0,25) }.status)
        assertEquals(401, assertFailsWith<AuthFailure> { repo.economyPlayer(admin.hash,visitor.publicId) }.status)
    }

    @Test fun `economy observations never initialize absent gameplay or reveal a fishing seed`() = runBlocking<Unit> {
        val admin = user("Администратор"); val target = user("Новый игрок"); val repo = repository(admin)
        val detail = repo.economyPlayer(admin.hash,target.publicId)
        assertNull(detail.economy); assertNull(detail.updatedAt); assertTrue(detail.jobStatuses.isEmpty())
        val page = repo.economy(admin.hash,target.publicId,"updated",0,25)
        assertEquals(1L,page.total); assertFalse(page.players.single().initialized)
        assertNull(page.players.single().coins); assertNull(page.players.single().storage)
        assertEquals("0",scalar("SELECT count(*) FROM economy_profiles WHERE user_id=?",target.id))
        assertEquals("0",scalar("SELECT count(*) FROM economy_conversion_audit WHERE user_id=?",target.id))
        assertEquals("0",scalar("SELECT count(*) FROM economy_ledger WHERE user_id=?",target.id))
        val initialized = EconomyRules.initial().copy(fishingCastSeed="private-seed-must-not-leak",
            rareDropState=EconomyRareDropClock(remainingSeconds=98765,itemId="living_resin"))
        execute("INSERT INTO economy_profiles(user_id,state) VALUES (?,?::jsonb)",target.id,economyJson.encodeToString(initialized))
        assertFalse(Json.encodeToString(repo.economyPlayer(admin.hash,target.publicId)).contains("private-seed"))
        assertFalse(Json.encodeToString(repo.economyPlayer(admin.hash,target.publicId)).contains("rareDropState"))
        assertEquals(404,assertFailsWith<AuthFailure> { repo.economyPlayer(admin.hash,"0000-0000-0001") }.status)
    }

    @Test fun `economy page and detail use actual profiles escrow collection deadlines and bounded ledger`() = runBlocking<Unit> {
        val admin = user("Администратор"); val target = user("100%_хозяйство"); val retired = user("Удалённый")
        val repo = repository(admin)
        val end = "2000-01-01T00:00:00Z"
        val ready = EconomyJob(UUID.randomUUID().toString(),"production","woodlot","gather_wood",startedAt=end,finishesAt=end,rewards=mapOf("wood" to 5L))
        val collecting = ready.copy(id=UUID.randomUUID().toString(),targetId="garden",recipeId="grow_berries",rewards=mapOf("berries" to 4L),
            collection=EconomyCollection("berry_harvest",8,null,null))
        val future = ready.copy(id=UUID.randomUUID().toString(),finishesAt="2100-01-01T00:00:00Z")
        val state = EconomyRules.initial().copy(wallet=EconomyWallet(321,7),inventory=mapOf("wood" to 190L),jobs=listOf(ready,collecting,future),completedExplorations=5)
        execute("INSERT INTO economy_profiles(user_id,state) VALUES (?,?::jsonb)",target.id,economyJson.encodeToString(state))
        execute("INSERT INTO economy_profiles(user_id,state) VALUES (?,?::jsonb)",retired.id,economyJson.encodeToString(state))
        execute("UPDATE app_users SET deleted_at=clock_timestamp() WHERE id=?",retired.id)
        execute("INSERT INTO economy_market_listings(id,seller_id,item_id,quantity,total_price) VALUES (?,?,?,?,?)",UUID.randomUUID(),target.id,"wood",5,10)
        // The extra reserved relic makes this five-item delivery blocked in both observations.
        execute("INSERT INTO economy_barter_offers(id,seller_id,offered_item_id,requested_item_id) VALUES (?,?,?,?)",
            UUID.randomUUID(),target.id,"living_resin","moon_crystal")
        execute("INSERT INTO economy_barter_offers(id,seller_id,offered_item_id,requested_item_id,status,closed_at) VALUES (?,?,?,?,'cancelled',clock_timestamp())",
            UUID.randomUUID(),target.id,"ancient_core","moon_crystal")
        execute("INSERT INTO economy_barter_offers(id,seller_id,offered_item_id,requested_item_id) VALUES (?,?,?,?)",
            UUID.randomUUID(),retired.id,"living_resin","moon_crystal")
        repeat(35) { execute("INSERT INTO economy_ledger(user_id,source_key,kind,coins,pearls,items) VALUES (?,?,'sell',-2,1,'{\"wood\":-1}'::jsonb)",target.id,"observation:$it") }
        val before = scalar("SELECT state::text || revision::text || updated_at::text FROM economy_profiles WHERE user_id=?",target.id)
        val page = repo.economy(admin.hash,"%_","ready",0,1)
        assertEquals(1L,page.total); assertEquals(2L,page.summary.players)
        assertEquals(1L,page.summary.initializedPlayers); assertEquals(1L,page.summary.uninitializedPlayers)
        assertEquals(321L,page.summary.coins); assertEquals(7L,page.summary.pearls)
        assertEquals(1L,page.summary.runningJobs); assertEquals(1L,page.summary.readyJobs); assertEquals(1L,page.summary.storageBlockedPlayers)
        val player = page.players.single()
        assertEquals(target.publicId,player.publicId); assertEquals(6L,player.storage!!.reserved); assertEquals(4L,player.storage.available)
        assertEquals(1L,player.awaitingCollectionJobs); assertEquals(1L,player.blockedReadyJobs)
        val detail = repo.economyPlayer(admin.hash,target.publicId)
        assertEquals(player.storage,detail.economy!!.storage)
        assertEquals(setOf("running","ready","awaiting_collection"),detail.jobStatuses.map { it.status }.toSet())
        assertEquals(ready.id,detail.jobStatuses.single { it.storageBlocked }.jobId)
        assertEquals(30,detail.ledger.size); assertEquals(-2L,detail.ledger.first().coins); assertEquals(-1L,detail.ledger.first().items["wood"])
        assertEquals(before,scalar("SELECT state::text || revision::text || updated_at::text FROM economy_profiles WHERE user_id=?",target.id))
        assertTrue(repo.economy(admin.hash,"%_","coins",1,1).players.isEmpty())
        assertEquals(400,assertFailsWith<AuthFailure> { repo.economy(admin.hash,"","unknown",0,25) }.status)
        assertEquals(400,assertFailsWith<AuthFailure> { repo.economy(admin.hash,"","ready",0,101) }.status)
    }

    @Test fun `expired sessions and retired accounts lose administrator access`() = runBlocking<Unit> {
        val admin = user(); val repo = repository(admin)
        execute("UPDATE app_sessions SET created_at=clock_timestamp()-interval '2 days', last_seen_at=clock_timestamp()-interval '1 day', expires_at=clock_timestamp()-interval '1 hour' WHERE token_hash=?", admin.hash)
        assertEquals(401, assertFailsWith<AuthFailure> { repo.access(admin.hash) }.status)
        val fresh = extraSession(admin)
        assertEquals(admin.publicId, repo.access(fresh).publicId)
        execute("UPDATE app_users SET deleted_at=clock_timestamp() WHERE id=?", admin.id)
        assertEquals(401, assertFailsWith<AuthFailure> { repo.access(fresh) }.status)
    }

    @Test fun `overview uses completed UTC retention days and server check-ins instead of device dates`() = runBlocking<Unit> {
        val admin = user(); val repo = repository(admin)
        val today = LocalDate.parse(scalar("SELECT (clock_timestamp() AT TIME ZONE 'UTC')::date")!!)
        created(admin, today.minusDays(40))
        val returned = user(); created(returned, today.minusDays(10))
        val absent = user(); created(absent, today.minusDays(10))
        checkIn(returned, today.minusDays(9), "Pacific/Kiritimati")
        checkIn(returned, today.minusDays(3), "America/Adak")
        val immature = user(); created(immature, today.minusDays(1))
        // Today is incomplete; even a check-in cannot make this user D1-eligible.
        val now = source.connection.use { c -> c.createStatement().use { s -> s.executeQuery("SELECT clock_timestamp()").use { r -> r.next(); r.getObject(1, OffsetDateTime::class.java) } } }
        execute("""
            INSERT INTO check_ins(user_id,session_id,idempotency_key,checked_at,next_allowed_at,timezone_id,local_date)
            SELECT user_id,id,?,?,? + interval '30 seconds','UTC',(? AT TIME ZONE 'UTC')::date FROM app_sessions WHERE token_hash=?
        """.trimIndent(), UUID.randomUUID(), now, now, now, immature.hash)
        val report = repo.overview(admin.hash, 30)
        assertEquals(30, report.daily.size)
        assertEquals(today.toString(), report.daily.last().date)
        assertEquals(4L, report.totals.users)
        assertEquals(3L, report.newUsersPeriod)
        assertEquals(3L, report.checkInsPeriod)
        assertEquals(2L, report.retention.day1.eligible)
        assertEquals(1L, report.retention.day1.returned)
        assertEquals(50.0, report.retention.day1.rate)
        assertEquals(report.retention.day1, report.retention.day7)
        assertEquals(1L, report.active.last24Hours)
        assertEquals(2L, report.active.last7Days)
        assertEquals(2L, report.active.last30Days)
        assertEquals(1L, report.daily.single { it.date == today.minusDays(9).toString() }.activeUsers)
        assertTrue(report.services.databaseReady)
        assertTrue(report.services.databaseBytes > 0)
        assertTrue(report.services.databaseConnections > 0)
        assertEquals(4L, report.services.activeSessions)
        val shorter = repo.overview(admin.hash, 7)
        assertEquals(0L, shorter.retention.day7.eligible)
        assertNull(shorter.retention.day7.rate)
        assertEquals(400, assertFailsWith<AuthFailure> { repo.overview(admin.hash, 365) }.status)
    }

    @Test fun `user search is literal bounded paginated and only reveals provider names`() = runBlocking<Unit> {
        val admin = user("Администратор"); val repo = repository(admin)
        val a = user("Тестер А"); val b = user("Тестер Б"); val literal = user("100%_тестер")
        execute("INSERT INTO game_profiles(user_id,lifetime_taps,best_series) VALUES (?,719,719)", a.id)
        execute("INSERT INTO account_login_identities(provider,subject,user_id) VALUES ('email','private@example.test',?)", a.id)
        val page = repo.users(admin.hash, "тестер", "taps", 0, 1)
        assertEquals(3L, page.total); assertEquals(1, page.users.size)
        assertEquals(a.publicId, page.users.single().publicId)
        assertEquals(719L, page.users.single().bestSeries)
        assertEquals(listOf("email"), page.users.single().loginMethods)
        assertFalse(page.users.single().isAdmin)
        val next = repo.users(admin.hash, "тестер", "taps", 1, 25)
        assertEquals(setOf(b.publicId, literal.publicId), next.users.map { it.publicId }.toSet())
        assertEquals(literal.publicId, repo.users(admin.hash, "%_", "created", 0, 25).users.single().publicId)
        assertEquals(0L, repo.users(admin.hash, "' OR true --", "activity", 0, 25).total)
        assertTrue(repo.users(admin.hash, admin.publicId.lowercase(), "created", 0, 25).users.single().isAdmin)
        assertEquals(400, assertFailsWith<AuthFailure> { repo.users(admin.hash, "", "created", 0, 101) }.status)
        assertEquals(400, assertFailsWith<AuthFailure> { repo.users(admin.hash, "", "created; SELECT 1", 0, 25) }.status)
    }

    @Test fun `session revocation is atomic and retries never revoke a newer login`() = runBlocking<Unit> {
        val admin = user("Администратор"); val target = user(); val repo = repository(admin)
        extraSession(target)
        val id = UUID.randomUUID(); val reason = "Подозрительная активность в аккаунте"
        val first = repo.revokeSessions(admin.hash, target.publicId, id, target.publicId, reason)
        assertEquals(2, first.affectedSessions)
        assertNull(identities.findBySession(target.hash))
        val fresh = extraSession(target)
        val replay = repo.revokeSessions(admin.hash, target.publicId, id, target.publicId, reason)
        assertEquals(first, replay)
        assertNotNull(identities.findBySession(fresh))
        val audit = repo.audit(admin.hash, 0, 25)
        assertEquals(1L, audit.total)
        assertEquals(id.toString(), audit.events.single().requestId)
        assertEquals(admin.publicId, audit.events.single().actorPublicId)
        assertEquals(target.publicId, audit.events.single().targetPublicId)
        assertEquals(reason, audit.events.single().reason)
        assertEquals(409, assertFailsWith<AuthFailure> { repo.revokeSessions(admin.hash, target.publicId, id, target.publicId, "Совсем другая причина") }.status)
        assertEquals(1L, repo.audit(admin.hash, 0, 25).total)
    }

    @Test fun `concurrent exact requests have one receipt and protect all administrator accounts`() = runBlocking<Unit> {
        val admin = user(); val peerAdmin = user(); val target = user(); val repo = repository(admin, peerAdmin)
        val id = UUID.randomUUID(); val reason = "Проверка параллельного запроса"
        val replies = coroutineScope {
            List(2) { async(Dispatchers.IO) { repo.revokeSessions(admin.hash, target.publicId, id, target.publicId, reason) } }.awaitAll()
        }
        assertEquals(replies.first(), replies.last())
        assertEquals(1, replies.first().affectedSessions)
        assertEquals(1L, repo.audit(admin.hash, 0, 25).total)
        for (protected in listOf(admin, peerAdmin)) {
            assertEquals("ADMIN_PROTECTED_ACCOUNT", assertFailsWith<AuthFailure> {
                repo.revokeSessions(admin.hash, protected.publicId, UUID.randomUUID(), protected.publicId, reason)
            }.code)
            assertNotNull(identities.findBySession(protected.hash))
        }
        assertEquals("ADMIN_REQUEST_CONFLICT", assertFailsWith<AuthFailure> {
            repo.revokeSessions(peerAdmin.hash, target.publicId, id, target.publicId, reason)
        }.code)
    }

    @Test fun `invalid confirmation never mutates sessions and audit rows cannot be rewritten`() = runBlocking<Unit> {
        val admin = user(); val target = user(); val repo = repository(admin)
        val id = UUID.randomUUID()
        for ((confirmation, reason) in listOf("wrong" to "Нормальная причина", target.publicId to "коротко", target.publicId to "Причина\nсо строкой",
            target.publicId to "Причина\u202eс подменой", target.publicId to "Причина\u2066с подменой")) {
            assertEquals(400, assertFailsWith<AuthFailure> { repo.revokeSessions(admin.hash, target.publicId, id, confirmation, reason) }.status)
        }
        assertNotNull(identities.findBySession(target.hash))
        assertEquals(0L, repo.audit(admin.hash, 0, 25).total)
        repo.revokeSessions(admin.hash, target.publicId, id, target.publicId, "Проверка неизменяемого журнала")
        assertEquals("55000", assertFailsWith<SQLException> { execute("UPDATE admin_actions SET reason='Подменённая причина' WHERE request_id=?", id) }.sqlState)
        assertEquals("55000", assertFailsWith<SQLException> { execute("DELETE FROM admin_actions WHERE request_id=?", id) }.sqlState)
        assertEquals(1L, repo.audit(admin.hash, 0, 25).total)
    }

    @Test fun `revocation rechecks administrator session after waiting for account locks`() = runBlocking<Unit> {
        val admin = user(); val target = user(); val repo = repository(admin)
        source.connection.use { blocker ->
            blocker.autoCommit = false
            blocker.prepareStatement("SELECT id FROM app_users WHERE id=? FOR NO KEY UPDATE").use {
                it.setObject(1, target.id); it.executeQuery().close()
            }
            val mutation = async(Dispatchers.IO) {
                runCatching { repo.revokeSessions(admin.hash, target.publicId, UUID.randomUUID(), target.publicId, "Проверка отозванного сеанса") }
            }
            try {
                withTimeout(2_000) {
                    while (scalar("SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE 'SELECT id FROM app_users WHERE id IN%'") == "0") delay(10)
                }
                execute("UPDATE app_sessions SET revoked_at=clock_timestamp() WHERE token_hash=?", admin.hash)
            } finally { blocker.rollback() }
            assertEquals(401, (mutation.await().exceptionOrNull() as AuthFailure).status)
        }
        assertNotNull(identities.findBySession(target.hash))
        assertEquals("0", scalar("SELECT count(*) FROM admin_actions"))
    }

    @Test fun `HTTP admin requires session authorization ignores role headers and blocks cross-origin writes`() = testApplication {
        val admin = user("Администратор"); val visitor = user(); val target = user()
        val repo = repository(admin)
        val production = config.copy(production = true, allowedOrigins = setOf("https://example.test"))
        application { installZhivApi(identities, identities, production, admin = repo) }
        val cookie = "${production.cookieName}=${admin.raw}"
        val anonymous = client.get("/api/v1/admin/access") { header("X-Admin-Public-Id", admin.publicId) }
        assertEquals(HttpStatusCode.Unauthorized, anonymous.status)
        assertEquals("no-store", anonymous.headers[HttpHeaders.CacheControl])
        val ordinary = client.get("/api/v1/admin/users") {
            header(HttpHeaders.Cookie, "${production.cookieName}=${visitor.raw}")
            header("X-Admin-Public-Id", admin.publicId); header("X-Role", "admin")
        }
        assertEquals(HttpStatusCode.Forbidden, ordinary.status)
        val accepted = client.get("/api/v1/admin/access") { header(HttpHeaders.Cookie, cookie) }
        assertEquals(HttpStatusCode.OK, accepted.status)
        assertEquals("no-store", accepted.headers[HttpHeaders.CacheControl])
        assertEquals(setOf("publicId", "displayName", "serverTime"), Json.parseToJsonElement(accepted.bodyAsText()).jsonObject.keys)
        assertEquals(HttpStatusCode.BadRequest, client.get("/api/v1/admin/overview?days=7&days=30") { header(HttpHeaders.Cookie, cookie) }.status)
        assertEquals(HttpStatusCode.BadRequest, client.get("/api/v1/admin/users?limit=101") { header(HttpHeaders.Cookie, cookie) }.status)
        for (path in listOf("/api/v1/admin/economy","/api/v1/admin/users/${target.publicId}/economy")) {
            assertEquals(HttpStatusCode.Unauthorized,client.get(path).status)
            assertEquals(HttpStatusCode.Forbidden,client.get(path) { header(HttpHeaders.Cookie,"${production.cookieName}=${visitor.raw}") }.status)
            val economy = client.get(path) { header(HttpHeaders.Cookie,cookie) }
            assertEquals(HttpStatusCode.OK,economy.status)
            assertEquals("no-store",economy.headers[HttpHeaders.CacheControl])
            assertEquals("noindex, nofollow",economy.headers["X-Robots-Tag"])
        }
        assertEquals(HttpStatusCode.BadRequest,client.get("/api/v1/admin/economy?sort=coins&sort=ready") { header(HttpHeaders.Cookie,cookie) }.status)
        assertEquals(HttpStatusCode.BadRequest,client.get("/api/v1/admin/economy?limit=101") { header(HttpHeaders.Cookie,cookie) }.status)
        val body = """{"requestId":"${UUID.randomUUID()}","confirmationPublicId":"${target.publicId}","reason":"Проверка защиты от CSRF"}"""
        for (origin in listOf<String?>(null, "https://evil.example")) {
            val blocked = client.post("/api/v1/admin/users/${target.publicId}/revoke-sessions") {
                header(HttpHeaders.Cookie, cookie); if (origin != null) header(HttpHeaders.Origin, origin)
                contentType(ContentType.Application.Json); setBody(body)
            }
            assertEquals(HttpStatusCode.Forbidden, blocked.status)
        }
        assertNotNull(identities.findBySession(target.hash))
        assertEquals(0L, repo.audit(admin.hash, 0, 25).total)
        val permitted = client.post("/api/v1/admin/users/${target.publicId}/revoke-sessions") {
            header(HttpHeaders.Cookie, cookie); header(HttpHeaders.Origin, "https://example.test")
            contentType(ContentType.Application.Json); setBody(body)
        }
        assertEquals(HttpStatusCode.OK, permitted.status)
        assertEquals("no-store", permitted.headers[HttpHeaders.CacheControl])
        assertNull(identities.findBySession(target.hash))
    }

    @Test fun `HTTP monitoring requires live administrator authorization before serving a cached snapshot`() = testApplication {
        val admin = user("Администратор"); val visitor = user()
        val production = config.copy(production = true, allowedOrigins = setOf("https://example.test"), monitoringUrl = null)
        application { installZhivApi(identities, identities, production, admin = repository(admin)) }
        val anonymous = client.get("/api/v1/admin/monitoring") {
            header("X-Admin-Public-Id", admin.publicId); header("X-Role", "admin")
        }
        assertEquals(HttpStatusCode.Unauthorized, anonymous.status)
        assertEquals("no-store", anonymous.headers[HttpHeaders.CacheControl])
        val ordinary = client.get("/api/v1/admin/monitoring") {
            header(HttpHeaders.Cookie, "${production.cookieName}=${visitor.raw}")
            header("X-Admin-Public-Id", admin.publicId); header("X-Role", "admin")
        }
        assertEquals(HttpStatusCode.Forbidden, ordinary.status)
        val cookie = "${production.cookieName}=${admin.raw}"
        val accepted = client.get("/api/v1/admin/monitoring") { header(HttpHeaders.Cookie, cookie) }
        assertEquals(HttpStatusCode.OK, accepted.status)
        assertEquals("no-store", accepted.headers[HttpHeaders.CacheControl])
        assertEquals("noindex, nofollow", accepted.headers["X-Robots-Tag"])
        val body = Json.parseToJsonElement(accepted.bodyAsText()).jsonObject
        assertFalse(body.getValue("configured").jsonPrimitive.boolean)
        assertFalse(body.getValue("available").jsonPrimitive.boolean)
        assertEquals("MONITORING_DISABLED", body.getValue("error").jsonPrimitive.content)
        assertEquals(JsonNull, body.getValue("summary").jsonObject.getValue("cpuPercent"))
        assertTrue(body.getValue("samples").jsonArray.isEmpty())
        assertTrue(body.getValue("health").jsonArray.all { it.jsonObject.getValue("status").jsonPrimitive.content == "unknown" })
        execute("UPDATE app_sessions SET revoked_at=clock_timestamp() WHERE token_hash=?", admin.hash)
        val revoked = client.get("/api/v1/admin/monitoring") { header(HttpHeaders.Cookie, cookie) }
        assertEquals(HttpStatusCode.Unauthorized, revoked.status)
        assertFalse(revoked.bodyAsText().contains("cpuPercent"))
    }

    @Test fun `HTTP monitoring stays closed when the administrator allowlist is empty`() = testApplication {
        val account = user("Обычный аккаунт")
        application { installZhivApi(identities, identities, config, admin = repository()) }
        val response = client.get("/api/v1/admin/monitoring") {
            header(HttpHeaders.Cookie, "${config.cookieName}=${account.raw}")
            header("X-Admin-Public-Id", account.publicId)
        }
        assertEquals(HttpStatusCode.Forbidden, response.status)
        assertEquals("no-store", response.headers[HttpHeaders.CacheControl])
        assertFalse(response.bodyAsText().contains("cpuPercent"))
    }
    @Test fun `admin grant fills missing stages despite existing first stage without forging progress`() = runBlocking<Unit> {
        val admin=user(); val target=user(); val repo=repository(admin)
        execute("INSERT INTO game_achievements(user_id,achievement_id,unlocked_at) VALUES (?,'explorer','2026-01-01T00:00:00Z')",target.id)
        execute("INSERT INTO game_achievement_tiers(user_id,achievement_id,level,unlocked_at) VALUES (?,'explorer',1,'2026-01-01T00:00:00Z')",target.id)
        val key=UUID.randomUUID()
        val request=ru.zhiv.admin.AdminGrantRequest(key.toString(),target.publicId,"achievement","explorer","Проверка выдачи всех этапов")
        val first=repo.grantReward(admin.hash,target.publicId,key,request)
        assertTrue(first.granted); assertEquals(first,repo.grantReward(admin.hash,target.publicId,key,request))
        val next=UUID.randomUUID()
        assertFalse(repo.grantReward(admin.hash,target.publicId,next,request.copy(requestId=next.toString())).granted)
        val award=JdbcGameRepository(source).achievements(target.hash).achievements.single { it.id=="explorer" }
        assertEquals("2026-01-01T00:00:00Z",award.unlockedAt)
        assertEquals(3,award.tiers.count { it.unlockedAt!=null }); assertEquals(200L,award.progress)
        assertEquals(0L,JdbcEconomyRepository(source).snapshot(target.hash).completedExplorations)
    }

    @Test fun `reward grants are authorized independent idempotent and immutable`() = runBlocking<Unit> {
        val admin=user(); val target=user(); val other=user(); val repo=repository(admin)
        val key=UUID.randomUUID()
        val request=ru.zhiv.admin.AdminGrantRequest(key.toString(),target.publicId,"item","leaf_garland","Помощь в тестировании приложения")
        assertEquals(403,assertFailsWith<AuthFailure> { repo.grantReward(other.hash,target.publicId,key,request) }.status)
        assertEquals(400,assertFailsWith<AuthFailure> { repo.grantReward(admin.hash,target.publicId,key,request.copy(rewardId="unknown")) }.status)
        assertEquals(400,assertFailsWith<AuthFailure> { repo.grantReward(admin.hash,target.publicId,key,request.copy(confirmationPublicId=other.publicId)) }.status)
        assertEquals(400,assertFailsWith<AuthFailure> { repo.grantReward(admin.hash,target.publicId,key,request.copy(reason="Проверка\u202eнаграды")) }.status)
        assertEquals(0L,repo.audit(admin.hash,0,25).total)
        val replies=coroutineScope { List(2) { async(Dispatchers.IO) { repo.grantReward(admin.hash,target.publicId,key,request) } }.awaitAll() }
        assertEquals(replies[0],replies[1]); assertTrue(replies[0].granted)
        val game=JdbcGameRepository(source)
        val progress=game.progress(target.hash)
        assertEquals(listOf("leaf_garland"),progress.items)
        assertEquals(0L,progress.lifetimeTaps); assertEquals(0L,progress.bestSeries); assertFalse(progress.leaderboardOptIn)
        assertNotNull(identities.findBySession(target.hash))
        assertEquals(listOf("leaf_garland"),repo.rewards(admin.hash,target.publicId).items)
        assertEquals("ADMIN_REQUEST_CONFLICT",assertFailsWith<AuthFailure> { repo.revokeSessions(admin.hash,target.publicId,key,target.publicId,request.reason) }.code)
        assertEquals("ADMIN_REQUEST_CONFLICT",assertFailsWith<AuthFailure> { repo.grantReward(admin.hash,target.publicId,key,request.copy(rewardId="flower")) }.code)
        val another=UUID.randomUUID()
        assertFalse(repo.grantReward(admin.hash,target.publicId,another,request.copy(requestId=another.toString())).granted)
        val award=UUID.randomUUID()
        assertTrue(repo.grantReward(admin.hash,target.publicId,award,request.copy(requestId=award.toString(),kind="achievement",rewardId="ten_thousand_series")).granted)
        val earned=game.achievements(target.hash).achievements.single { it.id=="ten_thousand_series" }
        assertEquals(10000L,earned.progress); assertNotNull(earned.unlockedAt)
        assertEquals(0L,game.progress(target.hash).bestSeries)
        val audit=repo.audit(admin.hash,0,25)
        assertEquals(3L,audit.total)
        assertEquals(setOf("grant_item","grant_achievement"),audit.events.map { it.action }.toSet())
        assertEquals("55000",assertFailsWith<SQLException> { execute("UPDATE admin_actions SET reward_id='flower' WHERE request_id=?",key) }.sqlState)
        assertEquals("55000",assertFailsWith<SQLException> { execute("DELETE FROM admin_actions WHERE request_id=?",key) }.sqlState)
        // Administrative accounts can receive cosmetic rewards without weakening session protection.
        val self=UUID.randomUUID()
        assertTrue(repo.grantReward(admin.hash,admin.publicId,self,request.copy(requestId=self.toString(),confirmationPublicId=admin.publicId)).granted)
        execute("UPDATE app_users SET deleted_at=clock_timestamp() WHERE id=?",other.id)
        val missing=UUID.randomUUID()
        assertEquals(404,assertFailsWith<AuthFailure> { repo.grantReward(admin.hash,other.publicId,missing,request.copy(requestId=missing.toString(),confirmationPublicId=other.publicId)) }.status)
    }

    @Test fun `retired reward receipts replay but cannot be newly granted or leak into current ownership`() = runBlocking<Unit> {
        val admin=user(); val target=user(); val repo=repository(admin); val requestId=UUID.randomUUID()
        val request=ru.zhiv.admin.AdminGrantRequest(requestId.toString(),target.publicId,"achievement","hundred_series","Historical tester reward")
        execute("INSERT INTO game_achievements(user_id,achievement_id) VALUES (?,'hundred_series')",target.id)
        execute("""INSERT INTO admin_actions(request_id,actor_user_id,target_user_id,actor_public_id,target_public_id,action,reason,affected_sessions,reward_id,granted)
            VALUES (?,?,?,?,?,'grant_achievement',?,0,'hundred_series',true)""",requestId,admin.id,target.id,admin.publicId,target.publicId,request.reason)
        assertTrue(repo.grantReward(admin.hash,target.publicId,requestId,request).granted)
        assertTrue(repo.rewards(admin.hash,target.publicId).achievements.isEmpty())
        val another=UUID.randomUUID()
        assertEquals(400,assertFailsWith<AuthFailure> { repo.grantReward(admin.hash,target.publicId,another,request.copy(requestId=another.toString())) }.status)
    }

    @Test fun `HTTP reward grants enforce trusted origin and validate catalog`() = testApplication {
        val admin=user(); val target=user(); val visitor=user(); val repo=repository(admin)
        val production=config.copy(production=true,allowedOrigins=setOf("https://example.test"))
        application { installZhivApi(identities,identities,production,admin=repo) }
        val path="/api/v1/admin/users/${target.publicId}/grant-reward"
        val body="""{"requestId":"${UUID.randomUUID()}","confirmationPublicId":"${target.publicId}","kind":"item","rewardId":"flower","reason":"Награда за тестирование"}"""
        for (origin in listOf<String?>(null,"https://evil.example")) {
            assertEquals(HttpStatusCode.Forbidden,client.post(path) {
                header(HttpHeaders.Cookie,"${production.cookieName}=${admin.raw}")
                if(origin!=null) header(HttpHeaders.Origin,origin)
                contentType(ContentType.Application.Json);setBody(body)
            }.status)
        }
        assertEquals(HttpStatusCode.Forbidden,client.post(path) {
            header(HttpHeaders.Cookie,"${production.cookieName}=${visitor.raw}");header(HttpHeaders.Origin,"https://example.test")
            contentType(ContentType.Application.Json);setBody(body)
        }.status)
        val accepted=client.post(path) {
            header(HttpHeaders.Cookie,"${production.cookieName}=${admin.raw}");header(HttpHeaders.Origin,"https://example.test")
            contentType(ContentType.Application.Json);setBody(body)
        }
        assertEquals(HttpStatusCode.OK,accepted.status);assertEquals("no-store",accepted.headers[HttpHeaders.CacheControl])
        assertEquals(listOf("flower"),repo.rewards(admin.hash,target.publicId).items)
    }

    private fun command(target: User, action: String, value: String="", amount: Long=0, tag: PlayerTag?=null): AdminPlayerCommand =
        AdminPlayerCommand(UUID.randomUUID().toString(),target.publicId,"Проверка административного действия",action,value,amount,tag)

    @Test
    fun `automatic tap signal persists without banning and can be cleared idempotently`() = runBlocking<Unit> {
        val admin = user()
        val target = user()
        val repo = repository(admin)
        source.connection.use { c ->
            c.autoCommit = false
            try {
                c.prepareStatement("SELECT id FROM app_users WHERE id=? FOR NO KEY UPDATE").use { statement ->
                    statement.setObject(1, target.id)
                    statement.executeQuery().use { result -> assertTrue(result.next()) }
                }
                val recordedAt = c.createStatement().use { statement ->
                    statement.executeQuery("SELECT clock_timestamp()").use { result ->
                        assertTrue(result.next())
                        result.getObject(1, OffsetDateTime::class.java)
                    }
                }
                // 100 taps/minute for 15 completed minutes, stored as second buckets.
                c.prepareStatement("""
                    WITH taps AS (
                        SELECT i, date_trunc('minute', ?::timestamptz)
                            - interval '15 minutes' + i * interval '600 milliseconds' AS tapped_at
                        FROM generate_series(0,1499) AS series(i)
                    ), buckets AS (
                        SELECT date_trunc('second',tapped_at) AS bucket_at, count(*) AS taps,
                            count(*) FILTER (WHERE i>0) AS intervals
                        FROM taps GROUP BY 1
                    )
                    INSERT INTO game_tap_activity_seconds(
                        user_id,bucket_at,received_taps,event_taps,interval_count,
                        interval_sum_ms,interval_squared_sum_ms
                    )
                    SELECT ?,bucket_at,taps,taps,intervals,intervals*600.0,intervals*360000.0 FROM buckets
                """.trimIndent()).use { statement ->
                    statement.setObject(1, recordedAt)
                    statement.setObject(2, target.id)
                    statement.executeUpdate()
                }
                recordTapActivity(c, target.id, recordedAt, accepted=1, rejected=0,
                    times=listOf(recordedAt.toInstant().toEpochMilli()), previous=null)
                c.commit()
            } catch (error: Exception) { c.rollback(); throw error }
        }
        // A fresh repository sees the committed automatic signal.
        val flagged = repository(admin).player(admin.hash, target.publicId)
        assertNotNull(flagged.tapSignalAt)
        assertNull(flagged.bannedAt)
        assertFalse(flagged.watchlisted)
        assertNotNull(identities.findBySession(target.hash))
        assertEquals(0L, repo.audit(admin.hash, 0, 25).total)

        val clear = command(target, "clear_signal")
        val requestId = UUID.fromString(clear.requestId)
        assertEquals(403, assertFailsWith<AuthFailure> {
            repo.managePlayer(target.hash, target.publicId, requestId, clear)
        }.status)
        assertNotNull(repo.player(admin.hash, target.publicId).tapSignalAt)
        val receipt = repo.managePlayer(admin.hash, target.publicId, requestId, clear)
        assertTrue(receipt.changed)
        assertEquals(0, receipt.affectedSessions)
        assertEquals(receipt, repo.managePlayer(admin.hash, target.publicId, requestId, clear))

        val cleared = repo.player(admin.hash, target.publicId)
        assertNull(cleared.tapSignalAt)
        assertNull(cleared.bannedAt)
        assertFalse(cleared.watchlisted)
        assertNotNull(identities.findBySession(target.hash))
        val audit = repo.audit(admin.hash, 0, 25)
        assertEquals(1L, audit.total)
        assertEquals("clear_signal", audit.events.single().action)
    }

    @Test fun `retired resource grants reject explicitly and cosmetic grants remain replayable`() = runBlocking<Unit> {
        val admin=user(); val target=user(); val repo=repository(admin)
        val grant=command(target,"grant_resource","wood",25)
        assertEquals("ADMIN_RESOURCE_RETIRED",assertFailsWith<AuthFailure> { repo.managePlayer(admin.hash,target.publicId,UUID.fromString(grant.requestId),grant) }.code)
        assertEquals(0L,repo.player(admin.hash,target.publicId).world.resources.wood)
        assertEquals("0",scalar("SELECT count(*) FROM admin_actions WHERE request_id=?",UUID.fromString(grant.requestId)))
        val cosmetic=command(target,"grant_world_item","explorer_cap")
        val receipts=coroutineScope { List(2) { async(Dispatchers.IO) { repo.managePlayer(admin.hash,target.publicId,UUID.fromString(cosmetic.requestId),cosmetic) } }.awaitAll() }
        assertEquals(receipts[0],receipts[1])
        assertEquals(1L,repo.player(admin.hash,target.publicId).revision)
        assertEquals("0",scalar("SELECT tap_sparks FROM world_profiles WHERE user_id=?",target.id))
        assertEquals("0",scalar("SELECT count(*) FROM game_monthly_scores WHERE user_id=?",target.id))
        val duplicate=command(target,"grant_world_item","moss")
        assertFalse(repo.managePlayer(admin.hash,target.publicId,UUID.fromString(duplicate.requestId),duplicate).changed)
        assertEquals(409,assertFailsWith<AuthFailure> { repo.managePlayer(admin.hash,target.publicId,UUID.fromString(cosmetic.requestId),cosmetic.copy(target="amber_scarf")) }.status)
        for(bad in listOf(grant.copy(requestId=UUID.randomUUID().toString(),amount=-1),grant.copy(requestId=UUID.randomUUID().toString(),amount=100001),command(target,"grant_world_item","unknown"))) {
            assertEquals(400,assertFailsWith<AuthFailure> { repo.managePlayer(admin.hash,target.publicId,UUID.fromString(bad.requestId),bad) }.status)
        }
        for(find in ru.zhiv.world.WorldRules.catalog.finds) {
            val request=command(target,"grant_find",find.id)
            repo.managePlayer(admin.hash,target.publicId,UUID.fromString(request.requestId),request)
        }
        assertTrue("explorer_cap" in repo.player(admin.hash,target.publicId).world.inventory)
    }

    @Test fun `tags are public metadata and a normal profile edit cannot replace them`() = runBlocking<Unit> {
        val admin=user(); val target=user("Игрок"); val repo=repository(admin)
        val request=command(target,"set_tag",tag=PlayerTag("Tester","blue"))
        repo.managePlayer(admin.hash,target.publicId,UUID.fromString(request.requestId),request)
        assertEquals(PlayerTag("Tester","blue"),identities.findBySession(target.hash)!!.tag)
        assertEquals("Игрок",identities.findBySession(target.hash)!!.displayName)
        identities.updateDisplayName(target.hash,"Новое имя",UUID.randomUUID())
        assertEquals(PlayerTag("Tester","blue"),identities.findBySession(target.hash)!!.tag)
        assertEquals(PlayerTag("Tester","blue"),repo.users(admin.hash,target.publicId,"created",0,25).users.single().tag)
        for(tag in listOf(PlayerTag("<admin>","red"),PlayerTag("Admin","url(unsafe)"))) {
            val bad=command(target,"set_tag",tag=tag)
            assertEquals(400,assertFailsWith<AuthFailure> { repo.managePlayer(admin.hash,target.publicId,UUID.fromString(bad.requestId),bad) }.status)
        }
        val clear=command(target,"set_tag")
        repo.managePlayer(admin.hash,target.publicId,UUID.fromString(clear.requestId),clear)
        assertNull(identities.findBySession(target.hash)!!.tag)
    }

    @Test fun `ban closes sessions prevents new sessions and a retried old ban cannot undo an unban`() = runBlocking<Unit> {
        val admin=user(); val target=user(); val repo=repository(admin)
        val recovery=JdbcCodeRecoveryRepository(source); val code=tokens.issue().hash
        assertTrue(recovery.activate(target.hash,code))
        execute("INSERT INTO account_login_identities(provider,subject,user_id) VALUES ('email','blocked@example.test',?)",target.id)
        val ban=command(target,"ban")
        val receipt=repo.managePlayer(admin.hash,target.publicId,UUID.fromString(ban.requestId),ban)
        assertTrue(receipt.changed); assertNull(identities.findBySession(target.hash))
        assertNotNull(repo.player(admin.hash,target.publicId).bannedAt)
        assertFailsWith<SQLException> { extraSession(target) }
        assertEquals("ACCOUNT_BANNED",assertFailsWith<AuthFailure> { recovery.redeem(code,tokens.issue().hash,tokens.issue().hash,365) }.code)
        val flow=ru.zhiv.auth.LoginFlow(tokens.issue().hash,tokens.issue().hash,"email","login",null,null,"blocked@example.test",null,null,null)
        assertEquals("ACCOUNT_BANNED",assertFailsWith<AuthFailure> { JdbcAuthRepository(source).finish(flow,"blocked@example.test",tokens.issue().hash,365,"Test") }.code)
        assertEquals("ACCOUNT_BANNED",assertFailsWith<AuthFailure> { JdbcAuthRepository(source).prepareRegistration(flow,"blocked@example.test",tokens.issue().hash) }.code)
        for(protected in listOf(admin)) {
            val request=command(protected,"ban")
            assertEquals("ADMIN_PROTECTED_ACCOUNT",assertFailsWith<AuthFailure> { repo.managePlayer(admin.hash,protected.publicId,UUID.fromString(request.requestId),request) }.code)
        }
        val unban=command(target,"unban")
        repo.managePlayer(admin.hash,target.publicId,UUID.fromString(unban.requestId),unban)
        assertEquals(receipt,repo.managePlayer(admin.hash,target.publicId,UUID.fromString(ban.requestId),ban))
        assertNull(repo.player(admin.hash,target.publicId).bannedAt)
        assertNull(identities.findBySession(target.hash))
        assertNotNull(identities.findBySession(extraSession(target)))
    }

    @Test fun `accepted tap telemetry survives retries and is private to the selected user`() = runBlocking<Unit> {
        val admin=user(); val target=user(); val other=user(); val repo=repository(admin); val games=JdbcGameRepository(source)
        val session=games.openSession(target.hash,UUID.randomUUID(),target.publicId)
        val run=UUID.randomUUID()
        val first=games.submitBatch(target.hash,UUID.fromString(session.sessionId),1,3,run,null)
        assertEquals(3,first.acceptedTaps)
        assertTrue(games.submitBatch(target.hash,UUID.fromString(session.sessionId),1,3,run,null).replayed)
        assertEquals("3",scalar("SELECT sum(received_taps) FROM game_tap_activity_seconds WHERE user_id=?",target.id))
        assertEquals("3",scalar("SELECT sum(legacy_taps) FROM game_tap_activity_seconds WHERE user_id=?",target.id))
        assertEquals("0",scalar("SELECT count(*) FROM game_tap_activity_seconds WHERE user_id=?",other.id))
        assertEquals("insufficient_data",repo.tapActivity(admin.hash,target.publicId).analysis.status)
        assertEquals(403,assertFailsWith<AuthFailure> { repo.tapActivity(other.hash,target.publicId) }.status)
        execute("INSERT INTO game_tap_activity_seconds(user_id,bucket_at,received_taps) VALUES (?,clock_timestamp()-interval '3 hours',7)",target.id)
        assertEquals(1,purgeTapActivity(source))
        assertEquals("3",scalar("SELECT sum(received_taps) FROM game_tap_activity_seconds WHERE user_id=?",target.id))
    }

}
