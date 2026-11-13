package ru.zhiv.db

import com.zaxxer.hikari.HikariDataSource
import io.ktor.client.request.*
import io.ktor.client.statement.bodyAsText
import io.ktor.http.*
import io.ktor.server.testing.testApplication
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.jupiter.api.AfterAll
import org.junit.jupiter.api.BeforeAll
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.TestInstance
import org.testcontainers.containers.PostgreSQLContainer
import org.testcontainers.junit.jupiter.Container
import org.testcontainers.junit.jupiter.Testcontainers
import ru.zhiv.auth.*
import ru.zhiv.config.AppConfig
import ru.zhiv.installZhivApi
import ru.zhiv.security.SessionToken
import ru.zhiv.security.TokenCodec
import java.util.UUID
import kotlin.test.*

@Testcontainers(disabledWithoutDocker = true)
@TestInstance(TestInstance.Lifecycle.PER_CLASS)
class JdbcMobileAuthRepositoryIntegrationTest {
    private class Postgres(image: String) : PostgreSQLContainer<Postgres>(image)
    companion object { @Container private val postgres = Postgres("postgres:18-alpine") }
    private lateinit var source: HikariDataSource
    private lateinit var mobile: JdbcMobileAuthRepository
    private lateinit var auth: JdbcAuthRepository
    private lateinit var identities: JdbcZhivRepository
    private val tokens = TokenCodec()
    private val verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"

    @BeforeAll fun setup() {
        source = DatabaseFactory.create(AppConfig(postgres.jdbcUrl, postgres.username, postgres.password, false, setOf("http://localhost")))
        DatabaseFactory.migrate(source)
        mobile = JdbcMobileAuthRepository(source); auth = JdbcAuthRepository(source); identities = JdbcZhivRepository(source)
    }
    @AfterAll fun stop() { source.close() }

    private suspend fun browser(): SessionToken = tokens.issue().also { session ->
        identities.bootstrap("Мобильный игрок", tokens.issue().hash, session.hash, 365)
    }
    private suspend fun authorize(browser: SessionToken): MobileAuthorization {
        val request = MobileExchangeRequest(tokens.issue().raw, verifier, tokens.issue().raw, "ios")
        val authorization = mobileExchangeProof(request, tokens)
        mobile.authorize(browser.hash, authorization)
        return authorization
    }
    private fun newSession() = issueMobileToken(tokens).let { SessionToken(it, tokens.hash(it)) }

    @Test fun `exchange creates independently revocable session for existing user and consumes code exactly once`(): Unit = runBlocking {
        val browser = browser(); val code = authorize(browser); val native = newSession()
        val user = identities.findSessionUserId(browser.hash)
        val grant = mobile.exchange(code, native.hash, 365)
        assertEquals(user, grant.userId); assertEquals(user, identities.findSessionUserId(native.hash))
        assertTrue(auth.access(native.hash).sessions.any { it.current && it.label == "Мохлик · iOS" })
        assertFailsWith<AuthFailure> { mobile.exchange(code, newSession().hash, 365) }
        auth.revoke(native.hash)
        assertNull(identities.findSessionUserId(native.hash)); assertEquals(user, identities.findSessionUserId(browser.hash))
    }

    @Test fun `wrong PKCE state or platform never issues a session`(): Unit = runBlocking {
        val browser = browser(); val code = authorize(browser); val native = newSession()
        for (wrong in listOf(code.copy(challenge = "x".repeat(43)), code.copy(stateHash = tokens.issue().hash), code.copy(platform = "android"))) {
            assertFailsWith<AuthFailure> { mobile.exchange(wrong, native.hash, 365) }
            assertNull(identities.findSessionUserId(native.hash))
        }
        assertEquals(identities.findSessionUserId(browser.hash), mobile.exchange(code, native.hash, 365).userId)
    }

    @Test fun `expired proof cannot create a session`(): Unit = runBlocking {
        val browser = browser(); val code = authorize(browser); val native = newSession()
        source.connection.use { c ->
            c.prepareStatement("UPDATE mobile_authorization_codes SET created_at=clock_timestamp()-interval '3 minutes',expires_at=clock_timestamp()-interval '1 minute' WHERE code_hash=?").use {
                it.setBytes(1, code.codeHash); assertEquals(1, it.executeUpdate())
            }
            c.commit()
        }
        assertFailsWith<AuthFailure> { mobile.exchange(code, native.hash, 365) }
        assertNull(identities.findSessionUserId(native.hash))
    }

    @Test fun `logout after browser consent invalidates unconsumed proof`(): Unit = runBlocking {
        val browser = browser(); val code = authorize(browser); val native = newSession()
        auth.revoke(browser.hash)
        assertFailsWith<AuthFailure> { mobile.exchange(code, native.hash, 365) }
        assertNull(identities.findSessionUserId(native.hash))
    }

