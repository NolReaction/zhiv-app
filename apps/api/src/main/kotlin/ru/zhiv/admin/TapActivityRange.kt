package ru.zhiv.admin

import kotlinx.serialization.Serializable
import java.time.Instant
import java.time.temporal.ChronoUnit

data class TapHistoryAggregate(val second: Long, val received: Long, val events: Long,
    val rejected: Long, val delayed: Long, val legacy: Long)
@Serializable data class TapHistoryBucket(val at: String, val until: String,
    val receivedTaps: Long?, val eventTaps: Long?, val complete: Boolean, val coverageComplete: Boolean)
@Serializable data class TapActivityRange(val rangeMinutes: Int, val bucketMinutes: Int,
    val from: String, val to: String, val coverageFrom: String, val coverageComplete: Boolean,
    val receivedTaps: Long, val eventTaps: Long, val rejectedTaps: Long, val delayedTaps: Long,
    val legacyTaps: Long, val buckets: List<TapHistoryBucket>)

/** Minute history is sparse. Missing buckets are zero only after reliable collection began. */
object TapActivityRanges {
    val allowed = setOf(30, 1440, 10080)
    fun bucketMinutes(rangeMinutes: Int): Int = when(rangeMinutes) {
        30 -> 1
        1440 -> 30
        10080 -> 120
        else -> throw IllegalArgumentException("Unsupported tap history range")
    }
    fun from(now: Instant, rangeMinutes: Int): Instant {
        require(rangeMinutes in allowed)
        return now.truncatedTo(ChronoUnit.MINUTES).minusSeconds(rangeMinutes * 60L)
    }
    fun summarize(now: Instant, rangeMinutes: Int, collectionStartedAt: Instant,
        aggregates: List<TapHistoryAggregate>): TapActivityRange {
        val width = bucketMinutes(rangeMinutes) * 60L
        val from = from(now, rangeMinutes)
        // The migration's first minute can be incomplete, including its backfilled data.
        val coverage = collectionStartedAt.truncatedTo(ChronoUnit.MINUTES).let {
            if(it == collectionStartedAt) it else it.plusSeconds(60)
        }
        val bySecond = aggregates.associateBy { it.second }
        val first = from.epochSecond / width * width
        val last = now.epochSecond / width * width
        val buckets = generateSequence(first) { it + width }.takeWhile { it <= last }.map { start ->
            val at = maxOf(Instant.ofEpochSecond(start), from)
            val until = minOf(Instant.ofEpochSecond(start + width), now)
            val row = bySecond[start]
            val covered = at >= coverage
            TapHistoryBucket(at.toString(), until.toString(), row?.received?.takeIf { covered || it > 0 } ?: if(covered) 0L else null,
                row?.events?.takeIf { covered || it > 0 } ?: if(covered) 0L else null,
                start >= from.epochSecond && start + width <= now.epochSecond, covered)
        }.toList()
        val selected = aggregates.filter { it.second in first..last }
        return TapActivityRange(rangeMinutes, (width / 60).toInt(), from.toString(), now.toString(),
            coverage.toString(), from >= coverage, selected.sumOf { it.received }, selected.sumOf { it.events },
            selected.sumOf { it.rejected }, selected.sumOf { it.delayed }, selected.sumOf { it.legacy }, buckets)
    }
}
