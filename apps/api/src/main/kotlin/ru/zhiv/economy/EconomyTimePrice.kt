package ru.zhiv.economy

import java.math.BigInteger
import java.time.Duration
import java.time.Instant

private fun remainingMilliseconds(finishesAt: String, now: Instant): BigInteger {
    val remaining = Duration.between(now, Instant.parse(finishesAt))
    if (remaining.isNegative || remaining.isZero) return BigInteger.ZERO
    return BigInteger.valueOf(remaining.seconds).multiply(BigInteger.valueOf(1000))
        .add(BigInteger.valueOf((remaining.nano.toLong() + 999_999) / 1_000_000))
}

/** Mirror time-price.ts, preserving a positive fractional final millisecond at tariff boundaries. */
internal fun remainingTimePearlPrice(finishesAt: String, now: Instant, periodSeconds: Long, periodPrice: Long, step: Long): Long {
    val milliseconds = remainingMilliseconds(finishesAt, now)
    if (milliseconds == BigInteger.ZERO) return 0
    val numerator = milliseconds.multiply(BigInteger.valueOf(periodPrice))
    val denominator = BigInteger.valueOf(periodSeconds).multiply(BigInteger.valueOf(1000)).multiply(BigInteger.valueOf(step))
    return numerator.add(denominator).subtract(BigInteger.ONE).divide(denominator).multiply(BigInteger.valueOf(step)).longValueExact()
}

/** Interpolate raw pearl points; beyond the last point keep the last segment's slope. */
internal fun remainingTimePearlPrice(finishesAt: String, now: Instant,
    points: List<EconomyTimePricePoint>, step: Long): Long {
    require(points.size >= 2 && step > 0)
    val milliseconds = remainingMilliseconds(finishesAt, now)
    if (milliseconds == BigInteger.ZERO) return 0
    fun at(point: EconomyTimePricePoint) = BigInteger.valueOf(point.seconds).multiply(BigInteger.valueOf(1000))
    val first = points.first()
    if (milliseconds <= at(first)) {
        val price = BigInteger.valueOf(first.pearls)
        val quantum = BigInteger.valueOf(step)
        return price.add(quantum).subtract(BigInteger.ONE).divide(quantum).multiply(quantum).longValueExact()
    }
    val upper = points.indexOfFirst { milliseconds <= at(it) }.let { if (it < 0) points.lastIndex else it }
    val low = points[upper - 1]
    val high = points[upper]
    val range = at(high).subtract(at(low))
    val numerator = BigInteger.valueOf(low.pearls).multiply(range)
        .add(milliseconds.subtract(at(low)).multiply(BigInteger.valueOf(high.pearls - low.pearls)))
    val denominator = range.multiply(BigInteger.valueOf(step))
    return numerator.add(denominator).subtract(BigInteger.ONE).divide(denominator)
        .multiply(BigInteger.valueOf(step)).longValueExact()
}
