package ru.zhiv.admin

import org.junit.jupiter.api.Test
import java.time.Instant
import kotlin.test.*

class TapActivityRangeTest {
    private val now = Instant.parse("2026-09-23T12:30:35Z")
    private val collected = Instant.parse("2026-08-01T00:00:00Z")
    @Test fun `allowlist sets bounded charts and minute precise rolling limits`() {
        for((range, width, size) in listOf(Triple(30,1,31), Triple(1440,30,49), Triple(10080,120,85))) {
            val report = TapActivityRanges.summarize(now, range, collected, emptyList())
            assertEquals(width, report.bucketMinutes)
            assertEquals(size, report.buckets.size)
            assertEquals(now.truncatedTo(java.time.temporal.ChronoUnit.MINUTES).minusSeconds(range * 60L).toString(), report.from)
            assertEquals(report.from, report.buckets.first().at)
            assertEquals(now.toString(), report.buckets.last().until)
            assertFalse(report.buckets.last().complete)
            assertTrue(report.coverageComplete)
            assertTrue(report.buckets.all { it.eventTaps == 0L && it.receivedTaps == 0L })
        }
        for(range in listOf(-1, 0, 31, 60, 43200)) {
            assertFailsWith<IllegalArgumentException> { TapActivityRanges.bucketMinutes(range) }
            assertFailsWith<IllegalArgumentException> { TapActivityRanges.from(now, range) }
        }
    }
    @Test fun `missing old data stays unknown while backfilled evidence is visible but incomplete`() {
        val before = Instant.parse("2026-09-23T12:02:00Z").epochSecond
        val report = TapActivityRanges.summarize(now, 30, Instant.parse("2026-09-23T12:10:25Z"),
            listOf(TapHistoryAggregate(before, 9, 4, 2, 3, 5), TapHistoryAggregate(before + 60, 0, 1, 0, 0, 0)))
        assertEquals("2026-09-23T12:11:00Z", report.coverageFrom)
        assertFalse(report.coverageComplete)
        assertNull(report.buckets.first().receivedTaps)
        assertNull(report.buckets.first().eventTaps)
        val evidence = report.buckets.single { it.at == "2026-09-23T12:02:00Z" }
        assertEquals(9L, evidence.receivedTaps)
        assertEquals(4L, evidence.eventTaps)
        assertFalse(evidence.coverageComplete)
        assertNull(report.buckets.single { it.at == "2026-09-23T12:03:00Z" }.receivedTaps)
        assertNull(report.buckets.single { it.at == "2026-09-23T12:10:00Z" }.eventTaps)
        assertEquals(0L, report.buckets.single { it.at == report.coverageFrom }.eventTaps)
        assertEquals(9L, report.receivedTaps)
        assertEquals(5L, report.eventTaps)
        assertEquals(2L, report.rejectedTaps)
        assertEquals(3L, report.delayedTaps)
        assertEquals(5L, report.legacyTaps)
    }
    @Test fun `out of range aggregates cannot inflate selected totals and long edge buckets remain partial`() {
        val from = TapActivityRanges.from(now, 10080)
        val width = 7200L
        val first = from.epochSecond / width * width
        val last = now.epochSecond / width * width
        val report = TapActivityRanges.summarize(now, 10080, collected, listOf(
            TapHistoryAggregate(first - width, 999, 999, 999, 999, 999),
            TapHistoryAggregate(first, 7, 11, 2, 3, 4),
            TapHistoryAggregate(last, 13, 17, 3, 4, 5),
            TapHistoryAggregate(last + width, 999, 999, 999, 999, 999),
        ))
        assertEquals(20L, report.receivedTaps)
        assertEquals(28L, report.eventTaps)
        assertFalse(report.buckets.first().complete)
        assertFalse(report.buckets.last().complete)
        assertTrue(report.buckets.drop(1).dropLast(1).all { it.complete })
    }
}