    @Test fun `concurrent exchanges mint one session`(): Unit = runBlocking {
        val browser = browser(); val code = authorize(browser)
        val outcomes = coroutineScope { (1..2).map { async { runCatching { mobile.exchange(code, newSession().hash, 365) } } }.awaitAll() }
        assertEquals(1, outcomes.count { it.isSuccess })
        assertEquals(2, auth.access(browser.hash).sessions.size)
    }

    @Test fun `repeat consent state is rejected and another browser session cannot take ownership`(): Unit = runBlocking {
        val first = browser(); val second = browser(); val code = authorize(first)
        assertFailsWith<AuthFailure> { mobile.authorize(first.hash, code.copy(codeHash = tokens.issue().hash)) }
        val native = newSession()
        val grant = mobile.exchange(code, native.hash, 365)
        assertEquals(identities.findSessionUserId(first.hash), grant.userId)
        assertNotEquals(identities.findSessionUserId(second.hash), grant.userId)
    }

    @Test fun `proof remains bound to original account even if source session owner changes`(): Unit = runBlocking {
        val first = browser(); val second = browser(); val sourceSession = tokens.issue(); val native = newSession()
        val originalUser = assertNotNull(identities.findSessionUserId(first.hash))
        val otherUser = assertNotNull(identities.findSessionUserId(second.hash))
        // Bootstrap sessions are bound to their original user by the bootstrap ledger.
        // A later login session can move during an account merge, so use that shape here.
        source.connection.use { c ->
            c.prepareStatement("INSERT INTO app_sessions(user_id,token_hash,expires_at) VALUES (?,?,clock_timestamp()+interval '1 day')").use {
                it.setObject(1, originalUser); it.setBytes(2, sourceSession.hash); assertEquals(1, it.executeUpdate())
            }
            c.commit()
        }
        val code = authorize(sourceSession)
        source.connection.use { c ->
            c.prepareStatement("UPDATE app_sessions SET user_id=? WHERE token_hash=?").use {
                it.setObject(1, otherUser); it.setBytes(2, sourceSession.hash); assertEquals(1, it.executeUpdate())
            }
            c.commit()
        }
        assertEquals(otherUser, identities.findSessionUserId(sourceSession.hash))
        assertFailsWith<AuthFailure> { mobile.exchange(code, native.hash, 365) }
        assertNull(identities.findSessionUserId(native.hash))
    }

    @Test fun `real API accepts native identity and logout while preserving browser CSRF`() = testApplication {
        val browser = browser(); val code = authorize(browser); val native = newSession()
        val grant = mobile.exchange(code, native.hash, 365)
        val config = AppConfig("", "", "", true, setOf("https://example.com"))
        application { installZhivApi(identities, identities, config, auth = auth, mobileAuth = mobile) }
        val browserProfile = client.get("/api/v1/me") { header(HttpHeaders.Cookie, "${config.cookieName}=${browser.raw}") }
        assertEquals(HttpStatusCode.OK, browserProfile.status)
        val profile = client.get("/api/v1/me") { bearerAuth(native.raw) }
        assertEquals(HttpStatusCode.OK, profile.status)
        val nativeBody = profile.bodyAsText()
        val browserPublicId = Json.parseToJsonElement(browserProfile.bodyAsText()).jsonObject.getValue("user").jsonObject.getValue("publicId").jsonPrimitive.content
        val nativePublicId = Json.parseToJsonElement(nativeBody).jsonObject.getValue("user").jsonObject.getValue("publicId").jsonPrimitive.content
        assertEquals(browserPublicId, nativePublicId)
        assertEquals(grant.userId, identities.findSessionUserId(browser.hash))
        assertFalse(nativeBody.contains(grant.userId.toString()), "The public profile must not expose the internal user ID")
        assertEquals(HttpStatusCode.Unauthorized, client.get("/api/v1/me") { header(HttpHeaders.Cookie, "${config.cookieName}=${native.raw}") }.status)
        assertEquals(HttpStatusCode.Forbidden, client.post("/api/v1/auth/logout") { header(HttpHeaders.Cookie, "${config.cookieName}=${browser.raw}") }.status)
        assertEquals(HttpStatusCode.OK, client.post("/api/v1/auth/logout") { bearerAuth(native.raw) }.status)
        assertEquals(HttpStatusCode.Unauthorized, client.get("/api/v1/me") { bearerAuth(native.raw) }.status)
        assertEquals(HttpStatusCode.OK, client.get("/api/v1/me") { header(HttpHeaders.Cookie, "${config.cookieName}=${browser.raw}") }.status)
    }
}
