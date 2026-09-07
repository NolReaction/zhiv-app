package ru.zhiv.observability

import io.ktor.client.request.get
import io.ktor.client.request.header
import io.ktor.client.statement.bodyAsText
import io.ktor.http.ContentType
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpStatusCode
import io.ktor.server.testing.testApplication
import ru.zhiv.checkins.CheckInRepository
import ru.zhiv.checkins.CheckInResult
import ru.zhiv.config.AppConfig
import ru.zhiv.identity.DisplayNameUpdateResult
import ru.zhiv.identity.IdentityRepository
import ru.zhiv.identity.UserSnapshot
import ru.zhiv.installZhivApi
import java.util.UUID
import kotlin.test.Test
import kotlin.test.assertContains
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertTrue

class MetricsEndpointContractTest {
    private val scrapeToken = "aB2_-".repeat(12) + "abcd"
    private fun config(token: String? = null) = AppConfig(
        databaseUrl = "unused", databaseUser = "unused", databasePassword = "unused",
        production = false, allowedOrigins = setOf("http://localhost"), metricsScrapeToken = token,
    )

    @Test
    fun `scraping is disabled by default even with a supplied bearer token`() = testApplication {
        val repository = UnusedRepository()
        application { installZhivApi(repository, repository, config()) }
        for (authorization in listOf(null, "Bearer $scrapeToken")) {
            val response = client.get("/internal/metrics") {
                if (authorization != null) header(HttpHeaders.Authorization, authorization)
            }
            assertEquals(HttpStatusCode.NotFound, response.status)
            assertEquals("no-store", response.headers[HttpHeaders.CacheControl])
            assertFalse(response.bodyAsText().contains("zhiv_http"))
        }
    }

    @Test
    fun `metrics require the exact scrape bearer and are not granted by browser session or role headers`() = testApplication {
        val repository = UnusedRepository()
        val configuration = config(scrapeToken)
        application { installZhivApi(repository, repository, configuration) }
        for (authorization in listOf(null, "Bearer wrong", "Bearer ${"z".repeat(64)}", "Basic $scrapeToken", "Bearer 39QC-QR3A-F92Q")) {
            val response = client.get("/internal/metrics") {
                if (authorization != null) header(HttpHeaders.Authorization, authorization)
                header(HttpHeaders.Cookie, "${configuration.cookieName}=$scrapeToken")
                header("X-Role", "admin")
                header("X-Admin-Public-Id", "39QC-QR3A-F92Q")
            }
            assertEquals(HttpStatusCode.NotFound, response.status)
            assertEquals("no-store", response.headers[HttpHeaders.CacheControl])
            assertFalse(response.bodyAsText().contains("zhiv_http"))
            assertFalse(response.bodyAsText().contains(scrapeToken))
        }
        val accepted = client.get("/internal/metrics") { header(HttpHeaders.Authorization, "Bearer $scrapeToken") }
        assertEquals(HttpStatusCode.OK, accepted.status)
        assertEquals("no-store", accepted.headers[HttpHeaders.CacheControl])
        val type = assertNotNull(accepted.headers[HttpHeaders.ContentType])
        assertTrue(ContentType.parse(type).match(ContentType.Text.Plain))
        assertContains(type, "version=0.0.4")
        val body = accepted.bodyAsText()
        assertContains(body, "# TYPE zhiv_http_requests_total counter")
        assertContains(body, "zhiv_game_taps_total{result=\"accepted\"}")
        assertContains(body, "zhiv_jvm_heap_used_bytes")
        assertFalse(body.contains(scrapeToken))
    }

    private class UnusedRepository : IdentityRepository, CheckInRepository {
        override suspend fun bootstrap(displayName: String, bootstrapKeyHash: ByteArray, sessionTokenHash: ByteArray, sessionLifetimeDays: Long, timeZone: String): UserSnapshot = error("Not used by scrape endpoint")
        override suspend fun findBySession(sessionTokenHash: ByteArray): UserSnapshot? = null
        override suspend fun updateDisplayName(sessionTokenHash: ByteArray, displayName: String, idempotencyKey: UUID): DisplayNameUpdateResult = error("Not used by scrape endpoint")
        override suspend fun record(sessionTokenHash: ByteArray, idempotencyKey: UUID): CheckInResult = error("Not used by scrape endpoint")
    }
}
