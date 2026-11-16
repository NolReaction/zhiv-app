package ru.zhiv.economy

import kotlin.math.abs
import kotlin.math.min

internal const val BOAT_CAST_CYCLE_MS = 60_000
private const val GREEN_RADIUS = 8

private fun triangle(time: Int, period: Int, height: Int): Int {
    val phase = time % period
    return 2 * height * min(phase, period - phase) / period
}

/** Replays the same public aiming track as boat-cast-aim.ts from the released hold offset. */
internal fun boatCastQuality(voyageId: String, castNumber: Int, heldMs: Int): Int {
    var seed = 0
    for (unit in voyageId) seed = (31 * seed + unit.code) % 65_521
    seed = (seed + 977 * castNumber) % 65_521
    val elapsed = heldMs.coerceAtLeast(0) % BOAT_CAST_CYCLE_MS
    val marker = triangle(elapsed, 2000, 100)
    val drift = triangle(elapsed + seed, 2400, 26)
    val ripple = triangle(elapsed + (seed % 251) * 19, 500, 6)
    val distance = abs(marker - (48 + drift + ripple))
    return (100 - 2 * distance - (distance - GREEN_RADIUS).coerceAtLeast(0)).coerceAtLeast(0)
}
