package ru.zhiv.economy

import java.security.SecureRandom
import java.time.Instant
import java.util.UUID

/** Keep selection and replacement eligibility identical to fishing-shop.ts. */
object EconomyFishingShops {
    private val secure = SecureRandom()
    private val rarityWeight = mapOf("common" to 100, "uncommon" to 60, "rare" to 25, "epic" to 10, "legendary" to 4)
    private data class Candidate(val kind: String, val itemId: String, val price: Long, val remaining: Long, val weight: Int)
    fun expired(shop: EconomyFishingShop?, now: Instant) = shop == null || !now.isBefore(Instant.parse(shop.refreshAt))
    private fun candidates(state: EconomyState): List<Candidate> {
        val spec = checkNotNull(EconomyRules.catalog.fishing)
        val home = state.buildings["home"] ?: 1
        return spec.rods.filter { it.price > 0 && it.requiredHomeLevel <= home && it.id !in state.fishing.ownedRods }
            .map { Candidate("rod", it.id, it.price, 1, rarityWeight.getValue(it.rarity)) } +
            spec.hooks.filter { it.price > 0 && it.requiredHomeLevel <= home && it.id !in state.fishing.ownedHooks }
                .map { Candidate("hook", it.id, it.price, 1, rarityWeight.getValue(it.rarity)) } +
            spec.baits.filter { it.requiredHomeLevel <= home }
                .map { Candidate("bait", it.itemId, it.price, spec.shop.baitStock, rarityWeight.getValue(it.rarity)) }
    }
    private fun take(pool: MutableList<Candidate>, chosen: MutableList<Candidate>, random: (Int) -> Int) {
        if (pool.isEmpty()) return
        val total = pool.sumOf { it.weight }
        var draw = random(total)
        require(draw in 0 until total)
        for (index in pool.indices) {
            draw -= pool[index].weight
            if (draw < 0) { chosen += pool.removeAt(index); return }
        }
    }
    private fun stock(chosen: List<Candidate>, now: Instant, shopId: String): EconomyFishingShop {
        val config = checkNotNull(EconomyRules.catalog.fishing).shop
        return EconomyFishingShop(shopId, now.toString(), now.plusSeconds(config.refreshSeconds).toString(), config.refreshPricePearls,
            chosen.map { EconomyFishingOffer("$shopId:${it.itemId}", it.kind, it.itemId, it.price, it.remaining) })
    }
    fun create(state: EconomyState, now: Instant, random: (Int) -> Int = secure::nextInt,
        shopId: String = UUID.randomUUID().toString()): EconomyFishingShop {
        val pool = candidates(state)
        val rods = pool.filter { it.kind == "rod" }.toMutableList()
        val hooks = pool.filter { it.kind == "hook" }.toMutableList()
        val baits = pool.filter { it.kind == "bait" }.toMutableList()
        val chosen = mutableListOf<Candidate>()
        take(rods, chosen, random); take(hooks, chosen, random); take(baits, chosen, random); take(baits, chosen, random)
        while (chosen.size < checkNotNull(EconomyRules.catalog.fishing).shop.slots && baits.isNotEmpty()) take(baits, chosen, random)
        return stock(chosen, now, shopId)
    }
    private fun replacementPool(state: EconomyState): List<Candidate> {
        // Include sold-out entries: a paid replacement cannot just restock the same item.
        val previous = state.fishingShop?.offers?.map { it.itemId }?.toSet() ?: emptySet()
        return candidates(state).filter { it.itemId !in previous }
    }
    private fun replacementSize(state: EconomyState) = minOf(state.fishingShop?.offers?.size ?: 0,
        checkNotNull(EconomyRules.catalog.fishing).shop.slots)
    fun canRefresh(state: EconomyState): Boolean {
        val size = replacementSize(state)
        val pool = replacementPool(state)
        return size > 0 && pool.size > size && pool.count { it.weight != rarityWeight.getValue("legendary") } >= size
    }
    fun refresh(state: EconomyState, now: Instant, random: (Int) -> Int = secure::nextInt,
        shopId: String = UUID.randomUUID().toString()): EconomyFishingShop? {
        val pool = replacementPool(state).toMutableList()
        val size = replacementSize(state)
        // Do not guarantee the entire residual pool, including its rarest tackle.
        if (size == 0 || pool.size <= size || pool.count { it.weight != rarityWeight.getValue("legendary") } < size) return null
        val chosen = mutableListOf<Candidate>()
        // No mandatory gear slots: a lone remaining legendary must still compete by weight.
        while (chosen.size < size) take(pool, chosen, random)
        return stock(chosen, now, shopId)
    }
}
