package ru.zhiv.db

import com.zaxxer.hikari.HikariDataSource
import io.ktor.client.request.*
import io.ktor.client.statement.bodyAsText
import io.ktor.http.*
import io.ktor.server.testing.testApplication
import kotlinx.coroutines.*
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import org.flywaydb.core.Flyway
import org.junit.jupiter.api.AfterAll
import org.junit.jupiter.api.BeforeAll
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.TestInstance
import org.testcontainers.containers.PostgreSQLContainer
import org.testcontainers.junit.jupiter.Container
import org.testcontainers.junit.jupiter.Testcontainers
import ru.zhiv.admin.AdminConfig
import ru.zhiv.auth.*
import ru.zhiv.config.AppConfig
import ru.zhiv.feedback.*
import ru.zhiv.installZhivApi
import ru.zhiv.security.TokenCodec
import java.util.UUID
import kotlin.test.*

@Testcontainers(disabledWithoutDocker = true)
@TestInstance(TestInstance.Lifecycle.PER_CLASS)
class JdbcFeedbackRepositoryIntegrationTest {
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
        // Upgrade an already-populated V28 schema; installing feedback must not touch player progress.
        Flyway.configure().dataSource(source).locations("classpath:db/migration").target("28").cleanDisabled(true).load().migrate()
        execute("INSERT INTO app_users(public_id,display_name) VALUES ('0000-0000-0001','Before feedback')")
        execute("INSERT INTO game_profiles(user_id,lifetime_taps) SELECT id,42 FROM app_users WHERE public_id='0000-0000-0001'")
        DatabaseFactory.migrate(source)
        assertEquals("Before feedback:42", scalar("SELECT display_name || ':' || lifetime_taps FROM app_users JOIN game_profiles ON user_id=id WHERE public_id='0000-0000-0001'"))
        assertEquals("0", scalar("SELECT count(*) FROM player_feedback"))
        identities = JdbcZhivRepository(source)
    }
    @AfterAll fun close() { source.close() }
    @BeforeEach fun clear() { execute("TRUNCATE app_users CASCADE") }
    private fun execute(sql: String, vararg values: Any?): Int = source.connection.use { connection ->
        connection.prepareStatement(sql).use { statement ->
            values.forEachIndexed { index, value -> statement.setObject(index + 1, value) }; statement.executeUpdate()
        }.also { connection.commit() }
    }
    private fun scalar(sql: String, vararg values: Any?): String? = source.connection.use { connection ->
        connection.prepareStatement(sql).use { statement ->
            values.forEachIndexed { index, value -> statement.setObject(index + 1, value) }
            statement.executeQuery().use { row -> if (row.next()) row.getString(1) else null }
        }
    }
    private suspend fun user(): User {
        val token = tokens.issue()
        val snapshot = identities.bootstrap("Feedback tester", tokens.issue().hash, token.hash, 365)
        return User(snapshot.id, snapshot.publicId, token.hash, token.raw)
    }
    private fun repository(admin: User) = JdbcFeedbackRepository(source, AdminConfig(setOf(admin.publicId)))
    private val message = "После нажатия не открывается карта"

    @Test fun `concurrent submissions across independent repositories allow exactly one message`() = runBlocking<Unit> {
        val admin = user(); val player = user()
        val gate = CompletableDeferred<Unit>()
        val results = (1..8).map {
            async(Dispatchers.IO) {
                gate.await()
                runCatching { repository(admin).submit(player.hash, player.publicId, UUID.randomUUID(), "bug", message) }
            }
        }
        gate.complete(Unit)
        val finished = results.awaitAll()
        assertEquals(1, finished.count { it.isSuccess })
        assertEquals(7, finished.count { it.exceptionOrNull() is FeedbackCooldown })
        assertEquals("1", scalar("SELECT count(*) FROM player_feedback WHERE user_id=?", player.id))
        assertFalse(repository(admin).availability(player.hash, player.publicId).canSubmit)
    }

    @Test fun `concurrent retries survive repository recreation and never return another owners data`() = runBlocking<Unit> {
        val admin = user(); val player = user(); val other = user(); val request = UUID.randomUUID()
        val gate = CompletableDeferred<Unit>()
        val receipts = (1..6).map {
            async(Dispatchers.IO) { gate.await(); repository(admin).submit(player.hash, player.publicId, request, "suggestion", message) }
        }
        gate.complete(Unit)
        val completed = receipts.awaitAll()
        assertEquals(1, completed.count { !it.replayed })
        assertEquals(1, completed.map { it.id }.toSet().size)
        assertEquals("1", scalar("SELECT count(*) FROM player_feedback"))
        assertEquals("FEEDBACK_REQUEST_CONFLICT", assertFailsWith<AuthFailure> { repository(admin).submit(player.hash, player.publicId, request, "bug", message) }.code)
        assertEquals("FEEDBACK_REQUEST_CONFLICT", assertFailsWith<AuthFailure> { repository(admin).submit(other.hash, other.publicId, request, "suggestion", message) }.code)
        assertTrue(repository(admin).availability(other.hash, other.publicId).canSubmit)
    }

    @Test fun `rolling cooldown uses server clock and replays do not consume the next daily slot`() = runBlocking<Unit> {
        val admin = user(); val player = user(); val repo = repository(admin); val first = UUID.randomUUID()
        val receipt = repo.submit(player.hash, player.publicId, first, "other", message)
        val cooldown = assertFailsWith<FeedbackCooldown> { repo.submit(player.hash, player.publicId, UUID.randomUUID(), "bug", message) }
        assertEquals(receipt.nextAllowedAt, cooldown.nextAllowedAt.toInstant().toString())
        assertTrue(cooldown.nextAllowedAt.isAfter(cooldown.serverTime))
        execute("UPDATE player_feedback SET created_at=clock_timestamp()-interval '24 hours 1 second' WHERE user_id=?", player.id)
        assertTrue(repo.availability(player.hash, player.publicId).canSubmit)
        assertTrue(repo.submit(player.hash, player.publicId, first, "other", message).replayed)
        assertTrue(repo.availability(player.hash, player.publicId).canSubmit)
        assertFalse(repo.submit(player.hash, player.publicId, UUID.randomUUID(), "bug", message).replayed)
        assertEquals("2", scalar("SELECT count(*) FROM player_feedback WHERE user_id=?", player.id))
    }

    @Test fun `session authentication rejects revoked expired banned and foreign admin users`() = runBlocking<Unit> {
        val admin = user(); val player = user(); val repo = repository(admin)
        assertEquals(401, assertFailsWith<AuthFailure> { repo.availability(tokens.issue().hash, player.publicId) }.status)
        assertEquals(403, assertFailsWith<AuthFailure> { repo.list(player.hash, "all", "all", 0, 25) }.status)
        execute("UPDATE app_users SET banned_at=clock_timestamp(),ban_reason='Feedback test ban' WHERE id=?", player.id)
        assertEquals(401, assertFailsWith<AuthFailure> { repo.submit(player.hash, player.publicId, UUID.randomUUID(), "bug", message) }.status)
        execute("UPDATE app_users SET banned_at=NULL,ban_reason=NULL WHERE id=?", player.id)
        execute("UPDATE app_sessions SET created_at=clock_timestamp()-interval '2 days',last_seen_at=clock_timestamp()-interval '1 day',expires_at=clock_timestamp()-interval '1 second' WHERE token_hash=?", player.hash)
        assertEquals(401, assertFailsWith<AuthFailure> { repo.availability(player.hash, player.publicId) }.status)
        execute("UPDATE app_sessions SET revoked_at=clock_timestamp() WHERE token_hash=?", admin.hash)
        assertEquals(401, assertFailsWith<AuthFailure> { repo.list(admin.hash, "all", "all", 0, 25) }.status)
    }

    @Test fun `stale account expectation cannot spend another accounts daily quota`() = runBlocking<Unit> {
        val admin = user(); val old = user(); val current = user(); val repo = repository(admin)
        assertEquals("FEEDBACK_ACCOUNT_CHANGED", assertFailsWith<AuthFailure> { repo.availability(current.hash, old.publicId) }.code)
        assertEquals("FEEDBACK_ACCOUNT_CHANGED", assertFailsWith<AuthFailure> { repo.submit(current.hash, old.publicId, UUID.randomUUID(), "bug", message) }.code)
        assertTrue(repo.availability(current.hash, current.publicId).canSubmit)
        assertEquals("0", scalar("SELECT count(*) FROM player_feedback"))
    }

    @Test fun `admin pagination filters and status receipts preserve later moderation`() = runBlocking<Unit> {
        val admin = user(); val first = user(); val second = user(); val repo = repository(admin)
        val firstReceipt = repo.submit(first.hash, first.publicId, UUID.randomUUID(), "bug", "<script>plain text only</script>")
        repo.submit(second.hash, second.publicId, UUID.randomUUID(), "suggestion", message)
        val page = repo.list(admin.hash, "new", "all", 0, 1)
        assertEquals(2L, page.total); assertEquals(1, page.items.size)
        assertEquals(1L, repo.list(admin.hash, "all", "bug", 0, 25).total)
        assertEquals(1, repo.list(admin.hash, "new", "all", 1, 25).items.size)
        val id = UUID.fromString(firstReceipt.id); val command = UUID.randomUUID()
        assertEquals("reviewed", repo.changeStatus(admin.hash, id, command, "reviewed").status)
        assertEquals("resolved", repo.changeStatus(admin.hash, id, UUID.randomUUID(), "resolved").status)
        assertEquals("resolved", repo.changeStatus(admin.hash, id, command, "reviewed").status)
        assertEquals(1L, repo.list(admin.hash, "resolved", "bug", 0, 25).total)
        assertEquals("2", scalar("SELECT count(*) FROM player_feedback_actions WHERE feedback_id=?", id))
        assertEquals(409, assertFailsWith<AuthFailure> { repo.changeStatus(admin.hash, id, command, "new") }.status)
        assertEquals(403, assertFailsWith<AuthFailure> { repo.changeStatus(first.hash, id, UUID.randomUUID(), "new") }.status)
        assertEquals(400, assertFailsWith<AuthFailure> { repo.list(admin.hash, "all", "all", -1, 10) }.status)
    }

    @Test fun `real installed HTTP routes keep feedback private and enforce trusted origins`() = testApplication {
        val admin = user(); val player = user(); val repo = repository(admin)
        val production = config.copy(production = true)
        application { installZhivApi(identities, identities, production, feedback = repo) }
        assertEquals(HttpStatusCode.Unauthorized, client.get("/api/v1/feedback").status)
        assertEquals(HttpStatusCode.Forbidden, client.get("/api/v1/admin/feedback") { cookie(production.cookieName, player.raw) }.status)
        val path = "/api/v1/feedback"
        val payload = Json.encodeToString(FeedbackRequest(UUID.randomUUID().toString(), "bug", message, player.publicId))
        assertEquals(HttpStatusCode.Forbidden, client.post(path) { cookie(production.cookieName, player.raw); contentType(ContentType.Application.Json); setBody(payload) }.status)
        val sent = client.post(path) { cookie(production.cookieName, player.raw); header(HttpHeaders.Origin, "http://localhost"); contentType(ContentType.Application.Json); setBody(payload) }
        assertEquals(HttpStatusCode.OK, sent.status)
        assertEquals("no-store", sent.headers[HttpHeaders.CacheControl])
        val listed = client.get("/api/v1/admin/feedback") { cookie(production.cookieName, admin.raw) }
        assertEquals(HttpStatusCode.OK, listed.status)
        assertEquals("no-store", listed.headers[HttpHeaders.CacheControl])
        assertContains(listed.bodyAsText(), player.publicId)
        assertContains(listed.bodyAsText(), message)
    }

    @Test fun `verified account merge preserves cooldown and deletion erases messages and moderation receipts`() = runBlocking<Unit> {
        val auth = JdbcAuthRepository(source)
        data class Account(val user: User, val subject: String)
        suspend fun registered(): Account {
            val token = tokens.issue(); val subject = UUID.randomUUID().toString()
            val flow = LoginFlow(tokens.issue().hash, tokens.issue().hash, "vk", "register", null, "Feedback account", null, "pkce", null, null)
            val id = auth.finish(flow, subject, token.hash, 365, "Test")
            val snapshot = assertNotNull(identities.findBySession(token.hash))
            return Account(User(id, snapshot.publicId, token.hash, token.raw), subject)
        }
        suspend fun prove(account: Account, browser: ByteArray, action: String, role: String = "current", owner: Account = account) {
            val flow = LoginFlow(tokens.issue().hash, browser, "vk", "account", account.user.hash, null, null, "pkce", null, null, action, role)
            auth.create(flow); auth.recordAccountProof(auth.takeVk(flow.tokenHash, browser), owner.subject)
        }
        val admin = user(); val target = registered(); val other = registered(); val repo = repository(admin)
        val request = UUID.randomUUID()
        val feedback = repo.submit(other.user.hash, other.user.publicId, request, "bug", message)
        repo.changeStatus(admin.hash, UUID.fromString(feedback.id), UUID.randomUUID(), "reviewed")
        val browser = tokens.issue().hash
        prove(target, browser, "merge"); prove(target, browser, "merge", "other", other)
        val preview = tokens.issue().hash
        assertTrue(auth.previewMerge(target.user.hash, browser, MergeChoices(providerChoices = mapOf("vk" to "current")), preview).conflicts.isEmpty())
        auth.confirmMerge(target.user.hash, browser, preview)
        assertEquals(target.user.id.toString(), scalar("SELECT user_id FROM player_feedback WHERE id=?", UUID.fromString(feedback.id)))
        assertFalse(repo.availability(target.user.hash, target.user.publicId).canSubmit)
        assertTrue(repo.submit(target.user.hash, target.user.publicId, request, "bug", message).replayed)
        assertEquals(target.user.publicId, repo.list(admin.hash, "all", "all", 0, 25).items.single().authorPublicId)
        prove(target, browser, "delete")
        auth.deleteAccount(target.user.hash, browser, tokens.issue().hash)
        assertEquals("0", scalar("SELECT count(*) FROM player_feedback"))
        assertEquals("0", scalar("SELECT count(*) FROM player_feedback_actions"))
    }
}
