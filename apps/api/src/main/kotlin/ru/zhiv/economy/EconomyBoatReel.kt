package ru.zhiv.economy

import kotlinx.serialization.Serializable
import ru.zhiv.http.parseCanonicalUuidV4
import kotlin.math.abs

@Serializable data class EconomyBoatReelInput(val tick: Int, val held: Boolean)
@Serializable data class EconomyBoatReelSubmission(val challengeId: String, val inputs: List<EconomyBoatReelInput>, val endTick: Int) {
    init {
        require(parseCanonicalUuidV4(challengeId) != null && endTick in 1..600 && inputs.size <= 600)
        require(inputs.all { it.tick in 0 until endTick } && inputs.zipWithNext().all { (a, b) -> a.tick < b.tick })
    }
}

/** Integer V1 protocol shared with the client. It verifies a possible trace, not human presence. */
object EconomyBoatReel {
    @Serializable data class Frame(val tick: Int = 0, val bar: Int = 5000, val velocity: Int = 0, val fish: Int = 5000,
        val progress: Int = 2500, val status: String = "active")

    fun step(frame: Frame, held: Boolean, seed: Long, zoneWidth: Int, difficulty: Int): Frame {
        require(seed in 0L..0xffff_ffffL && zoneWidth in setOf(3200, 4000) && difficulty in 1..5)
        if (frame.status != "active") return frame
        val half = zoneWidth / 2
        var velocity = (frame.velocity * 94 / 100 + if (held) 26 else -20).coerceIn(-220, 220)
        val freeBar = frame.bar + velocity
        val bar = freeBar.coerceIn(half, 10000 - half)
        if (bar != freeBar) velocity = 0
        val segment = frame.tick / (60 - 6 * difficulty)
        var hash = seed.toInt() xor ((segment + 1) * 0x9e3779b9.toInt())
        hash = hash xor (hash shl 13)
        hash = hash xor (hash ushr 17)
        hash = hash xor (hash shl 5)
        val target = 500 + ((hash.toLong() and 0xffff_ffffL) % 9001L).toInt()
        val step = 35 + 7 * difficulty
        val fish = (frame.fish + ((target - frame.fish) / 10).coerceIn(-step, step)).coerceIn(0, 10000)
        val progress = (frame.progress + if (abs(fish - bar) <= half) 32 else -45).coerceIn(0, 10000)
        val tick = frame.tick + 1
        return Frame(tick, bar, velocity, fish, progress,
            if (progress == 10000) "caught" else if (progress == 0 || tick == 600) "escaped" else "active")
    }

    /** A prefix or a trace containing input after an earlier terminal frame is invalid. */
    fun replay(challenge: EconomyBoatChallenge, submission: EconomyBoatReelSubmission): Frame {
        if (challenge.id != submission.challengeId) invalidEconomy()
        var frame = Frame()
        var held = false
        var event = 0
        while (frame.tick < submission.endTick) {
            if (frame.status != "active") invalidEconomy()
            if (submission.inputs.getOrNull(event)?.tick == frame.tick) held = submission.inputs[event++].held
            frame = step(frame, held, challenge.seed, challenge.zoneWidth, challenge.difficulty)
        }
        if (frame.status == "active" || event != submission.inputs.size) invalidEconomy()
        return frame
    }
}
