package ru.zhiv.economy

import java.security.SecureRandom
import java.time.Instant
import java.util.UUID

/** Stock is drawn once by the server and persisted with its timer and quantities. */
object EconomyFishingShops {
    private val secure = SecureRandom()
    private val rarityWeight = mapOf("common" to 100, "uncommon" to 60, "rare" to 25, "epic" to 10, "legendary" to 4)
    private data class Candidate(val kind: String, val itemId: String, val price: Long, val remaining: Long, val weight: Int)
    fun expired(shop: EconomyFishingShop?, now: Instant) = shop == null || !now.isBefore(Instant.parse(shop.refreshAt))
    fun create(state: EconomyState, now: Instant, random: (Int) -> Int = secure::nextInt,
        shopId: String = UUID.randomUUID().toString()): EconomyFishingShop {
        val spec = checkNotNull(EconomyRules.catalog.fishing)
        val config = spec.shop
        val home = state.buildings["home"] ?: 1
        val rods = spec.rods.filter { it.price > 0 && it.requiredHomeLevel <= home && it.id !in state.fishing.ownedRods }
            .map { Candidate("rod", it.id, it.price, 1, rarityWeight.getValue(it.rarity)) }.toMutableList()
        val hooks = spec.hooks.filter { it.price > 0 && it.requiredHomeLevel <= home && it.id !in state.fishing.ownedHooks }
            .map { Candidate("hook", it.id, it.price, 1, rarityWeight.getValue(it.rarity)) }.toMutableList()
        val baits = spec.baits.filter { it.requiredHomeLevel <= home }
            .map { Candidate("bait", it.itemId, it.price, config.baitStock, rarityWeight.getValue(it.rarity)) }.toMutableList()
        val chosen = mutableListOf<Candidate>()
        fun take(pool: MutableList<Candidate>) {
            if (pool.isEmpty()) return
            val total = pool.sumOf { it.weight }
            var draw = random(total)
            require(draw in 0 until total)
            for (index in pool.indices) {
                draw -= pool[index].weight
                if (draw < 0) { chosen += pool.removeAt(index); return }
            }
        }
        take(rods); take(hooks); take(baits); take(baits)
        while (chosen.size < config.slots && baits.isNotEmpty()) take(baits)
        return EconomyFishingShop(shopId, now.toString(), now.plusSeconds(config.refreshSeconds).toString(), config.refreshPricePearls,
            chosen.map { EconomyFishingOffer("$shopId:${it.itemId}", it.kind, it.itemId, it.price, it.remaining) })
    }
}
