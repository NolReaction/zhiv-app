package ru.zhiv.economy

import kotlinx.serialization.encodeToString
import org.junit.jupiter.api.Test
import ru.zhiv.auth.AuthFailure
import java.time.Instant
import java.util.UUID
import kotlin.test.*

class EconomyLeaftailAssortmentTest {
    private val now = Instant.parse("2026-10-18T17:00:00Z")
    private val spec get() = checkNotNull(EconomyRules.catalog.leaftailShop)
    private fun ready(home: Int = 3) = EconomyRules.initial(homeLevel = home).copy(inventory = emptyMap(), wallet = EconomyWallet(1_000_000, 100))
    private fun command(offer: EconomyLeaftailOffer, at: Instant = now) = EconomyCommand(UUID.randomUUID().toString(),
        "ABCD-EFGH-JKMP", 0, "buy_leaftail_item", "${EconomyLeaftailShops.cycle(at, spec)}:${offer.id}", 1, offer.priceCoins)
    private fun failure(code: String, block: () -> Unit) = assertEquals(code, assertFailsWith<AuthFailure>(block = block).code)

    @Test fun `additive catalog leaves legacy delivery intact and mixed offers roundtrip with guarded kind`() {
        assertEquals(6, spec.offers.size)
        assertTrue(spec.offers.all { it.kind == "item" })
        assertEquals(mapOf("wardrobe" to 6, "rod" to 7, "hook" to 6, "bait" to 2), spec.travelOffers.groupingBy { it.kind }.eachCount())
        assertEquals(spec, economyJson.decodeFromString<EconomyLeaftailShopConfig>(economyJson.encodeToString(spec)))
        val old = economyJson.decodeFromString<EconomyLeaftailOffer>("""{"id":"living_resin","itemId":"living_resin","priceCoins":2400,"stock":1}""")
        assertEquals("item", old.kind); assertEquals(1, old.requiredHomeLevel)
        assertTrue(EconomyLeaftailShops.validOffer(EconomyRules.catalog, old))
        val hat = spec.travelOffers.first { it.kind == "wardrobe" }
        assertFailsWith<IllegalArgumentException> { spec.copy(offers = listOf(hat)) }
        assertFailsWith<IllegalArgumentException> { spec.copy(travelOffers = listOf(hat.copy(id = spec.offers.first().id))) }
        assertFailsWith<IllegalArgumentException> { hat.copy(kind = "fish") }
        assertFalse(EconomyLeaftailShops.validOffer(EconomyRules.catalog, hat.copy(kind = "item")))
        assertFalse(EconomyLeaftailShops.validOffer(EconomyRules.catalog, hat.copy(itemId = "amber_scarf")))
        val rod = spec.travelOffers.first { it.kind == "rod" }
        assertFalse(EconomyLeaftailShops.validOffer(EconomyRules.catalog, rod.copy(priceCoins = rod.priceCoins - 1)))
        assertFalse(EconomyLeaftailShops.validOffer(EconomyRules.catalog, rod.copy(quantity = 2)))
        assertFalse(EconomyLeaftailShops.validOffer(EconomyRules.catalog, rod.copy(itemId = "willow_rod")))
    }

    @Test fun `permanent clothes skip pantry space preserve tackle and reject generic shop bypass or new day repurchase`() {
        var state = ready().let { it.copy(inventory = mapOf("wood" to EconomyRules.storage(it).capacity)) }
        val before = state
        for (offer in spec.travelOffers.filter { it.kind == "wardrobe" }) {
            val next = EconomyRules.apply(state, command(offer), now).first
            assertTrue(offer.itemId in next.wardrobe)
            assertEquals(state.wardrobe.size + 1, next.wardrobe.size)
            assertEquals(before.inventory, next.inventory)
            assertEquals(before.fishing, next.fishing)
            assertEquals(state.wallet.coins - offer.priceCoins, next.wallet.coins)
            failure("ECONOMY_LEAFTAIL_STOCK") { EconomyRules.apply(next, command(offer), now) }
            failure("ECONOMY_WARDROBE_OWNED") { EconomyRules.apply(next, command(offer, now.plusSeconds(86400)), now.plusSeconds(86400)) }
            for (prefix in listOf("", "coins:", "pearls:")) failure("ECONOMY_WARDROBE_ITEM") {
                EconomyRules.apply(state, command(offer).copy(action = "buy_wardrobe_item", targetId = "$prefix${offer.itemId}"), now)
            }
            state = next
        }
        assertEquals(before.wallet.pearls, state.wallet.pearls)
        assertEquals(before.progression, state.progression)
        assertEquals(before.completedExplorations, state.completedExplorations)
    }

    @Test fun `rods and hooks are permanent do not autoequip and do not use capacity including occupied escrow`() {
        var state = ready(4).let { it.copy(inventory = mapOf("wood" to EconomyRules.storage(it).capacity)) }
        val before = state
        for (offer in spec.travelOffers.filter { it.kind in setOf("rod", "hook") }) {
            val next = EconomyRules.apply(state, command(offer), now, mapOf("fiber" to 1)).first
            if (offer.kind == "rod") assertEquals(state.fishing.ownedRods + offer.itemId, next.fishing.ownedRods)
            else assertEquals(state.fishing.ownedHooks + offer.itemId, next.fishing.ownedHooks)
            assertEquals(before.inventory, next.inventory)
            assertEquals(before.fishing.equippedRodId, next.fishing.equippedRodId)
            assertEquals(before.fishing.equippedHookId, next.fishing.equippedHookId)
            assertEquals(before.fishing.equippedBaitId, next.fishing.equippedBaitId)
            failure("ECONOMY_FISHING_OWNED") { EconomyRules.apply(next, command(offer, now.plusSeconds(86400)), now.plusSeconds(86400)) }
            state = next
        }
    }

