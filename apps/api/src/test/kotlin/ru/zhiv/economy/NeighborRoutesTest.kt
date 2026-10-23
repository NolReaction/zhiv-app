package ru.zhiv.economy

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
import org.junit.jupiter.api.Test
import ru.zhiv.auth.AuthFailure
import ru.zhiv.config.AppConfig
import ru.zhiv.http.ApiErrorResponse
import ru.zhiv.security.TokenCodec
import java.util.UUID
import kotlin.test.*
import kotlin.time.Duration.Companion.minutes

class NeighborRoutesTest {
    private val config = AppConfig("unused", "unused", "unused", true, setOf("https://im-alive.ru"))
    private fun command() = EconomyCommand(UUID.randomUUID().toString(), "ABCD-EFGH-JKMP", 0,
        "buy_offer", UUID.randomUUID().toString(), quantity = 1, totalPrice = 20)

    private class FakeNeighbor : NeighborRepository {
        var reads = 0
        var purchases = 0
        var adminReads = 0
        var settingsWrites = 0
        var manualBuys = 0
        var received: EconomyCommand? = null
        override suspend fun neighbor(sessionHash: ByteArray): NeighborView {
            reads++
            throw AuthFailure("NEIGHBOR_UNAVAILABLE", "Лавка отдыхает", 409)
        }
        override suspend fun purchase(sessionHash: ByteArray, command: EconomyCommand): EconomyResult {
            purchases++; received = command
            throw AuthFailure("NEIGHBOR_UNAVAILABLE", "Лавка отдыхает", 409)
        }
        override suspend fun admin(sessionHash: ByteArray, publicId: String?): NeighborAdminView {
            adminReads++
            throw AuthFailure("ADMIN_FORBIDDEN", "Нет доступа", 403)
        }
        override suspend fun settings(sessionHash: ByteArray, command: NeighborSettingsCommand): NeighborAdminView {
            settingsWrites++
            throw AuthFailure("ADMIN_FORBIDDEN", "Нет доступа", 403)
        }
        override suspend fun buy(sessionHash: ByteArray, command: NeighborBuyCommand): NeighborAdminView {
            manualBuys++
            throw AuthFailure("ADMIN_FORBIDDEN", "Нет доступа", 403)
        }
    }

    private fun ApplicationTestBuilder.setup(repository: FakeNeighbor, limit: Int = 100) {
        application {
            install(ContentNegotiation) { json(economyJson) }
            install(RateLimit) {
                for (name in listOf("world-read", "world-write", "admin-read", "admin-write"))
                    register(RateLimitName(name)) { rateLimiter(limit = limit, refillPeriod = 1.minutes) }
            }
            install(StatusPages) {
                exception<AuthFailure> { call, error ->
                    call.respond(HttpStatusCode.fromValue(error.status), ApiErrorResponse(error.code, error.message))
                }
            }
            routing { neighborRoutes(repository, TokenCodec(), config) }
        }
    }

    private fun HttpRequestBuilder.authorized() {
        cookie(config.cookieName, "neighbor-test-session")
        header(HttpHeaders.Origin, "https://im-alive.ru")
        contentType(ContentType.Application.Json)
    }

    @Test fun `neighbor reads require a session and never cache a personal shop`() = testApplication {
        val repository = FakeNeighbor(); setup(repository)
        assertEquals(HttpStatusCode.Unauthorized, client.get("/api/v1/economy/neighbor").status)
        assertEquals(0, repository.reads)
        val response = client.get("/api/v1/economy/neighbor") { cookie(config.cookieName, "test") }
        assertEquals(HttpStatusCode.Conflict, response.status)
        assertEquals("no-store", response.headers[HttpHeaders.CacheControl])
        assertEquals(1, repository.reads)
        assertEquals(0, repository.purchases, "A read cannot invoke purchase processing")
    }

    @Test fun `neighbor purchase requires both session and trusted origin`() = testApplication {
        val repository = FakeNeighbor(); setup(repository)
        val body = economyJson.encodeToString(command())
        assertEquals(HttpStatusCode.Unauthorized, client.post("/api/v1/economy/neighbor/commands") {
            header(HttpHeaders.Origin, "https://im-alive.ru"); contentType(ContentType.Application.Json); setBody(body)
        }.status)
        assertEquals(HttpStatusCode.Forbidden, client.post("/api/v1/economy/neighbor/commands") {
            cookie(config.cookieName, "test"); contentType(ContentType.Application.Json); setBody(body)
        }.status)
        assertEquals(0, repository.purchases)
        val response = client.post("/api/v1/economy/neighbor/commands") { authorized(); setBody(body) }
        assertEquals(HttpStatusCode.Conflict, response.status)
        assertEquals("no-store", response.headers[HttpHeaders.CacheControl])
        assertEquals(1, repository.purchases)
        assertEquals("buy_offer", repository.received?.action)
    }

