package ru.zhiv.feedback

import io.ktor.client.request.*
import io.ktor.client.statement.bodyAsText
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
import kotlinx.serialization.json.Json
import ru.zhiv.auth.AuthFailure
import ru.zhiv.config.AppConfig
import ru.zhiv.http.ApiErrorResponse
import ru.zhiv.security.TokenCodec
import java.time.OffsetDateTime
import java.util.UUID
import kotlin.test.*
import kotlin.time.Duration.Companion.hours

class FeedbackRoutesTest {
    private val config = AppConfig("unused", "unused", "unused", true, setOf("https://im-alive.ru"))
    private val request = FeedbackRequest(UUID.randomUUID().toString(), "bug", "Не открывается карта", "0000-0000-0001")
    private class FakeFeedback : FeedbackRepository {
        var calls = 0
        var message = ""
        var cooldown = false
        val now = OffsetDateTime.parse("2026-09-23T17:00:00Z")
        private val id = UUID.randomUUID().toString()
        override suspend fun availability(sessionHash: ByteArray, expectedOwnerPublicId: String) = FeedbackAvailability(now.toString(), true, null)
        override suspend fun submit(sessionHash: ByteArray, expectedOwnerPublicId: String, clientRequestId: UUID, category: String, message: String): FeedbackReceipt {
            calls++; this.message = message
            if (cooldown) throw FeedbackCooldown(now.plusHours(24), now)
            return FeedbackReceipt(id, clientRequestId.toString(), now.toString(), now.plusHours(24).toString(), false)
        }
        override suspend fun list(sessionHash: ByteArray, status: String, category: String, offset: Int, limit: Int) =
            AdminFeedbackPage(now.toString(), 0, offset, limit, emptyList())
        override suspend fun changeStatus(sessionHash: ByteArray, id: UUID, requestId: UUID, status: String) =
            AdminFeedbackItem(id.toString(), "bug", "Test message", status, now.toString(), now.toString(), "0000-0000-0001", "Name")
    }
    private fun ApplicationTestBuilder.setup(repo: FakeFeedback) {
        application {
            install(ContentNegotiation) { json(Json { encodeDefaults = true; explicitNulls = true }) }
            install(RateLimit) {
                listOf("feedback-read", "feedback-write", "admin-read", "admin-write").forEach { name ->
                    register(RateLimitName(name)) { rateLimiter(limit = 100, refillPeriod = 1.hours) }
                }
            }
            install(StatusPages) {
                exception<AuthFailure> { call, error -> call.respond(HttpStatusCode.fromValue(error.status), ApiErrorResponse(error.code, error.message)) }
            }
            routing { feedbackRoutes(repo, TokenCodec(), config) }
        }
    }
    private fun HttpRequestBuilder.authorized() {
        cookie(config.cookieName, "test-session")
        header(HttpHeaders.Origin, "https://im-alive.ru")
        contentType(ContentType.Application.Json)
    }
    @Test fun `writes require session and trusted origin before touching repository`() = testApplication {
        val repo = FakeFeedback(); setup(repo)
        assertEquals(HttpStatusCode.Unauthorized, client.get("/api/v1/feedback").status)
        assertEquals(HttpStatusCode.Forbidden, client.post("/api/v1/feedback") { cookie(config.cookieName, "test"); contentType(ContentType.Application.Json); setBody(Json.encodeToString(request)) }.status)
        assertEquals(0, repo.calls)
        assertEquals(HttpStatusCode.BadRequest, client.get("/api/v1/feedback") { authorized() }.status)
        val availability = client.get("/api/v1/feedback?expectedOwnerPublicId=0000-0000-0001") { authorized() }
        assertEquals(HttpStatusCode.OK, availability.status)
        assertEquals("no-store", availability.headers[HttpHeaders.CacheControl])
        val response = client.post("/api/v1/feedback") { authorized(); setBody(Json.encodeToString(request)) }
        assertEquals(HttpStatusCode.OK, response.status)
        assertEquals("no-store", response.headers[HttpHeaders.CacheControl])
        assertContains(response.bodyAsText(), "nextAllowedAt")
        assertEquals(1, repo.calls)
    }
    @Test fun `category size and request id reject malformed messages and accept full UTF8 text`() = testApplication {
        val repo = FakeFeedback(); setup(repo)
        for (bad in listOf(request.copy(category = "mail"), request.copy(expectedOwnerPublicId = "wrong"), request.copy(message = "short"), request.copy(message = "a".repeat(3001)), request.copy(clientRequestId = "not-a-uuid"), request.copy(message = "Null\u0000 character"), request.copy(message = "😀".repeat(5)))) {
            assertEquals(HttpStatusCode.BadRequest, client.post("/api/v1/feedback") { authorized(); setBody(Json.encodeToString(bad)) }.status)
        }
        assertEquals(0, repo.calls)
        val full = "😀".repeat(3000)
        assertEquals(HttpStatusCode.OK, client.post("/api/v1/feedback") { authorized(); setBody(Json.encodeToString(request.copy(message = full))) }.status)
        assertEquals(full, repo.message)
        assertEquals(HttpStatusCode.OK, client.post("/api/v1/feedback") { authorized(); setBody(Json.encodeToString(request.copy(message = "  Первая строка\r\nВторая строка  "))) }.status)
        assertEquals("Первая строка\nВторая строка", repo.message)
    }
    @Test fun `cooldown gives authoritative dates and RetryAfter without caching`() = testApplication {
        val repo = FakeFeedback().also { it.cooldown = true }; setup(repo)
        val response = client.post("/api/v1/feedback") { authorized(); setBody(Json.encodeToString(request)) }
        assertEquals(HttpStatusCode.TooManyRequests, response.status)
        assertEquals("no-store", response.headers[HttpHeaders.CacheControl])
        assertNotNull(response.headers[HttpHeaders.RetryAfter])
        assertContains(response.bodyAsText(), "FEEDBACK_COOLDOWN")
        assertContains(response.bodyAsText(), "2026-09-24T17:00:00Z")
        assertContains(response.bodyAsText(), "serverTime")
    }
    @Test fun `admin filters pagination and status writes are bounded`() = testApplication {
        val repo = FakeFeedback(); setup(repo)
        for (query in listOf("limit=101", "offset=-1", "status=unknown", "category=unknown", "limit=1&limit=2")) {
            assertEquals(HttpStatusCode.BadRequest, client.get("/api/v1/admin/feedback?$query") { authorized() }.status)
        }
        assertEquals(HttpStatusCode.OK, client.get("/api/v1/admin/feedback?status=new&category=bug&limit=10") { authorized() }.status)
        val path = "/api/v1/admin/feedback/${UUID.randomUUID()}/status"
        assertEquals(HttpStatusCode.Forbidden, client.post(path) { cookie(config.cookieName, "test"); contentType(ContentType.Application.Json); setBody(Json.encodeToString(FeedbackStatusRequest(UUID.randomUUID().toString(), "reviewed"))) }.status)
        assertEquals(HttpStatusCode.BadRequest, client.post(path) { authorized(); setBody(Json.encodeToString(FeedbackStatusRequest(UUID.randomUUID().toString(), "deleted"))) }.status)
    }
}
