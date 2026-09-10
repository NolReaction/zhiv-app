package ru.zhiv.admin

import org.junit.jupiter.api.Test
import java.time.Instant
import kotlin.test.*

class TapActivityAnalyzerTest {
    private val now=Instant.parse("2026-09-10T12:30:00Z")
    private fun sample(second: Long, events: Long=1, received: Long=events, delayed: Long=0)=
        TapActivitySample(second,received,0,events,delayed,0,events,600.0*events,360000.0*events)
    private fun analyze(samples: List<TapActivitySample>)=TapActivityAnalyzer.analyze("TEST","Player",false,now,samples)

    @Test fun `windows contain exactly the last completed seconds and exclude the current one`() {
        val data=analyze((now.epochSecond-1801..now.epochSecond).map { sample(it) })
        assertEquals(listOf(10L,30L,60L,1800L),data.windows.map { it.eventTaps })
        assertTrue(data.windows.all { it.tapsPerSecond==1.0 })
    }
    @Test fun `fifteen stable minutes produce a review flag without requiring identical network delivery`() {
        val rows=(1..15).flatMap { back -> (0..59).map { second ->
            val at=now.epochSecond-back*60+second
            // Exactly 100 taps/min with varied HTTP receipt distribution.
            sample(at,if(second<40) 2 else 1,if(second%2==0) 4 else 0)
        } }
        val report=analyze(rows)
        assertEquals("review",report.analysis.status)
        assertEquals(15,report.analysis.stableMinutes)
        assertEquals(100.0,report.analysis.meanTapsPerMinute)
        assertEquals(0.0,report.analysis.minuteVariation)
        assertEquals(false,report.watchlisted)
    }
    @Test fun `natural variation short activity and missing minutes do not become a stable run`() {
        val varied=(1..15).map { back -> sample(now.epochSecond-back*60,40L+(back%4)*31) }
        assertEquals("no_signal",analyze(varied).analysis.status)
        assertEquals("insufficient_data",analyze(varied.take(2)).analysis.status)
        assertEquals(0,analyze(varied.filterIndexed { index,_ -> index!=7 }.map { it.copy(events=100) }).analysis.stableMinutes)
        assertEquals("insufficient_data",analyze(emptyList()).analysis.status)
    }
    @Test fun `an offline queue is labelled as limited evidence even with regular historical timestamps`() {
        val rows=(1..20).map { back -> sample(now.epochSecond-back*60,100,0) }+
            sample(now.epochSecond-1,0,2000,2000)
        val report=analyze(rows)
        assertEquals("insufficient_data",report.analysis.status)
        assertTrue("DELAYED_DELIVERY" in report.analysis.reasons)
        assertEquals(2000L,report.delayedTaps)
        assertEquals(0L,report.windows.first().eventTaps)
        assertEquals(2000L,report.windows.first().receivedTaps)
    }
    @Test fun `partial current minute and sparse selected intervals cannot imply regular input`() {
        val rows=(1..9).map { back -> sample(now.epochSecond-back*60,100) }+sample(now.epochSecond,100)
        assertEquals(0,analyze(rows).analysis.stableMinutes)
        val sparse=(1..20).map { back -> sample(now.epochSecond-back*60,100).copy(intervals=31,intervalSum=18600.0,intervalSquares=11160000.0) }
        assertFalse("REGULAR_INTERVALS" in analyze(sparse).analysis.reasons)
    }
}
