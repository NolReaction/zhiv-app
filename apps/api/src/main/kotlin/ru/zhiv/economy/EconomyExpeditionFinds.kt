package ru.zhiv.economy

import kotlinx.serialization.Serializable
import java.security.SecureRandom

@Serializable data class EconomyExpeditionLootRange(val itemId: String, val min: Long, val max: Long) {
    init { require(min in 0L..max && max in 1L..ECONOMY_MAX_ITEMS) }
}
@Serializable data class EconomyExpeditionFind(val itemId: String, val quantity: Long, val weight: Int) {
    init { require(quantity in 1L..ECONOMY_MAX_ITEMS && weight in 1..1_000_000) }
}
@Serializable data class EconomyExpeditionFinds(val emptyWeight: Int, val entries: List<EconomyExpeditionFind>) {
    init {
        require(emptyWeight in 0..1_000_000 && entries.isNotEmpty() && entries.size <= 100)
        require(entries.map { it.itemId }.distinct().size == entries.size)
        require(emptyWeight.toLong() + entries.sumOf { it.weight.toLong() } in 1L..Int.MAX_VALUE.toLong())
    }
}

/** Private outcomes are drawn on acceptance and delivered only by an atomic claim. */
object EconomyExpeditionLoot {
    private val entropy = SecureRandom()
    fun maximumBonus(route: EconomyExploration): Long =
        (route.loot?.sumOf { it.max } ?: 0L) + (route.finds?.entries?.maxOf { it.quantity } ?: 0L)

    fun draw(route: EconomyExploration, random: (Int) -> Int = entropy::nextInt): Map<String, Long> {
        val rewards = mutableMapOf<String, Long>()
        route.loot?.forEach { entry ->
            val size = (entry.max - entry.min + 1).toInt()
            val roll = if (size == 1) 0 else random(size)
            require(roll in 0 until size)
            val quantity = entry.min + roll
            if (quantity > 0) rewards[entry.itemId] = quantity
        }
        route.finds?.let { draw(it, random) }?.forEach { (id, quantity) -> rewards[id] = (rewards[id] ?: 0L) + quantity }
        return rewards
    }

    fun draw(spec: EconomyExpeditionFinds, random: (Int) -> Int = entropy::nextInt): Map<String, Long> {
        val total = spec.emptyWeight + spec.entries.sumOf { it.weight }
        var roll = random(total)
        require(roll in 0 until total)
        if (roll < spec.emptyWeight) return emptyMap()
        roll -= spec.emptyWeight
        for (entry in spec.entries) {
            if (roll < entry.weight) return mapOf(entry.itemId to entry.quantity)
            roll -= entry.weight
        }
        error("Invalid expedition find weights")
    }

    fun delivery(job: EconomyJob): EconomyJob {
        val finds = job.expeditionFinds ?: return job
        val rewards = job.rewards.toMutableMap()
        finds.forEach { (id, count) ->
            val held = rewards[id] ?: 0L
            if (count > ECONOMY_MAX_ITEMS - held) economyFailure("ECONOMY_CAPACITY", "Запас этого предмета достиг предела. Сначала освободите место.")
            rewards[id] = held + count
        }
        return job.copy(rewards = rewards, expeditionFinds = null)
    }
}
