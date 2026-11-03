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

/** Versioned integer protocol shared with the client. V1 remains immutable. It verifies a possible trace, not human presence. */
object EconomyBoatReel {
    @Serializable data class Frame(val tick: Int = 0, val bar: Int = 5000, val velocity: Int = 0, val fish: Int = 5000,
        val progress: Int = 2500, val status: String = "active")

    fun resistanceForClass(rarity: String?, seed: Long): String {
        val alternate = (seed and 1L) == 1L
        return when (rarity) {
            "uncommon" -> if (alternate) "sprightly" else "steady"
            "rare" -> if (alternate) "surging" else "sprightly"
            "epic" -> if (alternate) "stubborn" else "surging"
            "legendary" -> if (alternate) "surging" else "stubborn"
            else -> "steady"
        }
    }

    private fun hash(seed: Long, segment: Int): Long {
        var value = seed.toInt() xor ((segment + 1) * 0x9e3779b9.toInt())
        value = value xor (value shl 13)
        value = value xor (value ushr 17)
        value = value xor (value shl 5)
        return value.toLong() and 0xffff_ffffL
    }

    private data class Motion(val target: Int, val limit: Int, val divisor: Int)
    private fun motion(seed: Long, tick: Int, difficulty: Int, resistance: String): Motion = when (resistance) {
        "steady" -> Motion(1300 + (hash(seed, tick / 96) % 7401).toInt(), 26 + 3 * difficulty, 14)
        "sprightly" -> {
            val resting = tick % 54 >= 36
            Motion(1100 + (hash(seed, tick / 54) % 7801).toInt(),
                if (resting) 20 + 2 * difficulty else 52 + 3 * difficulty, if (resting) 14 else 8)
        }
        "surging" -> {
            val phase = tick % 108; val value = hash(seed, tick / 108)
            val base = 1700 + (value % 6601).toInt(); val bursting = phase in 40 until 78
            Motion(if (bursting) (base + if ((value and 1L) == 1L) 2200 else -2200).coerceIn(900, 9100) else base,
                if (bursting) 70 + 3 * difficulty else if (phase < 40) 22 + 2 * difficulty else 28 + 2 * difficulty,
                if (bursting) 7 else if (phase < 40) 14 else 12)
        }
        "stubborn" -> {
            val resting = tick % 144 >= 96; val segment = tick / 144
            Motion(if (resting) 2500 + (hash(seed xor 0xa341316cL, segment) % 5001).toInt()
                else 900 + (hash(seed, segment) % 8201).toInt(),
                if (resting) 18 + 2 * difficulty else 38 + 3 * difficulty, if (resting) 15 else 10)
        }
        else -> throw IllegalArgumentException("Unknown boat resistance profile")
    }

    /** The old signature keeps V1 tools and vectors readable. New attempts dispatch through their saved version. */
    fun step(frame: Frame, held: Boolean, seed: Long, zoneWidth: Int, difficulty: Int,
        rulesVersion: Int = 1, resistance: String? = null): Frame {
        require(seed in 0L..0xffff_ffffL && zoneWidth in setOf(3200, 4000) && difficulty in 1..5)
        require(rulesVersion in setOf(1, 2))
        if (frame.status != "active") return frame
        val half = zoneWidth / 2
        var velocity = (frame.velocity * 94 / 100 + if (held) 26 else -20).coerceIn(-220, 220)
        val freeBar = frame.bar + velocity
        val bar = freeBar.coerceIn(half, 10000 - half)
        if (bar != freeBar) velocity = 0
        val movement = if (rulesVersion == 2) motion(seed, frame.tick, difficulty, requireNotNull(resistance))
            else Motion(500 + (hash(seed, frame.tick / (60 - 6 * difficulty)) % 9001).toInt(), 35 + 7 * difficulty, 10)
        val fish = (frame.fish + ((movement.target - frame.fish) / movement.divisor).coerceIn(-movement.limit, movement.limit)).coerceIn(0, 10000)
        val progress = (frame.progress + if (abs(fish - bar) <= half) 32 else -45).coerceIn(0, 10000)
        val tick = frame.tick + 1
        return Frame(tick, bar, velocity, fish, progress,
            if (progress == 10000) "caught" else if (progress == 0 || tick == 600) "escaped" else "active")
    }

    fun step(frame: Frame, held: Boolean, challenge: EconomyBoatChallenge): Frame =
        step(frame, held, challenge.seed, challenge.zoneWidth, challenge.difficulty, challenge.rulesVersion, challenge.resistance)

    /** A prefix or a trace containing input after an earlier terminal frame is invalid. */
    fun replay(challenge: EconomyBoatChallenge, submission: EconomyBoatReelSubmission): Frame {
        if (challenge.id != submission.challengeId) invalidEconomy()
        var frame = Frame()
        var held = false
        var event = 0
        while (frame.tick < submission.endTick) {
            if (frame.status != "active") invalidEconomy()
            if (submission.inputs.getOrNull(event)?.tick == frame.tick) held = submission.inputs[event++].held
            frame = step(frame, held, challenge)
        }
        if (frame.status == "active" || event != submission.inputs.size) invalidEconomy()
        return frame
    }
}
