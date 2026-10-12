package ru.zhiv.promo

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
import ru.zhiv.economy.*
import ru.zhiv.http.ApiErrorResponse
import ru.zhiv.security.TokenCodec
import java.util.UUID
import kotlin.test.*
import kotlin.time.Duration.Companion.minutes

class PromoRoutesTest {
    private val config = AppConfig("unused", "unused", "unused", true, setOf("https://im-alive.ru"))
    private val request = PromoRequest(UUID.randomUUID().toString(), "0000-0000-0001", 0, " test-gift ")
    private class FakePromo : PromoRepository {
        var calls = 0; var code = ""
        override suspend fun redeem(sessionHash: ByteArray, request: PromoRequest): PromoResult {
            calls++; code = request.code
            throw AuthFailure("PROMO_NOT_FOUND", "Промокод не найден", 409)
        }
    }
    private fun ApplicationTestBuilder.setup(repository: FakePromo, limit: Int = 100) {
        application {
            install(ContentNegotiation) { json(promoJson) }
            install(RateLimit) { register(RateLimitName("promo-write")) { rateLimiter(limit = limit, refillPeriod = 1.minutes) } }
            install(StatusPages) { exception<AuthFailure> { call, error -> call.respond(HttpStatusCode.fromValue(error.status), ApiErrorResponse(error.code, error.message)) } }
            routing { promoRoutes(repository, TokenCodec(), config) }
        }
    }
    private fun HttpRequestBuilder.authorized() {
        cookie(config.cookieName, "test-session"); header(HttpHeaders.Origin, "https://im-alive.ru"); contentType(ContentType.Application.Json)
    }
    @Test fun `writes reject absent session and untrusted origin without touching repository`() = testApplication {
        val repo = FakePromo(); setup(repo)
        assertEquals(HttpStatusCode.Unauthorized, client.post("/api/v1/economy/promo") { header(HttpHeaders.Origin, "https://im-alive.ru"); contentType(ContentType.Application.Json); setBody(promoJson.encodeToString(request)) }.status)
        assertEquals(HttpStatusCode.Forbidden, client.post("/api/v1/economy/promo") { cookie(config.cookieName, "test"); contentType(ContentType.Application.Json); setBody(promoJson.encodeToString(request)) }.status)
        assertEquals(0, repo.calls)
        val response = client.post("/api/v1/economy/promo") { authorized(); setBody(promoJson.encodeToString(request)) }
        assertEquals(HttpStatusCode.Conflict, response.status); assertEquals("no-store", response.headers[HttpHeaders.CacheControl])
        assertEquals("TEST-GIFT", repo.code); assertEquals(1, repo.calls)
    }
    @Test fun `unknown fields strings in number fields and invalid codes reject before repository`() = testApplication {
        val repo = FakePromo(); setup(repo)
        val valid = promoJson.encodeToString(request)
        for (bad in listOf(valid.dropLast(1) + ",\"reward\":{\"coins\":999}}", valid.replace("\"expectedRevision\":0", "\"expectedRevision\":\"0\""),
            promoJson.encodeToString(request.copy(code = "не-код")), promoJson.encodeToString(request.copy(requestId = "bad")))) {
            assertEquals(HttpStatusCode.BadRequest, client.post("/api/v1/economy/promo") { authorized(); setBody(bad) }.status)
        }
        assertEquals(0, repo.calls)
    }
    @Test fun `excess attempts stop before repository and advertise retry delay`() = testApplication {
        val repo = FakePromo(); setup(repo, 2)
        repeat(2) { client.post("/api/v1/economy/promo") { authorized(); setBody(promoJson.encodeToString(request)) } }
        val response = client.post("/api/v1/economy/promo") { authorized(); setBody(promoJson.encodeToString(request)) }
        assertEquals(HttpStatusCode.TooManyRequests, response.status); assertNotNull(response.headers[HttpHeaders.RetryAfter]); assertEquals(2, repo.calls)
    }
}
