package ru.zhiv.economy

import java.security.SecureRandom
import java.time.Instant
import java.util.UUID

/** Keep integer selection and replacement eligibility identical to fishing-shop.ts. */
object EconomyFishingShops {
    private val secure = SecureRandom()
    private val categories = listOf("rod", "hook", "bait", "fish")
    private val rarityWeight = mapOf("common" to 100, "uncommon" to 60, "rare" to 25, "epic" to 10, "legendary" to 4)
    private data class Candidate(val kind: String, val itemId: String, val price: Long, val remaining: Long,
        val rarity: String, val weight: Int)
    fun expired(shop: EconomyFishingShop?, now: Instant) = shop == null || !now.isBefore(Instant.parse(shop.refreshAt))
    /** The persisted field is the full-period ceiling, never a trusted current charge. */
    fun refreshPrice(shop: EconomyFishingShop, now: Instant,
        config: EconomyFishingShopConfig = checkNotNull(EconomyRules.catalog.fishing).shop): Long {
        val fullPrice = minOf(shop.refreshPricePearls, config.refreshPricePearls)
        return minOf(fullPrice, remainingTimePearlPrice(shop.refreshAt, now, config.refreshSeconds, fullPrice, config.refreshPriceStepPearls))
    }
    private fun candidates(state: EconomyState): List<Candidate> {
        val spec = checkNotNull(EconomyRules.catalog.fishing)
        val home = state.buildings["home"] ?: 1
        return spec.rods.filter { it.price > 0 && it.requiredHomeLevel <= home && it.id !in state.fishing.ownedRods }
            .map { Candidate("rod", it.id, it.price, 1, it.rarity, 1) } +
            spec.hooks.filter { it.price > 0 && it.requiredHomeLevel <= home && it.id !in state.fishing.ownedHooks }
                .map { Candidate("hook", it.id, it.price, 1, it.rarity, 1) } +
            spec.baits.filter { it.requiredHomeLevel <= home }
                .map { Candidate("bait", it.itemId, it.price, spec.shop.baitStock, it.rarity, rarityWeight.getValue(it.rarity)) } +
            // Ordinary kitchen stock neither reveals nor sells the rare collection.
            spec.fish.filter { it.rarity == "common" }
                .map { Candidate("fish", it.itemId, (it.buyPrice * spec.shop.fishPriceBps + 9999) / 10000,
                    spec.shop.fishStock, it.rarity, 1) }
    }
    private fun trustedDraw(random: (Int) -> Int, total: Int): Int = random(total).also { require(it in 0 until total) }
    private fun take(pool: List<Candidate>, random: (Int) -> Int): Candidate? {
        if (pool.isEmpty()) return null
        var draw = trustedDraw(random, pool.sumOf { it.weight })
        for (item in pool) {
            draw -= item.weight
            if (draw < 0) return item
        }
        return null
    }
    private fun levelOdds(state: EconomyState): Map<String, Int> = checkNotNull(EconomyRules.catalog.fishing)
        .shop.gearRarityBpsByHome[((state.buildings["home"] ?: 1) - 1).coerceIn(0, 4)]
    private fun takeGear(pool: List<Candidate>, state: EconomyState, random: (Int) -> Int): Candidate? {
        if (pool.isEmpty()) return null
        val odds = levelOdds(state)
        var draw = trustedDraw(random, 10000)
        var tier = 0
        while (tier < fishingShopRarities.lastIndex) {
            draw -= odds.getValue(fishingShopRarities[tier])
            if (draw < 0) break
            tier++
        }
        // Missing, owned or excluded models can downgrade a roll, never upgrade it.
        while (tier >= 0) {
            val choices = pool.filter { it.rarity == fishingShopRarities[tier] }
            if (choices.isNotEmpty()) return take(choices, random)
            tier--
        }
        return null
    }
    private fun stock(pool: List<Candidate>, state: EconomyState, now: Instant, random: (Int) -> Int,
        shopId: String): EconomyFishingShop {
        val config = checkNotNull(EconomyRules.catalog.fishing).shop
        val chosen = categories.mapNotNull { kind ->
            val options = pool.filter { it.kind == kind }
            if (kind == "rod" || kind == "hook") takeGear(options, state, random) else take(options, random)
        }
        return EconomyFishingShop(shopId, now.toString(), now.plusSeconds(config.refreshSeconds).toString(), config.refreshPricePearls,
            chosen.map { EconomyFishingOffer("$shopId:${it.itemId}", it.kind, it.itemId, it.price, it.remaining) })
    }
    fun create(state: EconomyState, now: Instant, random: (Int) -> Int = secure::nextInt,
        shopId: String = UUID.randomUUID().toString()): EconomyFishingShop = stock(candidates(state), state, now, random, shopId)
    private fun replacementPool(state: EconomyState): List<Candidate> {
        // Sold-out entries count too: paying cannot merely restock the same item.
        val previous = state.fishingShop?.offers?.map { it.itemId }?.toSet() ?: emptySet()
        return candidates(state).filter { it.itemId !in previous }
    }
    fun canRefresh(state: EconomyState): Boolean {
        val previous = state.fishingShop?.offers
        if (previous.isNullOrEmpty()) return false
        val pool = replacementPool(state)
        val odds = levelOdds(state)
        val lowestTier = fishingShopRarities.indexOfFirst { odds.getValue(it) > 0 }
        // A paid change must offer a different item for every previous category.
        // Do not increase rare odds or charge for losing an occupied gear slot.
        return categories.filter { kind -> kind == "bait" || kind == "fish" || previous.any { it.kind == kind } }
            .all { kind -> pool.any { it.kind == kind &&
                (kind != "rod" && kind != "hook" || fishingShopRarities.indexOf(it.rarity) <= lowestTier) } }
    }
    fun refresh(state: EconomyState, now: Instant, random: (Int) -> Int = secure::nextInt,
        shopId: String = UUID.randomUUID().toString()): EconomyFishingShop? {
        if (!canRefresh(state)) return null
        return stock(replacementPool(state), state, now, random, shopId)
    }
}
