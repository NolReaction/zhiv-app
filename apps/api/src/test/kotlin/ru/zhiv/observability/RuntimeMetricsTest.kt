package ru.zhiv.observability

import kotlin.test.Test
import kotlin.test.assertContains
import kotlin.test.assertFalse
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class RuntimeMetricsTest {
    @Test fun `boot usage counters are exact isolated and coherent during concurrent updates`() {
        val metrics = RuntimeMetrics()
        assertEquals(0L, metrics.usageSnapshot().requests)
        val threads = List(4) { index -> Thread {
            repeat(2000) { metrics.recordRequest("GET", "/api/v1/session", if (index % 2 == 0) 503 else 429, 1) }
        }.also { it.start() } }
        repeat(500) {
            val snapshot = metrics.usageSnapshot()
            assertEquals(snapshot.requests, snapshot.errors + snapshot.throttled)
        }
        threads.forEach(Thread::join)
        val result = metrics.usageSnapshot()
        assertEquals(8000L, result.requests)
        assertEquals(4000L, result.errors)
        assertEquals(4000L, result.throttled)
        assertTrue(result.startedAt.isNotBlank())
        metrics.recordRequest("GET", "/healthz", 200, 1)
        assertEquals(result, metrics.usageSnapshot())
        assertEquals(0L, RuntimeMetrics().usageSnapshot().requests)
    }
    @Test
    fun `replayed receipts do not double committed gameplay totals`() {
        val metrics = RuntimeMetrics()
        metrics.recordGameBatch(55, 5, false)
        metrics.recordGameBatch(55, 5, true)
        metrics.recordGameBatch(20, 0, false)
        metrics.recordGameBatch(-1, 0, false)
        val text = metrics.exposition()
        assertContains(text, "zhiv_game_taps_total{result=\"accepted\"} 75\n")
        assertContains(text, "zhiv_game_taps_total{result=\"rejected\"} 5\n")
        assertContains(text, "zhiv_game_batches_total{result=\"committed\"} 2\n")
        assertContains(text, "zhiv_game_batches_total{result=\"replayed\"} 1\n")
    }

    @Test
    fun `request labels contain fixed route templates and exclude probe traffic`() {
        val metrics = RuntimeMetrics()
        metrics.recordRequest("GET", "/api/v1/users/SECRET-PUBLIC-ID", 200, 25_000_000)
        metrics.recordRequest("GET", "/private-secret-path", 503, 1_000_000_000)
        metrics.recordRequest("INJECT\"\n", "/different-secret-path", 404, -100)
        metrics.recordRequest("GET", "/readyz", 200, 1)
        metrics.recordRequest("GET", "/internal/metrics", 200, 1)
        val text = metrics.exposition()
        assertContains(text, "zhiv_http_requests_total 3\n")
        assertContains(text, "zhiv_http_errors_total 1\n")
        assertContains(text, "operation=\"/api/v1/users/{publicId}\"")
        assertContains(text, "method=\"OTHER\",operation=\"unmatched\",status=\"4xx\"")
        assertContains(text, "zhiv_http_request_duration_seconds_bucket{le=\"0.025\"} 2\n")
        assertFalse(text.contains("SECRET"))
        assertFalse(text.contains("secret-path"))
        assertFalse(text.contains("INJECT"))
    }
}
