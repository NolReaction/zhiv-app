package ru.zhiv.admin

import kotlinx.serialization.Serializable
import java.time.Instant
import kotlin.math.sqrt

data class TapActivitySample(val second: Long, val received: Long, val rejected: Long, val events: Long,
    val delayed: Long, val legacy: Long, val intervals: Long, val intervalSum: Double, val intervalSquares: Double)
@Serializable data class TapWindow(val seconds: Int, val receivedTaps: Long, val eventTaps: Long, val tapsPerSecond: Double)
@Serializable data class TapMinute(val at: String, val receivedTaps: Long, val eventTaps: Long, val complete: Boolean)
@Serializable data class TapAnalysis(val status: String, val stableMinutes: Int, val activeMinutes: Int,
    val meanTapsPerMinute: Double?, val minuteVariation: Double?, val intervalVariation: Double?,
    val intervalSamples: Long, val reasons: List<String>)
@Serializable data class AdminTapActivity(val publicId: String, val displayName: String, val watchlisted: Boolean,
    val serverTime: String, val windows: List<TapWindow>, val minutes: List<TapMinute>,
    val rejectedTaps: Long, val delayedTaps: Long, val legacyTaps: Long, val analysis: TapAnalysis)

/** Evidence for a human reviewer only. This module cannot mutate an account.
 * Client timestamps are untrusted, even though the server accepted their taps. */
object TapActivityAnalyzer {
    private fun variation(values: List<Long>): Double? {
        val mean=values.average()
        if(values.isEmpty() || mean<=0) return null
        return sqrt(values.sumOf { (it-mean)*(it-mean) }/values.size)/mean
    }
    fun analyze(publicId: String, name: String, watchlisted: Boolean, now: Instant, samples: List<TapActivitySample>): AdminTapActivity {
        val second=now.epochSecond
        val recent=samples.filter { it.second>=second-1800 && it.second<second }
        val minute=second/60*60
        val minutes=(30 downTo 0).map { back ->
            val start=minute-back*60
            val rows=samples.filter { it.second>=start && it.second<start+60 && it.second<=second }
            TapMinute(Instant.ofEpochSecond(start).toString(),rows.sumOf { it.received },rows.sumOf { it.events },back>0)
        }
        val complete=minutes.filter { it.complete }.map { it.eventTaps }
        var stable=emptyList<Long>()
        // Inspect contiguous complete minutes. Gaps and a partially observed first
        // minute cannot be dropped to manufacture an apparently steady series.
        for(length in 10..complete.size) for(start in 0..complete.size-length) {
            val window=complete.subList(start,start+length)
            if(window.all { it>=30 } && (variation(window) ?: 1.0)<=.03) stable=window
        }
        val n=recent.sumOf { it.intervals }
        val sum=recent.sumOf { it.intervalSum }
        val intervalCv=if(n>=2 && sum>0) sqrt((recent.sumOf { it.intervalSquares }/n-(sum/n)*(sum/n)).coerceAtLeast(0.0))/(sum/n) else null
        val received=recent.sumOf { it.received }
        val delayed=recent.sumOf { it.delayed }
        val legacy=recent.sumOf { it.legacy }
        val active=complete.count { it>0 }
        val limited=received==0L || delayed.toDouble()/received>.2 || legacy.toDouble()/received>.2
        val events=recent.sumOf { it.events }
        val intervalSeconds=recent.filter { it.intervals>0 }.map { it.second }
        val duration=if(intervalSeconds.isEmpty()) 0 else intervalSeconds.max()-intervalSeconds.min()
        val regular=n>=600 && duration>=300 && events>0 && n.toDouble()/events>=.8 && intervalCv!=null && intervalCv<=.05
        val reasons=buildList {
            if(stable.isNotEmpty()) add("LOW_MINUTE_VARIATION")
            if(regular) add("REGULAR_INTERVALS")
            if(complete.windowed(25).any { run -> run.all { it>0 } }) add("LONG_ACTIVITY")
            if(delayed>0) add("DELAYED_DELIVERY")
            if(legacy>0) add("MISSING_TIMESTAMPS")
        }
        val status=when {
            active<5 || limited -> "insufficient_data"
            stable.isNotEmpty() && (regular || stable.size>=15) -> "review"
            else -> "no_signal"
        }
        return AdminTapActivity(publicId,name,watchlisted,now.toString(),listOf(10,30,60,1800).map { seconds ->
            val window=recent.filter { it.second>=second-seconds }
            TapWindow(seconds,window.sumOf { it.received },window.sumOf { it.events },window.sumOf { it.events }.toDouble()/seconds)
        },minutes,recent.sumOf { it.rejected },delayed,legacy,TapAnalysis(status,stable.size,active,
            stable.takeIf { it.isNotEmpty() }?.average(),stable.takeIf { it.isNotEmpty() }?.let { variation(it) },intervalCv,n,reasons))
    }
}
