package ru.zhiv.onboarding

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
import kotlinx.serialization.json.Json
import ru.zhiv.auth.AuthFailure
import ru.zhiv.config.AppConfig
import ru.zhiv.http.ApiErrorResponse
import ru.zhiv.security.TokenCodec
import kotlin.test.*
import kotlin.time.Duration.Companion.hours

class OnboardingRoutesTest {
    private val owner = "0000-0000-0001"
    private val config = AppConfig("jdbc:postgresql://localhost/test", "test", "test", false, setOf("https://im-alive.ru"))
    private class Fake : OnboardingRepository {
        var writes = 0
        override suspend fun read(hash: ByteArray, owner: String) = OnboardingView(owner, null, null)
        override suspend fun save(hash: ByteArray, decision: OnboardingDecision): OnboardingView {
            writes++
            return OnboardingView(decision.ownerPublicId, if (decision.course == "app") decision.status else null,
                if (decision.course == "world") decision.status else null)
        }
    }
    private fun ApplicationTestBuilder.setup(repo: Fake) {
        application {
            install(ContentNegotiation) { json(Json { encodeDefaults = true; explicitNulls = true }) }
            install(RateLimit) {
                listOf("world-read", "world-write").forEach { name -> register(RateLimitName(name)) { rateLimiter(limit = 100, refillPeriod = 1.hours) } }
            }
            install(StatusPages) { exception<AuthFailure> { call, error -> call.respond(HttpStatusCode.fromValue(error.status), ApiErrorResponse(error.code, error.message)) } }
            routing { onboardingRoutes(repo, TokenCodec(), config) }
        }
    }
    private fun HttpRequestBuilder.authorized() {
        cookie(config.cookieName, "test-session")
        header(HttpHeaders.Origin, "https://im-alive.ru")
        contentType(ContentType.Application.Json)
    }
    @Test fun `terminal preference requires authentication origin and exact contract without an active gameplay lease`() = testApplication {
        val repo = Fake(); setup(repo)
        assertEquals(HttpStatusCode.Unauthorized, client.get("/api/v1/onboarding?ownerPublicId=$owner").status)
        assertEquals(HttpStatusCode.BadRequest, client.get("/api/v1/onboarding") { authorized() }.status)
        assertEquals(HttpStatusCode.BadRequest, client.get("/api/v1/onboarding?ownerPublicId=$owner&ownerPublicId=$owner") { authorized() }.status)
        assertEquals(HttpStatusCode.Forbidden, client.post("/api/v1/onboarding") { cookie(config.cookieName, "test"); contentType(ContentType.Application.Json); setBody("{}") }.status)
        for (body in listOf("{}", """{"ownerPublicId":"$owner","course":"world","status":"started"}""",
            """{"ownerPublicId":"$owner","course":"world","status":"completed","rewardReady":true}""",
            """{"ownerPublicId":"$owner","course":"world","status":1}""")) {
            assertEquals(HttpStatusCode.BadRequest, client.post("/api/v1/onboarding") { authorized(); setBody(body) }.status)
        }
        assertEquals(0, repo.writes)
        val response = client.post("/api/v1/onboarding") { authorized(); setBody("""{"ownerPublicId":"$owner","course":"world","status":"completed"}""") }
        assertEquals(HttpStatusCode.OK, response.status)
        assertEquals("no-store", response.headers[HttpHeaders.CacheControl])
        assertContains(response.bodyAsText(), "\"world\":\"completed\"")
        assertEquals(1, repo.writes)
    }
}
