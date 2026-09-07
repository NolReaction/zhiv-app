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

    @Test fun `normal login preserves profile and both sessions while device revocation is scoped`(): Unit = runBlocking {
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

    @Test fun `legacy profile linking retains UUID and rejects collision or revoked source session`(): Unit = runBlocking {
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

    @Test fun `unknown identity requires explicit registration`(): Unit = runBlocking {
        val login = flow("login")
        val failure = assertFailsWith<AuthFailure> { auth.finish(login, login.subject!!, tokens.issue().hash, 365, "Browser") }
        assertEquals("AUTH_NOT_LINKED", failure.code)
    }

    @Test fun `verified signup requires a name and browser and commits one use atomically`(): Unit = runBlocking {
        val login = flow("login", provider = "vk")
        val ticket = tokens.issue(); val session = tokens.issue()
        auth.prepareRegistration(login, login.subject!!, ticket.hash)
        assertNull(identities.findSessionUserId(session.hash))
        assertTrue(auth.hasRegistration(ticket.hash, login.browserHash))
        assertFalse(auth.hasRegistration(ticket.hash, tokens.issue().hash))
        assertFailsWith<AuthFailure> { auth.completeRegistration(ticket.hash, tokens.issue().hash, "Wrong browser", session.hash, 365, "Browser") }
        assertFailsWith<AuthFailure> { auth.completeRegistration(ticket.hash, login.browserHash, " ", session.hash, 365, "Browser") }
        assertTrue(auth.hasRegistration(ticket.hash, login.browserHash))
        val user = auth.completeRegistration(ticket.hash, login.browserHash, "Новый профиль", session.hash, 365, "Browser")
        assertEquals(user, identities.findSessionUserId(session.hash))
        assertFalse(auth.hasRegistration(ticket.hash, login.browserHash))
        assertFailsWith<AuthFailure> { auth.completeRegistration(ticket.hash, login.browserHash, "Replay", tokens.issue().hash, 365, "Other") }
    }

    @Test fun `two verified tickets resolve to the same identity without replacing sessions`(): Unit = runBlocking {
        val login = flow("login")
        val ticketA = tokens.issue(); val ticketB = tokens.issue()
        val sessionA = tokens.issue(); val sessionB = tokens.issue()
        auth.prepareRegistration(login, login.subject!!, ticketA.hash)
        auth.prepareRegistration(login, login.subject, ticketB.hash)
        val first = auth.completeRegistration(ticketA.hash, login.browserHash, "Первое имя", sessionA.hash, 365, "First")
        val second = auth.completeRegistration(ticketB.hash, login.browserHash, "Другое имя", sessionB.hash, 365, "Second")
        assertEquals(first, second)
        assertEquals(first, identities.findSessionUserId(sessionA.hash))
        assertEquals(first, identities.findSessionUserId(sessionB.hash))
        source.connection.use { c -> c.prepareStatement("SELECT display_name FROM app_users WHERE id=?").use { s ->
            s.setObject(1, first); s.executeQuery().use { r -> assertTrue(r.next()); assertEquals("Первое имя", r.getString(1)) }
        } }
        val expired = tokens.issue(); auth.prepareRegistration(login, login.subject, expired.hash)
        source.connection.use { c -> c.prepareStatement("UPDATE account_registration_tickets SET created_at=clock_timestamp()-interval '20 minutes', expires_at=clock_timestamp()-interval '1 minute' WHERE token_hash=?").use { s -> s.setBytes(1, expired.hash); s.executeUpdate() }; c.commit() }
        assertFalse(auth.hasRegistration(expired.hash, login.browserHash))
        assertFailsWith<AuthFailure> { auth.completeRegistration(expired.hash, login.browserHash, "Expired", tokens.issue().hash, 365, "Other") }
    }

    @Test fun `VK callback is browser bound and new identity asks for a name before creating a session`() = testApplication {
        var verifications = 0
        val subject = "vk-${UUID.randomUUID()}"
        val config = AppConfig("unused", "unused", "unused", true, setOf("https://im-alive.ru"))
        application {
            installZhivApi(identities, identities, config, auth = auth,
                authConfig = AuthConfig(origin = "https://im-alive.ru", vkClientId = "123"),
                vk = VkVerifier { code, device, _, flow ->
                    verifications++; assertEquals("test", code); assertEquals("device", device); assertNotNull(flow.verifier)
                    VerifiedVk(subject)
                },
            )
        }
        val browser = createClient { followRedirects = false }
        suspend fun start(cookie: String? = null) = browser.post("/api/v1/auth/vk/start") {
            contentType(ContentType.Application.Json); header(HttpHeaders.Origin, "https://im-alive.ru")
            if (cookie != null) header(HttpHeaders.Cookie, cookie)
            setBody("""{"intent":"login"}""")
        }
        val begun = start(); assertEquals(HttpStatusCode.OK, begun.status)
        val body = Json.parseToJsonElement(begun.bodyAsText()).jsonObject
        assertTrue(body["url"]!!.jsonPrimitive.content.startsWith("https://id.vk.ru/authorize?"))
        val binder = begun.headers.getAll(HttpHeaders.SetCookie)!!.first { it.startsWith("__Host-zhiv_login=") }.substringBefore(';')
        val callback = "/api/v1/auth/vk/callback?state=${body["flow"]!!.jsonPrimitive.content}&code=test&device_id=device"
        val wrongBrowser = browser.get(callback)
        assertEquals("/?auth=auth_expired", wrongBrowser.headers[HttpHeaders.Location]); assertEquals(0, verifications)
        val returned = browser.get(callback) { header(HttpHeaders.Cookie, binder) }
        assertEquals("/?auth=profile-required", returned.headers[HttpHeaders.Location]); assertEquals(1, verifications)
        val signup = returned.headers.getAll(HttpHeaders.SetCookie)!!.first { it.startsWith("__Host-zhiv_signup=") }
        assertContains(signup, "HttpOnly"); assertContains(signup, "Secure"); assertContains(signup, "SameSite=Lax")
        assertTrue(returned.headers.getAll(HttpHeaders.SetCookie)!!.none { it.startsWith("${config.cookieName}=") })
        val cookies = "$binder; ${signup.substringBefore(';')}"
        val pending = browser.get("/api/v1/auth/registration") { header(HttpHeaders.Cookie, cookies) }
        assertEquals("{\"pending\":true}", pending.bodyAsText())
        val blocked = browser.post("/api/v1/auth/registration") {
            header(HttpHeaders.Cookie, cookies); header(HttpHeaders.Origin, "https://evil.example")
            contentType(ContentType.Application.Json); setBody("""{"displayName":"Wrong origin"}""")
        }
        assertEquals(HttpStatusCode.Forbidden, blocked.status)
        val completed = browser.post("/api/v1/auth/registration") {
            header(HttpHeaders.Cookie, cookies); header(HttpHeaders.Origin, "https://im-alive.ru")
            contentType(ContentType.Application.Json); setBody("""{"displayName":"Дима"}""")
        }
        assertEquals(HttpStatusCode.OK, completed.status)
        val sessionA = completed.headers.getAll(HttpHeaders.SetCookie)!!.first { it.startsWith("${config.cookieName}=") }.substringBefore(';')
        assertEquals(HttpStatusCode.OK, browser.get("/api/v1/me") { header(HttpHeaders.Cookie, sessionA) }.status)
        val second = start()
        val secondBody = Json.parseToJsonElement(second.bodyAsText()).jsonObject
        val secondBinder = second.headers[HttpHeaders.SetCookie]!!.substringBefore(';')
        val existing = browser.get("/api/v1/auth/vk/callback?state=${secondBody["flow"]!!.jsonPrimitive.content}&code=test&device_id=device") { header(HttpHeaders.Cookie, secondBinder) }
        assertEquals("/?auth=signed-in", existing.headers[HttpHeaders.Location])
        val sessionB = existing.headers.getAll(HttpHeaders.SetCookie)!!.first { it.startsWith("${config.cookieName}=") }.substringBefore(';')
        val meA = browser.get("/api/v1/me") { header(HttpHeaders.Cookie, sessionA) }
        val meB = browser.get("/api/v1/me") { header(HttpHeaders.Cookie, sessionB) }
        assertEquals(HttpStatusCode.OK, meA.status); assertEquals(HttpStatusCode.OK, meB.status)
        assertEquals(Json.parseToJsonElement(meA.bodyAsText()).jsonObject["user"], Json.parseToJsonElement(meB.bodyAsText()).jsonObject["user"])
        val replay = browser.get(callback) { header(HttpHeaders.Cookie, binder) }
        assertEquals("/?auth=auth_expired", replay.headers[HttpHeaders.Location]); assertEquals(2, verifications)

        val sessionHash = tokens.hash(sessionB.substringAfter('='))
        val sessionsBefore = auth.access(sessionHash).sessions.map { it.id }.toSet()
        val revisit = browser.get(callback) { header(HttpHeaders.Cookie, "$binder; $sessionB") }
        assertEquals(HttpStatusCode.Found, revisit.status)
        assertEquals("/", revisit.headers[HttpHeaders.Location])
        assertEquals("no-store", revisit.headers[HttpHeaders.CacheControl])
        assertEquals("no-referrer", revisit.headers["Referrer-Policy"])
        assertTrue(revisit.headers.getAll(HttpHeaders.SetCookie).isNullOrEmpty())
        assertEquals(2, verifications)
        assertEquals(sessionsBefore, auth.access(sessionHash).sessions.map { it.id }.toSet())

        val wrongBinder = browser.get(callback) {
            header(HttpHeaders.Cookie, "__Host-zhiv_login=${tokens.issue().raw}; $sessionB")
        }
        assertEquals("/?auth=auth_expired", wrongBinder.headers[HttpHeaders.Location])
        assertEquals(2, verifications)
        auth.revoke(sessionHash)
        val revoked = browser.get(callback) { header(HttpHeaders.Cookie, "$binder; $sessionB") }
        assertEquals("/?auth=auth_expired", revoked.headers[HttpHeaders.Location])
        assertEquals(2, verifications)
    }

    @Test fun `email login discovers new profile only after OTP and creates it after name`() = testApplication {
        var deliveredCode = ""
        val config = AppConfig("unused", "unused", "unused", true, setOf("https://im-alive.ru"))
        application {
            installZhivApi(identities, identities, config, auth = auth,
                authConfig = AuthConfig(origin = "https://im-alive.ru", codeSecret = "test-secret"),
                mailer = LoginMailer { _, code -> deliveredCode = code },
            )
        }
        val browser = createClient { followRedirects = false }
        val started = browser.post("/api/v1/auth/email/start") {
            contentType(ContentType.Application.Json); header(HttpHeaders.Origin, "https://im-alive.ru")
            setBody("""{"intent":"login","email":"${UUID.randomUUID()}@example.com"}""")
        }
        assertEquals(HttpStatusCode.OK, started.status)
        val startedBody = Json.parseToJsonElement(started.bodyAsText()).jsonObject
        val loginCookie = started.headers[HttpHeaders.SetCookie]!!.substringBefore(';')
        val requestBody = """{"flow":"${startedBody["flow"]!!.jsonPrimitive.content}","code":"$deliveredCode"}"""
        assertEquals(HttpStatusCode.Unauthorized, browser.get("/api/v1/me") { header(HttpHeaders.Cookie, loginCookie) }.status)
        val verified = browser.post("/api/v1/auth/email/verify") {
            contentType(ContentType.Application.Json); header(HttpHeaders.Origin, "https://im-alive.ru")
            header(HttpHeaders.Cookie, loginCookie); setBody(requestBody)
        }
        assertEquals(HttpStatusCode.OK, verified.status)
        assertEquals("profile-required", Json.parseToJsonElement(verified.bodyAsText()).jsonObject["status"]!!.jsonPrimitive.content)
        val signup = verified.headers.getAll(HttpHeaders.SetCookie)!!.first { it.startsWith("__Host-zhiv_signup=") }.substringBefore(';')
        val cookies = "$loginCookie; $signup"
        assertEquals(HttpStatusCode.Unauthorized, browser.get("/api/v1/me") { header(HttpHeaders.Cookie, cookies) }.status)
        val replay = browser.post("/api/v1/auth/email/verify") {
            contentType(ContentType.Application.Json); header(HttpHeaders.Origin, "https://im-alive.ru")
            header(HttpHeaders.Cookie, cookies); setBody(requestBody)
        }
        assertEquals(HttpStatusCode.BadRequest, replay.status)
        assertEquals("{\"pending\":true}", browser.get("/api/v1/auth/registration") { header(HttpHeaders.Cookie, cookies) }.bodyAsText())
        val completed = browser.post("/api/v1/auth/registration") {
            contentType(ContentType.Application.Json); header(HttpHeaders.Origin, "https://im-alive.ru")
            header(HttpHeaders.Cookie, cookies); setBody("""{"displayName":"Почтовый профиль"}""")
        }
        assertEquals(HttpStatusCode.OK, completed.status)
        val session = completed.headers.getAll(HttpHeaders.SetCookie)!!.first { it.startsWith("${config.cookieName}=") }.substringBefore(';')
        val account = browser.get("/api/v1/auth/account") { header(HttpHeaders.Cookie, session) }
        assertEquals(HttpStatusCode.OK, account.status); assertContains(account.bodyAsText(), "email")
    }

    @Test fun `OTP attempts commit and correct codes are browser bound expiring and one use`(): Unit = runBlocking {
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

    @Test fun `mailbox cooldown and Telegram state survive across requests`(): Unit = runBlocking {
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
