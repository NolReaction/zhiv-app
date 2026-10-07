package ru.zhiv.presence

import org.junit.jupiter.api.Test
import ru.zhiv.auth.AuthFailure
import java.time.Instant
import java.time.LocalDate
import java.util.UUID
import kotlin.test.*

class PresenceTest {
    @Test fun `idle and connection deadlines are strict and terminal sessions never revive`() {
        val start = Instant.parse("2026-01-01T12:00:00Z")
        assertEquals("active", presenceStatus("active", start, start, start.plusSeconds(89)))
        assertEquals("disconnected", presenceStatus("active", start, start, start.plusSeconds(90)))
        assertEquals("idle", presenceStatus("active", start.plusSeconds(290), start, start.plusSeconds(300)))
        for (terminal in listOf("idle", "suspended", "disconnected")) {
            assertEquals(terminal, presenceStatus(terminal, start, start, start))
        }
    }

    @Test fun `confirmed time splits exactly at UTC midnight without losing milliseconds`() {
        assertEquals(listOf(LocalDate.parse("2026-01-01") to 125L, LocalDate.parse("2026-01-02") to 375L),
            presenceDaySlices(Instant.parse("2026-01-01T23:59:59.875Z"), Instant.parse("2026-01-02T00:00:00.375Z")))
        val at = Instant.parse("2026-01-01T12:00:00Z")
        assertTrue(presenceDaySlices(at, at).isEmpty())
        assertTrue(presenceDaySlices(at, at.minusSeconds(1)).isEmpty())
    }

    @Test fun `resume and activity payloads cannot reuse a heartbeat as a new session`() {
        val resume = PresenceRequest("resume", UUID.randomUUID().toString(), 0, true)
        assertNotNull(validatePresenceRequest(resume))
        assertNotNull(validatePresenceRequest(resume.copy(kind = "heartbeat", sequence = 1, active = false)))
        assertNotNull(validatePresenceRequest(resume.copy(kind = "suspend", sequence = 2, active = false)))
        for (bad in listOf(resume.copy(active = false), resume.copy(sequence = 1), resume.copy(presenceId = "not-a-uuid"),
            resume.copy(kind = "heartbeat"), resume.copy(kind = "suspend", sequence = 1), resume.copy(kind = "unknown"),
            resume.copy(kind = "heartbeat", sequence = -1), resume.copy(kind = "heartbeat", sequence = 9_007_199_254_740_991L))) {
            assertEquals("INVALID_PRESENCE", assertFailsWith<AuthFailure> { validatePresenceRequest(bad) }.code)
        }
    }
}
