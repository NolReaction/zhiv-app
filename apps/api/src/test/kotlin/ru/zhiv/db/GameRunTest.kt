package ru.zhiv.db

import org.junit.jupiter.api.Test
import java.time.OffsetDateTime
import java.util.UUID
import kotlin.test.*

class GameRunTest {
    @Test fun `record continuity uses only same run and bounded server time with network grace`() {
        val run = UUID.randomUUID()
        val start = OffsetDateTime.parse("2026-09-30T23:59:55Z")
        assertTrue(gameRunContinues(run,run,start,start.plusSeconds(10)))
        assertTrue(gameRunContinues(run,run,start,start.plusSeconds(12)))
        assertFalse(gameRunContinues(run,run,start,start.plusSeconds(13)))
        assertFalse(gameRunContinues(run,run,start,start.minusSeconds(1)))
        assertFalse(gameRunContinues(run,UUID.randomUUID(),start,start.plusSeconds(1)))
        assertFalse(gameRunContinues(null,run,null,start))
    }
}
