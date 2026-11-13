package ru.zhiv.auth

import io.ktor.client.request.*
import io.ktor.client.statement.bodyAsText
import io.ktor.http.*
import io.ktor.serialization.kotlinx.json.json
import io.ktor.server.application.call
import io.ktor.server.application.install
import io.ktor.server.plugins.contentnegotiation.ContentNegotiation
import io.ktor.server.plugins.ratelimit.RateLimit
import io.ktor.server.plugins.ratelimit.RateLimitName
import io.ktor.server.plugins.statuspages.StatusPages
import io.ktor.server.response.respond
import io.ktor.server.routing.*
import io.ktor.server.testing.ApplicationTestBuilder
import io.ktor.server.testing.testApplication
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import ru.zhiv.config.AppConfig
import ru.zhiv.http.MobileSessionAuthentication
import ru.zhiv.http.isTrustedWrite
import ru.zhiv.http.sessionCookie
import ru.zhiv.security.TokenCodec
import java.util.UUID
import kotlin.test.*
import kotlin.time.Duration.Companion.hours

class MobileAuthRoutesTest {
    private val tokens = TokenCodec()
    private val mobile = "m1_${"m".repeat(43)}"
    private val browser = "b".repeat(43)
    private val config = AppConfig("", "", "", true, setOf("https://example.com"))

    @Test fun `global IP limiter bounds native session lookup before authentication`() = testApplication {
        var lookups = 0
        application {
            install(RateLimit) { global { rateLimiter(1, 1.hours) } }
            install(MobileSessionAuthentication) { cookieName = config.cookieName; validate = { lookups++; it == mobile } }
            routing { get("/api/v1/probe") { call.respond(HttpStatusCode.OK) } }
        }
        assertEquals(HttpStatusCode.OK, client.get("/api/v1/probe") { bearerAuth(mobile) }.status)
        assertEquals(HttpStatusCode.TooManyRequests, client.get("/api/v1/probe") { bearerAuth(mobile) }.status)
        assertEquals(1, lookups)
    }

    private class Repository : MobileAuthRepository {
        var authorization: MobileAuthorization? = null
        var consumed = false
        override suspend fun authorize(browserSessionHash: ByteArray, authorization: MobileAuthorization) { this.authorization = authorization }
        override suspend fun exchange(authorization: MobileAuthorization, newSessionHash: ByteArray, sessionDays: Long): MobileSessionGrant {
            val expected = this.authorization ?: throw AuthFailure("AUTH_EXPIRED", "Expired")
            if (consumed || !expected.codeHash.contentEquals(authorization.codeHash) || expected.challenge != authorization.challenge ||
                !expected.stateHash.contentEquals(authorization.stateHash) || expected.platform != authorization.platform) throw AuthFailure("AUTH_EXPIRED", "Expired")
            consumed = true
            return MobileSessionGrant(UUID.fromString("01993e7a-3f00-7abc-8def-1234567890ab"), "2030-01-01T00:00:00Z")
        }
    }

    private fun ApplicationTestBuilder.setup(repository: Repository = Repository(), valid: () -> Boolean = { true }) {
        application {
            install(ContentNegotiation) { json() }
            install(StatusPages) { exception<AuthFailure> { call, failure -> call.respond(HttpStatusCode.fromValue(failure.status), mapOf("code" to failure.code)) } }
            install(RateLimit) { register(RateLimitName("auth-entry")) { rateLimiter(100, 1.hours) } }
            install(MobileSessionAuthentication) { cookieName = config.cookieName; validate = { it == mobile && valid() } }
            routing {
                mobileAuthRoutes(repository, tokens, config)
                get("/api/v1/probe") { call.respond(mapOf("token" to call.sessionCookie(config))) }
                post("/api/v1/probe") {
                    if (!call.isTrustedWrite(config)) throw AuthFailure("UNTRUSTED_ORIGIN", "Origin", 403)
                    call.respond(mapOf("token" to call.sessionCookie(config)))
                }
            }
        }
    }

    @Test fun `only verified native token bypasses browser write origin and revocation is immediate`() = testApplication {
        var valid = true
        setup(valid = { valid })
        val accepted = client.post("/api/v1/probe") { bearerAuth(mobile) }
        assertEquals(HttpStatusCode.OK, accepted.status)
        assertContains(accepted.bodyAsText(), mobile)
        valid = false
        assertEquals(HttpStatusCode.Unauthorized, client.post("/api/v1/probe") { bearerAuth(mobile) }.status)
        assertEquals(HttpStatusCode.Unauthorized, client.post("/api/v1/probe") { bearerAuth("m1_${"f".repeat(43)}") }.status)
        assertEquals(HttpStatusCode.Unauthorized, client.post("/api/v1/probe") { bearerAuth(browser) }.status)
        assertEquals(HttpStatusCode.Forbidden, client.post("/api/v1/probe") { header(HttpHeaders.Cookie, "${config.cookieName}=$browser") }.status)
    }

