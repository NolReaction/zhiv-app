package ru.zhiv.observability

import io.ktor.client.request.cookie
import io.ktor.client.request.get
import io.ktor.client.statement.bodyAsText
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpStatusCode
import io.ktor.serialization.kotlinx.json.json
import io.ktor.server.application.install
import io.ktor.server.plugins.contentnegotiation.ContentNegotiation
import io.ktor.server.plugins.ratelimit.RateLimit
import io.ktor.server.plugins.ratelimit.RateLimitName
import io.ktor.server.plugins.statuspages.StatusPages
import io.ktor.server.response.respond
import io.ktor.server.routing.routing
import io.ktor.server.testing.testApplication
import kotlinx.serialization.json.*
import ru.zhiv.admin.*
import ru.zhiv.auth.AuthFailure
import ru.zhiv.config.AppConfig
import ru.zhiv.config.MapTilerServiceToken
import ru.zhiv.security.TokenCodec
import java.nio.file.Files
import java.util.UUID
import kotlin.test.*
import kotlin.time.Duration.Companion.hours

class ApiUsageRoutesTest {
    private val config = AppConfig("unused", "unused", "unused", true, setOf("https://im-alive.ru"))
    private val path = "/api/v1/admin/api-usage"
    private class Repository : AdminRepository {
        private val hash = TokenCodec().hash("admin-session")
        var accesses = 0
        var revokeAfterRead = false
        override suspend fun access(sessionHash: ByteArray): AdminAccess {
            if (!hash.contentEquals(sessionHash)) throw AuthFailure("ADMIN_FORBIDDEN", "Нет доступа", 403)
            accesses++
            if (revokeAfterRead && accesses % 2 == 0) throw AuthFailure("UNAUTHORIZED", "Сеанс отозван", 401)
            return AdminAccess("7K3P-2Q9M-W8ZR", "Admin", "2026-10-21T00:00:00Z")
        }
        override suspend fun rewards(sessionHash: ByteArray, targetPublicId: String): AdminRewards = error("Unexpected read")
        override suspend fun grantReward(sessionHash: ByteArray, targetPublicId: String, requestId: UUID, request: AdminGrantRequest): AdminGrantReceipt = error("Unexpected write")
        override suspend fun overview(sessionHash: ByteArray, days: Int): AdminOverview = error("Unexpected read")
        override suspend fun users(sessionHash: ByteArray, query: String, sort: String, offset: Int, limit: Int): AdminUsers = error("Unexpected read")
        override suspend fun revokeSessions(sessionHash: ByteArray, targetPublicId: String, requestId: UUID, confirmationPublicId: String, reason: String): AdminRevokeReceipt = error("Unexpected write")
        override suspend fun audit(sessionHash: ByteArray, offset: Int, limit: Int): AdminAudit = error("Unexpected read")
    }
    private fun token(): MapTilerServiceToken {
        val file = Files.createTempFile("usage-route-token-", ".txt")
        return try { Files.writeString(file, "fixture-private-service-token"); MapTilerServiceToken.fromFile(file.toString()) }
        finally { Files.deleteIfExists(file) }
    }

    @Test fun `route authenticates before provider access rejects selectors and revalidates before disclosure`() = testApplication {
        val repository = Repository()
        var requests = 0
        val metrics = RuntimeMetrics().also {
            it.recordRequest("GET", "/api/v1/session", 200, 1)
            it.recordRequest("GET", "/api/v1/session", 503, 1)
            it.recordRequest("GET", "/api/v1/session", 429, 1)
        }
        val service = MapTilerUsageService(token(), transport = UsageProviderTransport { _, _ ->
            requests++
            UsageProviderResponse(200, """{"since":"2026-10-01","until":"2026-10-21","datasets":[]}""")
        })
        application {
            install(ContentNegotiation) { json(Json { encodeDefaults = true; explicitNulls = true }) }
            install(StatusPages) { exception<AuthFailure> { call, failure -> call.respond(HttpStatusCode.fromValue(failure.status), mapOf("code" to failure.code)) } }
            install(RateLimit) { register(RateLimitName("admin-read")) { rateLimiter(100, 1.hours) } }
            routing { apiUsageRoutes(repository, TokenCodec(), config, metrics, service) }
        }
        assertEquals(HttpStatusCode.Unauthorized, client.get(path).status)
        assertEquals(HttpStatusCode.Forbidden, client.get(path) { cookie(config.cookieName, "forged") }.status)
        for (query in listOf("?period=7", "?period=past_30_days&period=past_90_days", "?url=https://untrusted.invalid/", "?token=forged")) {
            assertEquals(HttpStatusCode.BadRequest, client.get(path + query) { cookie(config.cookieName, "admin-session") }.status)
        }
        assertEquals(0, requests)
        val response = client.get(path) { cookie(config.cookieName, "admin-session") }
        assertEquals(HttpStatusCode.OK, response.status)
        assertEquals("no-store", response.headers[HttpHeaders.CacheControl])
        assertEquals("noindex, nofollow", response.headers["X-Robots-Tag"])
        val text = response.bodyAsText()
        val result = Json.parseToJsonElement(text).jsonObject
        assertEquals("7K3P-2Q9M-W8ZR", result.getValue("actorPublicId").jsonPrimitive.content)
        assertEquals(3L, result.getValue("api").jsonObject.getValue("requests").jsonPrimitive.long)
        assertEquals(1L, result.getValue("api").jsonObject.getValue("errors").jsonPrimitive.long)
        assertEquals(1L, result.getValue("api").jsonObject.getValue("throttled").jsonPrimitive.long)
        assertEquals(1, requests)
        assertFalse(text.contains("fixture-private"))
        repository.accesses = 0; repository.revokeAfterRead = true
        assertEquals(HttpStatusCode.Unauthorized, client.get(path) { cookie(config.cookieName, "admin-session") }.status)
        assertEquals(1, requests, "rechecking a cached response still revalidates administrator access")
    }
}
