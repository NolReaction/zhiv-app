package ru.zhiv.observability

import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import ru.zhiv.config.MapTilerServiceToken
import java.nio.file.Files
import java.time.Clock
import java.time.Instant
import java.time.ZoneOffset
import java.util.concurrent.atomic.AtomicInteger
import kotlin.test.*

class MapTilerUsageTest {
    private val clock = Clock.fixed(Instant.parse("2026-10-21T12:00:00Z"), ZoneOffset.UTC)
    private val fixture = """{"since":"2026-10-01","until":"2026-10-21","datasets":[
      {"group_id":"request","item_id":"tiles","data":[{"date":"2026-10-20","value":10},{"date":"2026-10-19","value":2}],"estimated_data":{"date":"2026-10-31","value":100.25}},
      {"group_id":"request","item_id":"maps","data":[{"date":"2026-10-20","value":3}]},
      {"group_id":"session","item_id":"maps","data":[{"date":"2026-10-20","value":5}]},
      {"group_id":"export","item_id":"tiles","data":[],"estimated_data":{"date":"2026-10-31","value":1}}
    ],"legend":[{"item_id":"tiles","label":"SENSITIVE_KEY_LABEL","description":"SENSITIVE_URL"}]}"""

    private fun token(): MapTilerServiceToken {
        val file = Files.createTempFile("maptiler-test-token-", ".txt")
        return try { Files.writeString(file, "fixture-private-service-token\n"); MapTilerServiceToken.fromFile(file.toString()) }
        finally { Files.deleteIfExists(file) }
    }

    @Test fun `groups aggregate account services by day while estimates and units remain separate`() {
        val result = parseMapTilerUsage(fixture, "current_billing_period", clock.instant().toString())
        assertTrue(result.available)
        assertEquals("account", result.scope)
        assertEquals(listOf("request", "session", "export"), result.groups.map { it.group })
        val requests = result.groups[0]
        assertEquals(15.0, requests.total)
        assertEquals(listOf(MapTilerUsagePoint("2026-10-19", 2.0), MapTilerUsagePoint("2026-10-20", 13.0)), requests.daily)
        assertEquals(listOf(MapTilerUsagePoint("2026-10-31", 100.25)), requests.estimated)
        assertEquals(5.0, result.groups[1].total)
        assertNull(result.groups[2].total, "an estimate without completed days cannot invent zero actual usage")
        assertFalse(Json.encodeToString(result).contains("SENSITIVE"))
        assertEquals(clock.instant().toString(), result.updatedAt)
    }

    @Test fun `empty data stays empty and malformed or unknown data cannot become partial totals`() {
        val empty = parseMapTilerUsage("""{"since":"2026-10-01","until":"2026-10-21","datasets":[]}""", "past_30_days", clock.instant().toString())
        assertTrue(empty.groups.isEmpty())
        for (bad in listOf(
            fixture.replace("\"group_id\":\"export\"", "\"group_id\":\"unknown-unit\""),
            fixture.replace("\"value\":10", "\"value\":-1"),
            fixture.replace("\"value\":10", "\"value\":\"10\""),
            fixture.replace("\"value\":10", "\"value\":1e999"),
            fixture.replace("2026-10-19", "2026-10-20"),
            fixture.replace("\"item_id\":\"maps\",\"data\":[{\"date\":\"2026-10-20\",\"value\":3}", "\"item_id\":\"tiles\",\"data\":[{\"date\":\"2026-10-20\",\"value\":3}"),
            fixture.replace("2026-10-19", "2026-09-30"),
            fixture.replace("2026-10-01", "2026-02-30"),
            fixture.replace("\"data\":[]", "\"data\":null"),
        )) assertFails { parseMapTilerUsage(bad, "past_30_days", clock.instant().toString()) }
    }

    @Test fun `disabled usage never connects and period cannot become arbitrary upstream query`() = runBlocking<Unit> {
        val service = MapTilerUsageService(null, clock, UsageProviderTransport { _, _ -> error("Unexpected network") })
        val result = service.snapshot()
        assertFalse(result.configured)
        assertEquals("MAPTILER_DISABLED", result.error)
        assertFails { service.snapshot("https://untrusted.invalid/?secret") }
    }

    @Test fun `fixed upstream and header-only token use bounded success cache for all three periods`() = runBlocking {
        var elapsed = 0L
        val calls = AtomicInteger()
        val service = MapTilerUsageService(token(), clock, UsageProviderTransport { uri, credential ->
            calls.incrementAndGet()
            assertEquals("https", uri.scheme)
            assertEquals("service.maptiler.com", uri.host)
            assertEquals("/v1/analytics/api_usage/timeline", uri.path)
            assertTrue(uri.query.matches(Regex("period=(current_billing_period|past_30_days|past_90_days)&classifier=services&format=json")))
            assertFalse(uri.toString().contains("fixture-private"))
            assertEquals("Token fixture-private-service-token", credential.authorization())
            assertEquals("[redacted]", credential.toString())
            UsageProviderResponse(200, fixture)
        }, { elapsed })
        val initial = service.snapshot()
        coroutineScope { List(5) { async { service.snapshot() } }.awaitAll() }
        assertEquals(1, calls.get())
        elapsed = 299_999_999_999L
        assertEquals(initial, service.snapshot())
        elapsed = 300_000_000_000L
        service.snapshot()
        assertEquals(2, calls.get())
        for (period in MAPTILER_USAGE_PERIODS) service.snapshot(period)
        assertEquals(4, calls.get())
    }

    @Test fun `provider failures remain absent and have a one minute retry cache without leaking text`() = runBlocking {
        for ((status, expected) in mapOf(401 to "MAPTILER_ACCESS_DENIED", 403 to "MAPTILER_ACCESS_DENIED", 429 to "MAPTILER_RATE_LIMITED", 400 to "MAPTILER_PERIOD_UNAVAILABLE", 503 to "MAPTILER_UNAVAILABLE")) {
            var elapsed = 0L
            var calls = 0
            val service = MapTilerUsageService(token(), clock, UsageProviderTransport { _, _ -> calls++; UsageProviderResponse(status, "SENSITIVE_UPSTREAM_RESPONSE") }, { elapsed })
            val result = service.snapshot()
            assertFalse(result.available)
            assertEquals(expected, result.error)
            assertNull(result.updatedAt)
            assertNull(result.since)
            assertTrue(result.groups.isEmpty())
            assertFalse(Json.encodeToString(result).contains("SENSITIVE"))
            elapsed = 59_999_999_999L; service.snapshot(); assertEquals(1, calls)
            elapsed = 60_000_000_000L; service.snapshot(); assertEquals(2, calls)
        }
        for (transport in listOf(
            UsageProviderTransport { _, _ -> throw IllegalStateException("SENSITIVE_CREDENTIAL_URL") },
            UsageProviderTransport { _, _ -> UsageProviderResponse(200, " ".repeat(USAGE_RESPONSE_LIMIT + 1)) },
            UsageProviderTransport { _, _ -> UsageProviderResponse(200, fixture.replace("\"group_id\":\"export\"", "\"group_id\":\"new-unit\"")) },
        )) {
            val result = MapTilerUsageService(token(), clock, transport).snapshot()
            assertEquals("MAPTILER_UNAVAILABLE", result.error)
            assertFalse(result.toString().contains("SENSITIVE"))
        }
    }
}
