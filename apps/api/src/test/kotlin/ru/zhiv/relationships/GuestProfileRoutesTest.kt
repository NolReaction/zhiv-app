package ru.zhiv.relationships

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
import kotlinx.serialization.json.*
import org.junit.jupiter.api.Test
import ru.zhiv.auth.AuthFailure
import ru.zhiv.config.AppConfig
import ru.zhiv.http.ApiErrorResponse
import ru.zhiv.security.TokenCodec
import java.util.UUID
import kotlin.test.*
import kotlin.time.Duration.Companion.hours

class GuestProfileRoutesTest {
    private val config = AppConfig("unused", "unused", "unused", true, setOf("https://im-alive.ru"))
    private val circle = UUID.randomUUID()
    private val path = "/api/v1/people/$circle/game-profile"
    private class Fake : GuestProfileRepository {
        var reads = 0
        var stats: GuestTapStats? = null
        override suspend fun profile(sessionHash: ByteArray, circleId: UUID): GuestProfile {
            reads++
            return GuestProfile("0000-0000-0001", circleId.toString(), GuestProfileUser("0000-0000-0002", "Друг"),
                1, 0, emptyList(), GuestCollections(emptyList(), emptyList(), emptyList()), "2026-10-21T00:00:00Z", stats)
        }
    }
    private fun ApplicationTestBuilder.setup(repository: Fake) {
        application {
            install(ContentNegotiation) { json(Json { encodeDefaults = true; explicitNulls = true }) }
            install(RateLimit) { register(RateLimitName("relationships")) { rateLimiter(limit = 100, refillPeriod = 1.hours) } }
            install(StatusPages) { exception<AuthFailure> { call, error ->
                call.respond(HttpStatusCode.fromValue(error.status), ApiErrorResponse(error.code, error.message))
            } }
            routing { guestProfileRoutes(repository, TokenCodec(), config) }
        }
    }

    @Test fun `only an exact protocol header extends the strict legacy projection`() = testApplication {
        val repository = Fake(); setup(repository)
        suspend fun read(version: String?): JsonObject {
            val response = client.get(path) { cookie(config.cookieName, "test-session"); version?.let { header("X-Zhiv-Profile", it) } }
            assertEquals(HttpStatusCode.OK, response.status)
            assertEquals("no-store", response.headers[HttpHeaders.CacheControl])
            return Json.parseToJsonElement(response.bodyAsText()).jsonObject
        }
        val legacyKeys = setOf("ownerPublicId", "circleId", "user", "homeLevel", "completedExplorations", "achievements", "collections", "serverTime")
        assertEquals(legacyKeys, read(null).keys)
        assertEquals(JsonNull, read("tap-stats-v1")["tapStats"])
        repository.stats = GuestTapStats(12345, 678)
        val extended = read("tap-stats-v1")
        assertEquals(legacyKeys + "tapStats", extended.keys)
        assertEquals(buildJsonObject { put("lifetimeTaps", 12345); put("bestSeries", 678) }, extended["tapStats"])
        for (version in listOf(null, "tap-stats-v2", "TAP-STATS-V1", "tap-stats-v1, tap-stats-v1"))
            assertEquals(legacyKeys, read(version).keys)
        repository.stats = null
        assertEquals(JsonNull, read("tap-stats-v1")["tapStats"])
    }

    @Test fun `negotiating tap statistics cannot bypass authentication or the query guard`() = testApplication {
        val repository = Fake(); setup(repository)
        assertEquals(HttpStatusCode.Unauthorized, client.get(path) { header("X-Zhiv-Profile", "tap-stats-v1") }.status)
        assertEquals(HttpStatusCode.BadRequest, client.get("$path?include=tapStats") {
            cookie(config.cookieName, "test-session"); header("X-Zhiv-Profile", "tap-stats-v1")
        }.status)
        assertEquals(0, repository.reads)
    }
}
