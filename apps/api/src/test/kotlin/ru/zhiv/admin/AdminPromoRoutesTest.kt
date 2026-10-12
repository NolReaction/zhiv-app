package ru.zhiv.admin

import io.ktor.client.request.*
import io.ktor.http.*
import io.ktor.serialization.kotlinx.json.json
import io.ktor.server.application.install
import io.ktor.server.plugins.contentnegotiation.ContentNegotiation
import io.ktor.server.plugins.ratelimit.RateLimit
import io.ktor.server.plugins.ratelimit.RateLimitName
import io.ktor.server.plugins.statuspages.StatusPages
import io.ktor.server.response.respond
import io.ktor.server.routing.routing
import io.ktor.server.testing.ApplicationTestBuilder
import io.ktor.server.testing.testApplication
import kotlinx.serialization.encodeToString
import ru.zhiv.auth.AuthFailure
import ru.zhiv.config.AppConfig
import ru.zhiv.http.ApiErrorResponse
import ru.zhiv.promo.*
import ru.zhiv.security.TokenCodec
import java.util.UUID
import kotlin.test.*
import kotlin.time.Duration.Companion.minutes

class AdminPromoRoutesTest {
    private val config = AppConfig("unused", "unused", "unused", true, setOf("https://im-alive.ru"))
    private val input = AdminPromoCommand(UUID.randomUUID().toString(), "create", "route-gift", 0, "Проверка акции",
        PromoDefinition("route-gift", "ROUTE-GIFT", true, "Подарок", reward = PromoReward(100)))
    private class FakePromos : AdminPromoRepository {
        var writes = 0; var reads = 0
        override suspend fun list(sessionHash: ByteArray): AdminPromos { reads++; return AdminPromos("2026-10-12T00:00:00Z", emptyList()) }
        override suspend fun manage(sessionHash: ByteArray, request: AdminPromoCommand): AdminPromoReceipt {
            writes++; return AdminPromoReceipt(request.requestId, request.action, request.promoId, 1, "2026-10-12T00:00:00Z")
        }
    }
    private fun ApplicationTestBuilder.setup(repo: FakePromos, writeLimit: Int = 100) {
        application {
            install(ContentNegotiation) { json(promoJson) }
            install(RateLimit) {
                register(RateLimitName("admin-read")) { rateLimiter(limit = 100, refillPeriod = 1.minutes) }
                register(RateLimitName("admin-write")) { rateLimiter(limit = writeLimit, refillPeriod = 1.minutes) }
            }
            install(StatusPages) { exception<AuthFailure> { call, error -> call.respond(HttpStatusCode.fromValue(error.status), ApiErrorResponse(error.code, error.message)) } }
            routing { adminPromoRoutes(repo, TokenCodec(), config) }
        }
    }
    private fun HttpRequestBuilder.authorized() {
        cookie(config.cookieName, "test-session"); header(HttpHeaders.Origin, "https://im-alive.ru"); contentType(ContentType.Application.Json)
    }
    @Test fun `routes require cookie and trusted write origin and never cache codes`() = testApplication {
        val repo = FakePromos(); setup(repo)
        assertEquals(HttpStatusCode.Unauthorized, client.get("/api/v1/admin/promos").status)
        val response = client.get("/api/v1/admin/promos") { cookie(config.cookieName, "test-session") }
        assertEquals(HttpStatusCode.OK, response.status); assertEquals("no-store", response.headers[HttpHeaders.CacheControl])
        assertEquals("noindex, nofollow", response.headers["X-Robots-Tag"])
        assertEquals(HttpStatusCode.Forbidden, client.post("/api/v1/admin/promos/manage") {
            cookie(config.cookieName, "test-session"); contentType(ContentType.Application.Json); setBody(promoJson.encodeToString(input))
        }.status)
        assertEquals(HttpStatusCode.Unauthorized, client.post("/api/v1/admin/promos/manage") {
            header(HttpHeaders.Origin, "https://im-alive.ru"); contentType(ContentType.Application.Json); setBody(promoJson.encodeToString(input))
        }.status)
        assertEquals(0, repo.writes); assertEquals(1, repo.reads)
        assertEquals(HttpStatusCode.OK, client.post("/api/v1/admin/promos/manage") { authorized(); setBody(promoJson.encodeToString(input)) }.status)
        assertEquals(1, repo.writes)
    }
    @Test fun `invalid bodies are stopped and write attempts are rate limited`() = testApplication {
        val repo = FakePromos(); setup(repo, writeLimit = 2)
        assertEquals(HttpStatusCode.BadRequest, client.post("/api/v1/admin/promos/manage") { authorized(); setBody("{}") }.status)
        assertEquals(HttpStatusCode.BadRequest, client.post("/api/v1/admin/promos/manage") { authorized(); setBody(promoJson.encodeToString(input.copy(reason = "short"))) }.status)
        val response = client.post("/api/v1/admin/promos/manage") { authorized(); setBody(promoJson.encodeToString(input)) }
        assertEquals(HttpStatusCode.TooManyRequests, response.status); assertNotNull(response.headers[HttpHeaders.RetryAfter]); assertEquals(0, repo.writes)
    }
}
