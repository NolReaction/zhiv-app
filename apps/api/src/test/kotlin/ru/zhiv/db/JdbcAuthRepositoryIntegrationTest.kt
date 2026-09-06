package ru.zhiv.db

import com.zaxxer.hikari.HikariDataSource
import kotlinx.coroutines.runBlocking
import io.ktor.server.testing.testApplication
import io.ktor.client.request.*
import io.ktor.client.statement.bodyAsText
import io.ktor.http.*
import kotlinx.serialization.json.*
import ru.zhiv.installZhivApi
import org.junit.jupiter.api.AfterAll
import org.junit.jupiter.api.BeforeAll
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.TestInstance
import org.testcontainers.containers.PostgreSQLContainer
import org.testcontainers.junit.jupiter.Container
import org.testcontainers.junit.jupiter.Testcontainers
import ru.zhiv.auth.*
import ru.zhiv.config.AppConfig
import ru.zhiv.security.TokenCodec
import java.util.UUID
import kotlin.test.*

@Testcontainers(disabledWithoutDocker = true)
@TestInstance(TestInstance.Lifecycle.PER_CLASS)
class JdbcAuthRepositoryIntegrationTest {
    private class Postgres(image: String) : PostgreSQLContainer<Postgres>(image)
    companion object { @Container private val postgres = Postgres("postgres:18-alpine") }
    private lateinit var source: HikariDataSource
    private lateinit var auth: JdbcAuthRepository
    private lateinit var identities: JdbcZhivRepository
    private val tokens = TokenCodec()
    @BeforeAll fun setup() {
        source = DatabaseFactory.create(AppConfig(postgres.jdbcUrl, postgres.username, postgres.password, false, setOf("http://localhost")))
        DatabaseFactory.migrate(source); auth = JdbcAuthRepository(source); identities = JdbcZhivRepository(source)
    }
    @AfterAll fun stop() { source.close() }
    private fun flow(intent: String = "register", subject: String = "${UUID.randomUUID()}@example.com", session: ByteArray? = null, provider: String = "email") = LoginFlow(tokens.issue().hash, tokens.issue().hash, provider, intent, session, "Дима", subject, "verifier", "nonce", tokens.hash("code"))

    @Test fun `normal login preserves profile and both sessions while device revocation is scoped`() = runBlocking {
        val registration = flow(); val first = tokens.issue(); val second = tokens.issue()
        val user = auth.finish(registration, registration.subject!!, first.hash, 365, "Safari")
        assertEquals(user, auth.finish(registration.copy(intent = "login"), registration.subject, second.hash, 365, "Telegram"))
        assertEquals(user, identities.findSessionUserId(first.hash)); assertEquals(user, identities.findSessionUserId(second.hash))
        val access = auth.access(second.hash)
        assertEquals(2, access.sessions.size); assertEquals(1, access.sessions.count { it.current })
        val other = tokens.issue(); val stranger = flow()
        auth.finish(stranger, stranger.subject!!, other.hash, 365, "Other")
        assertFailsWith<AuthFailure> { auth.revoke(second.hash, UUID.fromString(auth.access(other.hash).sessions.single().id)) }
        auth.revoke(second.hash, others = true)
        assertNull(identities.findSessionUserId(first.hash)); assertEquals(user, identities.findSessionUserId(second.hash))
    }

    @Test fun `legacy profile linking retains UUID and rejects collision or revoked source session`() = runBlocking {
        val legacy = tokens.issue()
        val user = identities.bootstrap("Прежний профиль", tokens.issue().hash, legacy.hash, 365)
        val link = flow("link", session = legacy.hash, provider = "telegram")
        auth.finish(link, "tg-${UUID.randomUUID()}", tokens.issue().hash, 365, "Unused")
        assertEquals(user.id, identities.findSessionUserId(legacy.hash))
        val subject = "email-${UUID.randomUUID()}@example.com"
        auth.finish(flow("link", subject, legacy.hash), subject, tokens.issue().hash, 365, "Unused")
        val stranger = tokens.issue(); val otherFlow = flow()
        auth.finish(otherFlow, otherFlow.subject!!, stranger.hash, 365, "Other")
        assertFailsWith<AuthFailure> { auth.finish(flow("link", subject, stranger.hash), subject, tokens.issue().hash, 365, "Unused") }
        auth.revoke(legacy.hash)
        assertFailsWith<AuthFailure> { auth.finish(link, "new-${UUID.randomUUID()}", tokens.issue().hash, 365, "Unused") }
    }

    @Test fun `unknown identity requires explicit registration`() = runBlocking {
        val login = flow("login")
        val failure = assertFailsWith<AuthFailure> { auth.finish(login, login.subject!!, tokens.issue().hash, 365, "Browser") }
        assertEquals("AUTH_NOT_LINKED", failure.code)
    }

    @Test fun `OTP attempts commit and correct codes are browser bound expiring and one use`() = runBlocking {
        val challenge = flow(); auth.create(challenge)
        assertFailsWith<AuthFailure> { auth.verifyEmail(challenge.tokenHash, tokens.issue().hash, challenge.codeHash!!) }
        repeat(5) { assertFailsWith<AuthFailure> { auth.verifyEmail(challenge.tokenHash, challenge.browserHash, tokens.hash("wrong")) } }
        assertFailsWith<AuthFailure> { auth.verifyEmail(challenge.tokenHash, challenge.browserHash, challenge.codeHash!!) }
        val good = flow(); auth.create(good)
        assertEquals(good.subject, auth.verifyEmail(good.tokenHash, good.browserHash, good.codeHash!!).subject)
        assertFailsWith<AuthFailure> { auth.verifyEmail(good.tokenHash, good.browserHash, good.codeHash!!) }
        val expired = flow(); auth.create(expired)
        source.connection.use { c -> c.prepareStatement("UPDATE account_login_flows SET created_at=clock_timestamp()-interval '20 minutes', expires_at=clock_timestamp()-interval '1 minute' WHERE token_hash=?").use { s -> s.setBytes(1, expired.tokenHash); s.executeUpdate() }; c.commit() }
        assertFailsWith<AuthFailure> { auth.verifyEmail(expired.tokenHash, expired.browserHash, expired.codeHash!!) }
    }

