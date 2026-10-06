package ru.zhiv.economy

import java.math.BigInteger
import java.time.Duration
import java.time.Instant

/** Mirror time-price.ts, preserving a positive fractional final millisecond at tariff boundaries. */
internal fun remainingTimePearlPrice(finishesAt: String, now: Instant, periodSeconds: Long, periodPrice: Long, step: Long): Long {
    val remaining = Duration.between(now, Instant.parse(finishesAt))
    if (remaining.isNegative || remaining.isZero) return 0
    val milliseconds = BigInteger.valueOf(remaining.seconds).multiply(BigInteger.valueOf(1000))
        .add(BigInteger.valueOf((remaining.nano.toLong() + 999_999) / 1_000_000))
    val numerator = milliseconds.multiply(BigInteger.valueOf(periodPrice))
    val denominator = BigInteger.valueOf(periodSeconds).multiply(BigInteger.valueOf(1000)).multiply(BigInteger.valueOf(step))
    return numerator.add(denominator).subtract(BigInteger.ONE).divide(denominator).multiply(BigInteger.valueOf(step)).longValueExact()
}