    @Test fun `malformed purchases cannot reach the repository`() = testApplication {
        val repository = FakeNeighbor(); setup(repository)
        val input = command()
        val valid = economyJson.encodeToString(input)
        for (bad in listOf(
            valid.dropLast(1) + ",\"coins\":999}",
            valid.replace("\"expectedRevision\":0", "\"expectedRevision\":\"0\""),
            valid.replace("\"totalPrice\":20", "\"totalPrice\":\"20\""),
            economyJson.encodeToString(input.copy(action = "create_listing")),
            economyJson.encodeToString(input.copy(targetId = "berries")),
            economyJson.encodeToString(input.copy(quantity = 6)),
            economyJson.encodeToString(input.copy(totalPrice = 0)),
        )) assertEquals(HttpStatusCode.BadRequest, client.post("/api/v1/economy/neighbor/commands") {
            authorized(); setBody(bad)
        }.status, bad)
        assertEquals(0, repository.purchases)
    }

    @Test fun `neighbor writes have a bounded rate independent of shop reads`() = testApplication {
        val repository = FakeNeighbor(); setup(repository, limit = 2)
        repeat(2) {
            client.post("/api/v1/economy/neighbor/commands") { authorized(); setBody(economyJson.encodeToString(command())) }
        }
        val response = client.post("/api/v1/economy/neighbor/commands") {
            authorized(); setBody(economyJson.encodeToString(command()))
        }
        assertEquals(HttpStatusCode.TooManyRequests, response.status)
        assertNotNull(response.headers[HttpHeaders.RetryAfter])
        assertEquals(2, repository.purchases)
        assertEquals(HttpStatusCode.Conflict, client.get("/api/v1/economy/neighbor") { cookie(config.cookieName, "test") }.status)
        assertEquals(1, repository.reads)
    }

    @Test fun `admin writes require trusted sessions and strict unquoted numeric and boolean fields`() = testApplication {
        val repository = FakeNeighbor(); setup(repository)
        val settings = economyJson.encodeToString(NeighborSettingsCommand(UUID.randomUUID().toString(), 0,
            "Проверка настроек соседа", NeighborRules.defaults))
        assertEquals(HttpStatusCode.Unauthorized, client.get("/api/v1/admin/neighbor").status)
        assertEquals(0, repository.adminReads)
        assertEquals(HttpStatusCode.Forbidden, client.post("/api/v1/admin/neighbor/settings") {
            cookie(config.cookieName, "test"); contentType(ContentType.Application.Json); setBody(settings)
        }.status)
        for (bad in listOf(
            settings.replace("\"expectedVersion\":0", "\"expectedVersion\":\"0\""),
            settings.replace("\"dailyBudgetCoins\":300", "\"dailyBudgetCoins\":\"300\""),
            settings.replace("\"enabled\":true", "\"enabled\":\"true\""),
            settings.replace("\"home\":3", "\"home\":\"3\""),
            settings.dropLast(1) + ",\"mintCoins\":999}",
        )) assertEquals(HttpStatusCode.BadRequest, client.post("/api/v1/admin/neighbor/settings") {
            authorized(); setBody(bad)
        }.status, bad)
        assertEquals(0, repository.settingsWrites)
        assertEquals(HttpStatusCode.Forbidden, client.post("/api/v1/admin/neighbor/settings") {
            authorized(); setBody(settings)
        }.status)
        assertEquals(1, repository.settingsWrites)
        val buy = economyJson.encodeToString(NeighborBuyCommand(UUID.randomUUID().toString(), UUID.randomUUID().toString(),
            "ABCD-EFGH-JKMP", 20, "Проверка ручной покупки"))
        assertEquals(HttpStatusCode.BadRequest, client.post("/api/v1/admin/neighbor/buy") {
            authorized(); setBody(buy.replace("\"expectedTotalPrice\":20", "\"expectedTotalPrice\":\"20\""))
        }.status)
        assertEquals(0, repository.manualBuys)
        assertEquals(HttpStatusCode.Forbidden, client.post("/api/v1/admin/neighbor/buy") { authorized(); setBody(buy) }.status)
        assertEquals(1, repository.manualBuys)
    }
}