    @Test fun `mailbox cooldown and Telegram state survive across requests`() = runBlocking {
        val challenge = flow(); auth.create(challenge)
        assertEquals(429, assertFailsWith<AuthFailure> { auth.create(flow(subject = challenge.subject!!)) }.status)
        val telegram = flow(provider = "telegram"); auth.create(telegram)
        assertFailsWith<AuthFailure> { auth.takeTelegram(telegram.tokenHash, tokens.issue().hash) }
        assertEquals("nonce", auth.takeTelegram(telegram.tokenHash, telegram.browserHash).nonce)
        assertFailsWith<AuthFailure> { auth.takeTelegram(telegram.tokenHash, telegram.browserHash) }
    }

    @Test fun `HTTP login sets protected cookies links provider and rejects cross origin writes`() = testApplication {
        var deliveredCode = ""
        val config = AppConfig("unused", "unused", "unused", true, setOf("https://im-alive.ru"))
        application {
            installZhivApi(identities, identities, config, auth = auth,
                authConfig = AuthConfig(origin = "https://im-alive.ru", telegramClientId = "test-client", codeSecret = "test-secret"),
                mailer = LoginMailer { _, code -> deliveredCode = code },
                telegram = TelegramVerifier { _, flow -> assertNotNull(flow.verifier); assertNotNull(flow.nonce); VerifiedTelegram("test-${UUID.randomUUID()}") },
            )
        }
        val browser = createClient { followRedirects = false }
        val blocked = browser.post("/api/v1/auth/email/start") { contentType(ContentType.Application.Json); header(HttpHeaders.Origin, "https://evil.example"); setBody("{}") }
        assertEquals(HttpStatusCode.Forbidden, blocked.status)
        val started = browser.post("/api/v1/auth/email/start") {
            contentType(ContentType.Application.Json); header(HttpHeaders.Origin, "https://im-alive.ru")
            setBody("""{"intent":"register","displayName":"Тест входа","email":"${UUID.randomUUID()}@example.com"}""")
        }
        assertEquals(HttpStatusCode.OK, started.status)
        val flow = Json.parseToJsonElement(started.bodyAsText()).jsonObject["flow"]!!.jsonPrimitive.content
        val loginCookie = started.headers[HttpHeaders.SetCookie]!!
        assertContains(loginCookie, "HttpOnly"); assertContains(loginCookie, "Secure"); assertContains(loginCookie, "SameSite=Lax")
        val wrongBrowser = browser.post("/api/v1/auth/email/verify") {
            contentType(ContentType.Application.Json); header(HttpHeaders.Origin, "https://im-alive.ru"); setBody("""{"flow":"$flow","code":"$deliveredCode"}""")
        }
        assertEquals(HttpStatusCode.BadRequest, wrongBrowser.status)
        val verified = browser.post("/api/v1/auth/email/verify") {
            contentType(ContentType.Application.Json); header(HttpHeaders.Origin, "https://im-alive.ru"); header(HttpHeaders.Cookie, loginCookie.substringBefore(';'))
            setBody("""{"flow":"$flow","code":"$deliveredCode"}""")
        }
        assertEquals(HttpStatusCode.OK, verified.status)
        val sessionCookie = verified.headers[HttpHeaders.SetCookie]!!.substringBefore(';')
        val me = browser.get("/api/v1/me") { header(HttpHeaders.Cookie, sessionCookie) }
        assertEquals(HttpStatusCode.OK, me.status)
        val startLink = browser.post("/api/v1/auth/telegram/start") {
            contentType(ContentType.Application.Json); header(HttpHeaders.Origin, "https://im-alive.ru"); header(HttpHeaders.Cookie, sessionCookie); setBody("""{"intent":"link"}""")
        }
        assertEquals(HttpStatusCode.OK, startLink.status)
        val linkBody = Json.parseToJsonElement(startLink.bodyAsText()).jsonObject
        assertContains(linkBody["url"]!!.jsonPrimitive.content, "code_challenge_method=S256")
        val callback = "/api/v1/auth/telegram/callback?state=${linkBody["flow"]!!.jsonPrimitive.content}&code=test"
        val linked = browser.get(callback) { header(HttpHeaders.Cookie, startLink.headers[HttpHeaders.SetCookie]!!.substringBefore(';')) }
        assertEquals(HttpStatusCode.Found, linked.status); assertEquals("/?auth=linked", linked.headers[HttpHeaders.Location])
        val replay = browser.get(callback) { header(HttpHeaders.Cookie, startLink.headers[HttpHeaders.SetCookie]!!.substringBefore(';')) }
        assertEquals("/?auth=auth_expired", replay.headers[HttpHeaders.Location])
        val account = browser.get("/api/v1/auth/account") { header(HttpHeaders.Cookie, sessionCookie) }
        assertContains(account.bodyAsText(), "telegram"); assertContains(account.bodyAsText(), "email")
        assertFalse(account.bodyAsText().contains("token_hash"))
    }
}