    @Test fun `bait requires all five inventory places and item cap including escrow before debit or stock consumption`() {
        for (offer in spec.travelOffers.filter { it.kind == "bait" }) {
            val state = ready(4)
            val capacity = EconomyRules.storage(state).capacity
            assertEquals(5L, offer.quantity)
            failure("ECONOMY_STORAGE_FULL") {
                EconomyRules.apply(state.copy(inventory = mapOf("wood" to capacity - 4)), command(offer), now)
            }
            failure("ECONOMY_STORAGE_FULL") {
                EconomyRules.apply(state.copy(inventory = mapOf("wood" to capacity - 5)), command(offer), now, mapOf("fiber" to 1))
            }
            failure("ECONOMY_CAPACITY") {
                EconomyRules.apply(state.copy(inventory = mapOf(offer.itemId to ECONOMY_MAX_ITEMS - 4)), command(offer), now)
            }
            failure("ECONOMY_CAPACITY") {
                EconomyRules.apply(state.copy(inventory = mapOf(offer.itemId to ECONOMY_MAX_ITEMS - 5)), command(offer), now, mapOf(offer.itemId to 1))
            }
            val fitting = state.copy(inventory = mapOf("wood" to capacity - 5))
            val bought = EconomyRules.apply(fitting, command(offer), now).first
            assertEquals(5L, bought.inventory[offer.itemId])
            assertEquals(0L, EconomyRules.storage(bought).available)
            assertEquals(state.wallet.coins - offer.priceCoins, bought.wallet.coins)
            assertEquals(state.fishing, bought.fishing)
            assertEquals(EconomyLeaftailShopState(), state.leaftailShop)
        }
    }

    @Test fun `new gear home gates and exact quotes reject before spending while clock rollback never replenishes`() {
        val initial = ready()
        val dusk = spec.travelOffers.filter { it.requiredHomeLevel == 4 }
        assertEquals(setOf("dusk_rod", "dusk_hook", "dusk_bait", "abyss_rod", "deep_hook"), dusk.map { it.itemId }.toSet())
        for (offer in dusk) failure("ECONOMY_HOME_REQUIRED") { EconomyRules.apply(initial, command(offer), now) }
        for (offer in spec.travelOffers.filter { it.requiredHomeLevel <= 3 }) {
            for (price in listOf(0L, offer.priceCoins - 1, offer.priceCoins + 1)) failure("ECONOMY_LEAFTAIL_PRICE_CHANGED") {
                EconomyRules.apply(initial, command(offer).copy(totalPrice = price), now)
            }
            failure("INVALID_ECONOMY_COMMAND") { EconomyRules.apply(initial, command(offer).copy(quantity = 2), now) }
            failure("ECONOMY_RESOURCES") { EconomyRules.apply(initial.copy(wallet = EconomyWallet(offer.priceCoins - 1, 100)), command(offer), now) }
            val bought = EconomyRules.apply(initial, command(offer), now).first
            failure("ECONOMY_LEAFTAIL_STOCK") { EconomyRules.apply(bought, command(offer), now.minusSeconds(86400)) }
            failure("ECONOMY_LEAFTAIL_SHOP_CHANGED") { EconomyRules.apply(bought, command(offer), now.plusSeconds(86400)) }
        }
        assertEquals(EconomyLeaftailShopState(), initial.leaftailShop)
        assertEquals(1_000_000L, initial.wallet.coins)
    }

    @Test fun `Pleska generation and injected saved offers reject all exclusive tackle`() {
        val state = ready(5)
        val fishing = checkNotNull(EconomyRules.catalog.fishing)
        val ids = (fishing.rods.filter { it.shop == "leaftail" }.map { it.id } +
            fishing.hooks.filter { it.shop == "leaftail" }.map { it.id } + fishing.baits.filter { it.shop == "leaftail" }.map { it.itemId }).toSet()
        repeat(80) { ticket ->
            assertTrue(EconomyFishingShops.create(state, now, { ticket % it }).offers.none { it.itemId in ids })
        }
        for (offer in spec.travelOffers.filter { it.itemId in ids }) {
            val forged = EconomyFishingOffer("forged:${offer.itemId}", offer.kind, offer.itemId, 1, 5)
            val injected = state.copy(fishingShop = EconomyFishingShop(UUID.randomUUID().toString(), now.toString(), now.plusSeconds(21600).toString(), 100, listOf(forged)))
            failure("ECONOMY_FISHING_ITEM") { EconomyRules.apply(injected, command(offer).copy(action = "buy_fishing_item", targetId = forged.id, totalPrice = 1), now) }
            assertEquals(state.wallet, injected.wallet)
            assertEquals(state.fishing, injected.fishing)
        }
    }
}
