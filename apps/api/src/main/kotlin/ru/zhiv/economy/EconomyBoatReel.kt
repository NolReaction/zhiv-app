package ru.zhiv.economy

import kotlinx.serialization.EncodeDefault
import kotlinx.serialization.ExperimentalSerializationApi
import kotlinx.serialization.Serializable
import ru.zhiv.http.parseCanonicalUuidV4
import kotlin.math.abs

@Serializable data class EconomyBoatReelInput(val tick: Int, val held: Boolean)
@OptIn(ExperimentalSerializationApi::class)
@Serializable data class EconomyBoatReelSubmission(val challengeId: String, val inputs: List<EconomyBoatReelInput>, val endTick: Int,
    @EncodeDefault(EncodeDefault.Mode.NEVER) val deferred: Boolean = false,
    @EncodeDefault(EncodeDefault.Mode.NEVER) val missedBite: Boolean = false) {
    init {
        require(parseCanonicalUuidV4(challengeId) != null && inputs.size <= 600)
        require(if (missedBite) endTick == 0 && inputs.isEmpty() else endTick in 1..600)
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

    // Starter and fully upgraded meter widths by public rarity, before the landing net bonus.
    private val zoneWidths = mapOf("common" to (3200 to 3200), "uncommon" to (2500 to 2700),
        "rare" to (1800 to 2100), "epic" to (1200 to 1450), "legendary" to (590 to 960))

    fun zoneWidth(baseWidth: Int, rarity: String, motorResponse: Int, hullDamping: Int): Int {
        val (starter, upgraded) = zoneWidths.getValue(rarity)
        val control = motorResponse * 4 + hullDamping
        val width = starter + (upgraded - starter) * control / 40
        return 2 * (width * baseWidth / 6400)
    }

    fun validZoneWidth(version: Int, width: Int): Boolean =
        if (version >= 6) width in 590..4000 && width % 2 == 0 else width == 3200 || width == 4000

    private fun hash(seed: Long, segment: Int): Long {
        var value = seed.toInt() xor ((segment + 1) * 0x9e3779b9.toInt())
        value = value xor (value shl 13)
        value = value xor (value ushr 17)
        value = value xor (value shl 5)
        return value.toLong() and 0xffff_ffffL
    }

    private data class Motion(val target: Int, val limit: Int, val divisor: Int, val phase: String = "cruising")
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

    /** V3 uses only saved public class/profile inputs, with authored preparation and recovery. */
    private fun motionV3(seed: Long, tick: Int, difficulty: Int, resistance: String, fishRarity: String): Motion {
        val rank = listOf("common", "uncommon", "rare", "epic", "legendary").indexOf(fishRarity) + 1
        return when (resistance) {
            "steady" -> {
                val resting = tick % 96 >= 64
                Motion(1300 + (hash(seed, tick / 96) % 7401).toInt(),
                    if (resting) 20 + 2 * difficulty else 32 + 4 * difficulty + 2 * rank,
                    if (resting) 15 else 11, if (resting) "recovering" else "cruising")
            }
            "sprightly" -> {
                val segment = tick / 80; val phase = tick % 80
                val base = 1300 + (hash(seed, segment) % 7401).toInt()
                when {
                    phase >= 60 -> Motion(4300 + (hash(seed xor 0xa341316cL, segment) % 1401).toInt(), 22 + 2 * difficulty, 15, "recovering")
                    phase >= 42 -> Motion(10000 - base, 66 + 5 * difficulty + 7 * rank, 6, "surging")
                    phase >= 30 -> Motion(base, 20 + 2 * difficulty, 16, "preparing")
                    else -> Motion(base, 44 + 3 * difficulty + 3 * rank, 9)
                }
            }
            "surging" -> {
                val segment = tick / 100; val phase = tick % 100
                val value = hash(seed, segment); val base = 1900 + (value % 6201).toInt()
                when {
                    phase >= 72 -> Motion(4200 + (hash(seed xor 0xa341316cL, segment) % 1601).toInt(), 26 + 2 * difficulty, 14, "recovering")
                    phase >= 38 -> Motion((base + (if ((value and 1L) == 1L) 1 else -1) * (1700 + 200 * rank)).coerceIn(800, 9200),
                        76 + 5 * difficulty + 8 * rank, 6, "surging")
                    phase >= 24 -> Motion(base, 18 + 2 * difficulty, 16, "preparing")
                    else -> Motion(base, 34 + 3 * difficulty + 3 * rank, 11)
                }
            }
            "stubborn" -> {
                val segment = tick / 120; val phase = tick % 120
                val value = hash(seed, segment)
                val target = (if ((value and 1L) == 1L) 7100 else 1200) + (value % 1701).toInt()
                when {
                    phase >= 88 -> Motion(3800 + (hash(seed xor 0xa341316cL, segment) % 2401).toInt(), 18 + 2 * difficulty, 16, "recovering")
                    phase < 16 -> Motion(target, 18 + 2 * difficulty, 16, "preparing")
                    else -> Motion(target, 70 + 4 * difficulty + 9 * rank, 8, "surging")
                }
            }
            else -> throw IllegalArgumentException("Unknown boat resistance profile")
        }
    }

    fun resistancePhase(challenge: EconomyBoatChallenge, tick: Int): String = if (challenge.rulesVersion >= 3)
        motionV3(challenge.seed, tick.coerceAtLeast(0), challenge.difficulty, requireNotNull(challenge.resistance), requireNotNull(challenge.fishRarity)).phase
        else "cruising"

    /** The old signature keeps V1 tools and vectors readable. New attempts dispatch through their saved version. */
    fun step(frame: Frame, held: Boolean, seed: Long, zoneWidth: Int, difficulty: Int,
        rulesVersion: Int = 1, resistance: String? = null, fishRarity: String? = null, motorResponse: Int = 0, hullDamping: Int = 0): Frame {
        require(seed in 0L..0xffff_ffffL && validZoneWidth(rulesVersion, zoneWidth) && difficulty in 1..5)
        require(rulesVersion in 1..6 && motorResponse in 0..5 && hullDamping in 0..20)
        if (frame.status != "active") return frame
        val half = zoneWidth / 2
        val modernControl = rulesVersion >= 4
        val acceleration = if (held) { if (modernControl) 22 else 26 } else { if (modernControl) -18 else -20 }
        val assist = when {
            rulesVersion < 5 -> 0
            held && frame.velocity < 0 -> motorResponse
            !held && frame.velocity > 0 -> -motorResponse
            else -> 0
        }
        var velocity = (frame.velocity * (if (modernControl) 96 else 94) / 100 + acceleration + assist).coerceIn(-220, 220)
        val freeBar = frame.bar + velocity
        val bar = freeBar.coerceIn(half, 10000 - half)
        // V4 has a damped bottom rebound; slow contacts settle and the upper stop clamps.
        if (bar != freeBar) velocity = if (modernControl && freeBar < half && velocity < -40) -velocity * 40 / 100 else 0
        val movement = if (rulesVersion >= 3) motionV3(seed, frame.tick, difficulty, requireNotNull(resistance), requireNotNull(fishRarity))
            else if (rulesVersion == 2) motion(seed, frame.tick, difficulty, requireNotNull(resistance))
            else Motion(500 + (hash(seed, frame.tick / (60 - 6 * difficulty)) % 9001).toInt(), 35 + 7 * difficulty, 10)
        val limit = if (rulesVersion >= 5) movement.limit * (100 - hullDamping) / 100 else movement.limit
        val fish = (frame.fish + ((movement.target - frame.fish) / movement.divisor).coerceIn(-limit, limit)).coerceIn(0, 10000)
        val progress = (frame.progress + if (abs(fish - bar) <= half) 32 else -45).coerceIn(0, 10000)
        val tick = frame.tick + 1
        return Frame(tick, bar, velocity, fish, progress,
            if (progress == 10000) "caught" else if (progress == 0 || tick == 600) "escaped" else "active")
    }

    fun step(frame: Frame, held: Boolean, challenge: EconomyBoatChallenge): Frame =
        step(frame, held, challenge.seed, challenge.zoneWidth, challenge.difficulty, challenge.rulesVersion, challenge.resistance,
            challenge.fishRarity, challenge.motorResponse ?: 0, challenge.hullDamping ?: 0)

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
