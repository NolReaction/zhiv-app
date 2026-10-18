package ru.zhiv.observability

import java.util.UUID
import kotlin.test.*

class RequestTrafficTest {
    @Test fun `ordinary activity is invisible and a successful read storm is observable without a denial`() {
        var now = 1_800_000L
        val traffic = RequestTraffic({ now })
        val owner = UUID.randomUUID()
        repeat(119) { traffic.record(owner, "GET", "/api/v1/game/rewards", 200) }
        assertTrue(traffic.samples().isEmpty())
        traffic.record(owner, "GET", "/api/v1/game/rewards", 200)
        val signal = traffic.samples().single()
        assertEquals(owner, signal.userId)
        assertEquals("/api/v1/game/rewards", signal.signal.operation)
        assertEquals(120, signal.signal.requests)
        assertEquals(listOf("REQUEST_BURST"), signal.signal.reasons)
        assertEquals(0, signal.signal.denied)
        now += 60_000
        traffic.record(owner, "GET", "/api/v1/game/rewards", 200)
        assertEquals(120, traffic.samples().single().signal.requests, "Keep the previous observed window, not an inflated rate")
        now += 900_000
        assertTrue(traffic.samples().isEmpty())
    }

    @Test fun `identity is server supplied and unknown paths methods and anonymous traffic stay bounded`() {
        val traffic = RequestTraffic({ 1_800_000L }, capacity = 2)
        repeat(20) { traffic.record(null, "INJECT-secret", "/api/v1/unknown-$it-secret", 403) }
        val anonymous = traffic.samples().single()
        assertNull(anonymous.userId)
        assertNull(anonymous.signal.publicId)
        assertEquals("unmatched", anonymous.signal.operation)
        assertEquals("OTHER", anonymous.signal.method)
        assertEquals(listOf("ACCESS_DENIED_BURST"), anonymous.signal.reasons)
        repeat(1000) { traffic.record(UUID.randomUUID(), "GET", "/api/v1/me", 200) }
        assertEquals(2, traffic.tracked())
        assertEquals(999L, traffic.evicted())
        assertTrue(traffic.samples().isEmpty())
    }

    @Test fun `admin reads and probes cannot generate their own observation loop but denied admin access is visible`() {
        val traffic = RequestTraffic({ 1_800_000L })
        repeat(200) {
            traffic.record(null, "GET", "/readyz", 503)
            traffic.record(UUID.randomUUID(), "GET", "/api/v1/admin/request-traffic", 200)
        }
        assertEquals(0, traffic.tracked())
        repeat(20) { traffic.record(null, "GET", "/api/v1/admin/request-traffic", 403) }
        assertEquals(20, traffic.samples().single().signal.denied)
    }

    @Test fun `separate accounts windows and operations never combine into a fabricated player signal`() {
        var now = 1_800_000L
        val traffic = RequestTraffic({ now })
        val a = UUID.randomUUID(); val b = UUID.randomUUID()
        repeat(70) {
            traffic.record(a, "GET", "/api/v1/game/rewards", 200)
            traffic.record(b, "GET", "/api/v1/game/rewards", 200)
            traffic.record(a, "GET", "/api/v1/economy", 200)
        }
        assertTrue(traffic.samples().isEmpty())
        now += 60_000
        repeat(70) { traffic.record(a, "GET", "/api/v1/game/rewards", 200) }
        assertTrue(traffic.samples().isEmpty())
        repeat(20) { traffic.record(b, "POST", "/api/v1/economy/commands", 429) }
        assertEquals(b, traffic.samples().single().userId)
        assertEquals(listOf("THROTTLED_BURST"), traffic.samples().single().signal.reasons)
    }

    @Test fun `concurrent counting is exact while diagnostic output has a fixed cap`() {
        val traffic = RequestTraffic({ 1_800_000L })
        val owner = UUID.randomUUID()
        val workers = (1..8).map { Thread { repeat(1000) { traffic.record(owner, "GET", "/api/v1/game/rewards", 200) } }.also { it.start() } }
        workers.forEach { it.join() }
        assertEquals(8000, traffic.samples().single().signal.requests)
        repeat(120) {
            val other = UUID.randomUUID()
            repeat(20) { traffic.record(other, "POST", "/api/v1/economy/commands", 403) }
        }
        assertEquals(100, traffic.samples().size)
    }
}
