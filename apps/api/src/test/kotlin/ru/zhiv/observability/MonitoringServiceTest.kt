package ru.zhiv.observability

import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import java.net.URI
import java.time.Clock
import java.time.Instant
import java.time.ZoneOffset
import java.util.Collections
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

class MonitoringServiceTest {
    private val clock = Clock.fixed(Instant.parse("2026-09-07T12:00:00Z"), ZoneOffset.UTC)
    private fun json(value: String) = Json.parseToJsonElement(value) as JsonObject

    @Test
    fun `disabled or invalid operator configuration never attempts a request`() = runBlocking {
        val transport = MonitoringTransport { error("must not connect") }
        for (url in listOf(null, "", "file:///etc/passwd", "http://user:secret@prometheus:9090", "http://prometheus:9090/?query=secret")) {
            val response = MonitoringService(url, clock, transport).snapshot()
            assertFalse(response.available)
            assertNull(response.summary.cpuPercent)
            assertTrue(response.samples.isEmpty())
            assertTrue(response.health.all { it.status == "unknown" })
        }
        assertEquals(URI("http://prometheus:9090"), parseMonitoringBase("http://prometheus:9090/"))
    }

    @Test
    fun `unreachable monitoring does not invent zero load or leak upstream errors`() = runBlocking {
        val response = MonitoringService("http://prometheus:9090", clock, MonitoringTransport { throw IllegalStateException("password=secret") }).snapshot()
        assertFalse(response.available)
        assertEquals("MONITORING_UNAVAILABLE", response.error)
        assertNull(response.summary.memoryUsedBytes)
        assertFalse(response.toString().contains("secret"))
    }

    @Test
    fun `invalid missing infinite negative and out of range samples remain absent`() {
        val response = json("""{"status":"success","data":{"resultType":"vector","result":[
          {"metric":{"key":"cpuPercent"},"value":[100,"NaN"]},
          {"metric":{"key":"memoryUsedBytes"},"value":[100,"+Inf"]},
          {"metric":{"key":"load1"},"value":[100,"-1"]},
          {"metric":{"key":"nodeUp"},"value":[100,"2"]},
          {"metric":{"key":"errorRate"},"value":[100,"0"]},
          {"metric":{"key":"requestRate"},"value":[100,"1.25"]},
          {"metric":{"key":"notAllowed"},"value":[100,"100"]},
          {"metric":{"key":"diskUsedBytes"},"value":["NaN","20"]}
        ]}}""")
        assertEquals(mapOf("errorRate" to 0.0, "requestRate" to 1.25), parseMonitoringVector(response))
        assertTrue(parseMonitoringVector(json("""{"status":"success","data":{"resultType":"vector","result":[]}}""")).isEmpty())
    }

    @Test
    fun `history is bounded to exact minute buckets and missing data stays a gap`() {
        val response = json("""{"status":"success","data":{"resultType":"matrix","result":[
          {"metric":{"key":"cpuPercent"},"values":[[60,"22"],[61,"90"],[120,"NaN"],[3660,"45"],[3720,"99"]]},
          {"metric":{"key":"requestRate"},"values":[[60,"0"],[120,"2.5"]]}
        ]}}""")
        val samples = parseMonitoringMatrix(response, 60, 3660)
        assertEquals(61, samples.size)
        assertEquals(22.0, samples.first().cpuPercent)
        assertEquals(0.0, samples.first().requestRate)
        assertNull(samples[1].cpuPercent)
        assertEquals(2.5, samples[1].requestRate)
        assertEquals(45.0, samples.last().cpuPercent)
        assertTrue(parseMonitoringMatrix(response, 0, 999999).isEmpty())
    }

    @Test
    fun `alert labels and text use only known safe definitions`() {
        val response = json("""{"status":"success","data":{"alerts":[
          {"labels":{"alertname":"ZhivApiDown","severity":"secret"},"state":"firing","annotations":{"summary":"password=secret"},"activeAt":"2026-09-07T12:00:00Z"},
          {"labels":{"alertname":"InjectedSecret"},"state":"firing"}
        ]}}""")
        val alerts = parseMonitoringAlerts(response)
        assertEquals(1, alerts.size)
        assertEquals("critical", alerts.first().severity)
        assertEquals("firing", alerts.first().state)
        assertNotNull(alerts.first().activeAt)
        assertFalse(alerts.toString().contains("secret"))
    }

    @Test
    fun `snapshot uses fixed bounded queries and caches repeated reads`() = runBlocking {
        val requests = Collections.synchronizedList(mutableListOf<URI>())
        val service = MonitoringService("http://prometheus:9090", clock, MonitoringTransport { uri ->
            requests.add(uri)
            when (uri.path) {
                "/api/v1/query" -> """{"status":"success","data":{"resultType":"vector","result":[{"metric":{"key":"cpuPercent"},"value":[1788782400,"25"]},{"metric":{"key":"apiUp"},"value":[1788782400,"1"]},{"metric":{"key":"nodeUp"},"value":[1788782400,"0"]}]}}"""
                "/api/v1/query_range" -> """{"status":"success","data":{"resultType":"matrix","result":[]}}"""
                "/api/v1/alerts" -> """{"status":"success","data":{"alerts":[]}}"""
                else -> error("unexpected path")
            }
        })
        val first = service.snapshot()
        assertEquals(first, service.snapshot())
        assertEquals(3, requests.size)
        assertEquals(25.0, first.summary.cpuPercent)
        assertEquals("down", first.health.single { it.name == "node" }.status)
        assertTrue(requests.all { it.host == "prometheus" && it.port == 9090 })
        assertTrue(requests.single { it.path.endsWith("query_range") }.rawQuery.contains("step=60"))
        assertTrue(first.available)
    }
}