    @Test fun `mobile bearer cannot be smuggled through cookie or mixed with a browser session`() = testApplication {
        setup()
        val cookie = client.get("/api/v1/probe") { header(HttpHeaders.Cookie, "${config.cookieName}=$mobile") }
        assertEquals("{\"token\":null}", cookie.bodyAsText())
        assertEquals(HttpStatusCode.Unauthorized, client.get("/api/v1/probe") {
            bearerAuth(mobile); header(HttpHeaders.Cookie, "${config.cookieName}=$browser")
        }.status)
        assertEquals(HttpStatusCode.OK, client.post("/api/v1/probe") {
            header(HttpHeaders.Origin, "https://example.com"); header(HttpHeaders.Cookie, "${config.cookieName}=$browser")
        }.status)
    }

    @Test fun `browser approval requires origin and browser session even when native is authenticated`() = testApplication {
        setup()
        val body = """{"challenge":"${"c".repeat(43)}","state":"${"s".repeat(43)}","platform":"ios"}"""
        assertEquals(HttpStatusCode.Forbidden, client.post("/api/v1/auth/mobile/authorize") {
            header(HttpHeaders.Cookie, "${config.cookieName}=$browser"); contentType(ContentType.Application.Json); setBody(body)
        }.status)
        assertEquals(HttpStatusCode.Forbidden, client.post("/api/v1/auth/mobile/authorize") {
            bearerAuth(mobile); contentType(ContentType.Application.Json); setBody(body)
        }.status)
        assertEquals(HttpStatusCode.Unauthorized, client.post("/api/v1/auth/mobile/authorize") {
            header(HttpHeaders.Origin, "https://example.com"); contentType(ContentType.Application.Json); setBody(body)
        }.status)
    }

    @Test fun `browser authorization and native exchange return fixed callback then reject replay`() = testApplication {
        val repository = Repository(); setup(repository)
        val verifier = "v".repeat(43); val state = "s".repeat(43)
        val challenge = mobileExchangeProof(MobileExchangeRequest("c".repeat(43), verifier, state, "ios"), tokens).challenge
        val authorization = client.post("/api/v1/auth/mobile/authorize") {
            header(HttpHeaders.Origin, "https://example.com"); header(HttpHeaders.Cookie, "${config.cookieName}=$browser")
            contentType(ContentType.Application.Json); setBody("""{"challenge":"$challenge","state":"$state","platform":"ios"}""")
        }
        assertEquals(HttpStatusCode.OK, authorization.status)
        assertEquals("no-store", authorization.headers[HttpHeaders.CacheControl])
        val url = Json.parseToJsonElement(authorization.bodyAsText()).jsonObject.getValue("url").jsonPrimitive.content
        assertTrue(url.startsWith("$MOBILE_AUTH_CALLBACK?code=")); assertTrue(url.endsWith("&state=$state"))
        val code = url.substringAfter("?code=").substringBefore('&')
        val body = """{"code":"$code","verifier":"$verifier","state":"$state","platform":"ios"}"""
        val exchange = client.post("/api/v1/auth/mobile/exchange") { contentType(ContentType.Application.Json); setBody(body) }
        assertEquals(HttpStatusCode.OK, exchange.status)
        assertEquals("no-store", exchange.headers[HttpHeaders.CacheControl])
        assertNull(exchange.headers[HttpHeaders.SetCookie])
        assertTrue(isMobileToken(Json.parseToJsonElement(exchange.bodyAsText()).jsonObject.getValue("token").jsonPrimitive.content))
        assertEquals(HttpStatusCode.BadRequest, client.post("/api/v1/auth/mobile/exchange") { contentType(ContentType.Application.Json); setBody(body) }.status)
    }

    @Test fun `exchange rejects browser origin and ambient cookie`() = testApplication {
        setup()
        for (entry in listOf(HttpHeaders.Origin to "https://example.com", HttpHeaders.Cookie to "${config.cookieName}=$browser")) {
            assertEquals(HttpStatusCode.Forbidden, client.post("/api/v1/auth/mobile/exchange") {
                header(entry.first, entry.second); contentType(ContentType.Application.Json)
                setBody("""{"code":"${"c".repeat(43)}","verifier":"${"v".repeat(43)}","state":"${"s".repeat(43)}","platform":"ios"}""")
            }.status)
        }
    }
}
