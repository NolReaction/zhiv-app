package ru.zhiv.db

import com.zaxxer.hikari.HikariDataSource
import io.ktor.client.request.*
import io.ktor.client.statement.bodyAsText
import io.ktor.http.*
import io.ktor.server.testing.testApplication
import kotlinx.coroutines.*
import kotlinx.serialization.json.*
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

    @Test fun `all operations deny absent sessions ordinary accounts and an empty administrator allowlist`() = runBlocking<Unit> {
        val admin = user("Администратор"); val visitor = user()
        val repo = repository(admin)
        assertEquals(admin.publicId, repo.access(admin.hash).publicId)
        assertEquals(401, assertFailsWith<AuthFailure> { repo.access(tokens.issue().hash) }.status)
        assertEquals(403, assertFailsWith<AuthFailure> { repository().access(admin.hash) }.status)
        val denied = listOf<suspend () -> Any>(
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
        for ((confirmation, reason) in listOf("wrong" to "Нормальная причина", target.publicId to "коротко", target.publicId to "Причина\nсо строкой")) {
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
    @Test fun `reward grants are authorized independent idempotent and immutable`() = runBlocking<Unit> {
        val admin=user(); val target=user(); val other=user(); val repo=repository(admin)
        val key=UUID.randomUUID()
        val request=ru.zhiv.admin.AdminGrantRequest(key.toString(),target.publicId,"item","leaf_garland","Помощь в тестировании приложения")
        assertEquals(403,assertFailsWith<AuthFailure> { repo.grantReward(other.hash,target.publicId,key,request) }.status)
        assertEquals(400,assertFailsWith<AuthFailure> { repo.grantReward(admin.hash,target.publicId,key,request.copy(rewardId="unknown")) }.status)
        assertEquals(400,assertFailsWith<AuthFailure> { repo.grantReward(admin.hash,target.publicId,key,request.copy(confirmationPublicId=other.publicId)) }.status)
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

    @Test fun `world grants are atomic replayable bounded and preserve normal progression`() = runBlocking<Unit> {
        val admin=user(); val target=user(); val repo=repository(admin)
        val grant=command(target,"grant_resource","wood",25)
        val receipts=coroutineScope { List(2) { async(Dispatchers.IO) { repo.managePlayer(admin.hash,target.publicId,UUID.fromString(grant.requestId),grant) } }.awaitAll() }
        assertEquals(receipts[0],receipts[1]); assertEquals(25L,repo.player(admin.hash,target.publicId).world.resources.wood)
        assertEquals(1L,repo.player(admin.hash,target.publicId).revision)
        assertEquals("0",scalar("SELECT tap_sparks FROM world_profiles WHERE user_id=?",target.id))
        assertEquals("0",scalar("SELECT count(*) FROM game_monthly_scores WHERE user_id=?",target.id))
        val duplicate=command(target,"grant_world_item","moss")
        assertFalse(repo.managePlayer(admin.hash,target.publicId,UUID.fromString(duplicate.requestId),duplicate).changed)
        assertEquals(1L,repo.player(admin.hash,target.publicId).revision)
        assertEquals(409,assertFailsWith<AuthFailure> { repo.managePlayer(admin.hash,target.publicId,UUID.fromString(grant.requestId),grant.copy(amount=26)) }.status)
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
