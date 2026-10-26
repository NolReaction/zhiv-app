package ru.zhiv.economy

import kotlinx.serialization.Serializable
import java.security.SecureRandom

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
