package ru.zhiv.economy

import java.security.SecureRandom

/** A server-private completed-work clock. Client request IDs and calendar time never seed it. */
object EconomyRareDrops {
    private val entropy = SecureRandom()
    data class Prepared(val clock: EconomyRareDropClock, val delivery: EconomyRareDropDelivery, val rewards: Map<String, Long>)

    private fun draw(spec: EconomyRareDropSpec, random: (Int) -> Int): EconomyRareDropClock {
        val span = (spec.maxSeconds - spec.minSeconds + 1).toInt()
        val interval = random(span); val item = random(spec.itemIds.size)
        require(interval in 0 until span && item in spec.itemIds.indices)
        return EconomyRareDropClock(remainingSeconds = spec.minSeconds + interval, itemId = spec.itemIds[item])
    }

    fun prepare(current: EconomyRareDropClock?, seconds: Long, spec: EconomyRareDropSpec,
        random: (Int) -> Int = entropy::nextInt): Prepared {
        require(seconds > 0 && seconds < spec.minSeconds)
        val clock = current ?: draw(spec, random)
        require(clock.version == 1 && clock.remainingSeconds in 1..spec.maxSeconds && clock.itemId in spec.itemIds)
        val item = clock.itemId.takeIf { clock.remainingSeconds <= seconds }
        return Prepared(clock, EconomyRareDropDelivery(seconds = seconds, itemId = item), item?.let { mapOf(it to 1L) }.orEmpty())
    }

    /** Called only after the claim has passed storage checks; preserve work beyond the found item. */
    fun settle(current: EconomyRareDropClock?, delivery: EconomyRareDropDelivery, spec: EconomyRareDropSpec,
        random: (Int) -> Int = entropy::nextInt): EconomyRareDropClock {
        val clock = checkNotNull(current)
        require(delivery.version == 1 && prepare(clock, delivery.seconds, spec, random).delivery.itemId == delivery.itemId)
        val remaining = clock.remainingSeconds - delivery.seconds
        if (remaining > 0) return clock.copy(remainingSeconds = remaining)
        val next = draw(spec, random)
        return next.copy(remainingSeconds = next.remainingSeconds + remaining)
    }

    /** Neither previewing outcomes nor merging accounts may select a closer next drop. */
    fun merge(first: EconomyRareDropClock?, second: EconomyRareDropClock?): EconomyRareDropClock? =
        if (first != null && second != null) if (first.remainingSeconds >= second.remainingSeconds) first else second else first ?: second
}
