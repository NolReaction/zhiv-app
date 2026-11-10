package ru.zhiv.economy

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import java.time.Instant
import kotlin.math.floor

@Serializable data class EconomyTapBoostState(
    val charge: Int = 0, val powerBps: Int = 0,
    val grantedAt: String? = null, val appliedAt: String? = null,
    val expiresAt: String? = null, val jobId: String? = null,
) {
    init { require(charge in 0..1000 && powerBps in 0..2000) }
}

object EconomyTapBoost {
    @Serializable private data class Point(val charge: Int, val powerBps: Int)
    @Serializable private data class Config(val version: Int, val maxCharge: Int, val maxSeconds: Int,
        val secondsPerTap: Int, val powerPoints: List<Point>)
    private val config = Json.decodeFromString<Config>(checkNotNull(javaClass.getResource("/world/tap-boost-catalog.json")).readText())
    private val points = config.powerPoints.map { it.charge to it.powerBps }
    init {
        require(config.version == 1 && config.maxCharge == 1000 && config.maxSeconds in 1..60 && config.secondsPerTap == 1)
        require(points.first() == (0 to 0) && points.last() == (1000 to 2000))
        require(points.zipWithNext().all { (a, b) -> a.first < b.first && a.second <= b.second })
    }

    fun powerBps(charge: Int): Int {
        val bounded = charge.coerceIn(0, config.maxCharge)
        for (index in 1 until points.size) {
            val (end, power) = points[index]
            val (start, prior) = points[index - 1]
            if (bounded <= end) return prior + (power - prior) * (bounded - start) / (end - start)
        }
        return 2000
    }

    private fun eligible(job: EconomyJob) = job.kind == "production" || job.kind == "exploration" && job.actorId == "miner"

    /** Deterministic read projection and write settlement share exactly the same clock. */
    fun settle(state: EconomyState, now: Instant): EconomyState {
        val boost = state.tapBoost
        if (boost.jobId == null || boost.appliedAt == null || boost.expiresAt == null || boost.powerBps <= 0) return state
        val job = state.jobs.find { it.id == boost.jobId && eligible(it) } ?: return state
        val end = minOf(now.toEpochMilli(), Instant.parse(boost.expiresAt).toEpochMilli())
        val start = maxOf(Instant.parse(boost.appliedAt).toEpochMilli(), Instant.parse(job.startedAt).toEpochMilli())
        val finish = Instant.parse(job.finishesAt).toEpochMilli()
        if (end <= start || finish <= start) return state
        val elapsed = minOf((end - start).toDouble(), (finish - start).toDouble() * 10000 / (10000 + boost.powerBps))
        val savedMs = floor(elapsed * boost.powerBps / 10000).toLong()
        val changedJob = job.copy(startedAt = Instant.ofEpochMilli(Instant.parse(job.startedAt).toEpochMilli() - savedMs).toString(),
            finishesAt = Instant.ofEpochMilli(finish - savedMs).toString())
        return state.copy(jobs = state.jobs.map { if (it.id == job.id) changedJob else it },
            tapBoost = boost.copy(appliedAt = Instant.ofEpochMilli(end).toString()))
    }

    /** The existing accepted game-batch receipt is the one-use authority for this credit. */
    fun credit(state: EconomyState, acceptedTaps: Int, now: Instant): EconomyState {
        if (acceptedTaps <= 0) return state
        val current = settle(state, now)
        val previous = current.tapBoost
        val previousActive = previous.expiresAt?.let { Instant.parse(it).isAfter(now) } == true
        val previousJob = if (previousActive) current.jobs.find {
            it.id == previous.jobId && eligible(it) && Instant.parse(it.finishesAt).isAfter(now)
        } else null
        val job = previousJob ?: current.jobs.filter { eligible(it) && Instant.parse(it.finishesAt).isAfter(now) }
            .sortedWith(compareBy<EconomyJob> { Instant.parse(it.finishesAt) }.thenBy { it.id }).firstOrNull() ?: return current
        val charge = minOf(config.maxCharge.toLong(), (if (previousJob != null) previous.charge.toLong() else 0) + acceptedTaps).toInt()
        val remainingMs = if (previousJob != null) maxOf(0, Instant.parse(previous.expiresAt).toEpochMilli() - now.toEpochMilli()) else 0
        val durationMs = minOf(config.maxSeconds.toLong() * 1000, remainingMs + acceptedTaps.toLong() * config.secondsPerTap * 1000)
        return current.copy(tapBoost = EconomyTapBoostState(charge, powerBps(charge), now.toString(), now.toString(),
            now.plusMillis(durationMs).toString(), job.id))
    }
}
