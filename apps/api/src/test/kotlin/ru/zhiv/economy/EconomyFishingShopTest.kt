package ru.zhiv.economy

import org.junit.jupiter.api.Test
import ru.zhiv.auth.AuthFailure
import java.time.Instant
import java.util.UUID
import kotlin.test.*

class EconomyFishingShopTest {
    private val now = Instant.parse("2026-10-05T20:00:00Z")
    private fun ready(home: Int = 1, gearTicket: Int = 0): EconomyState {
        val state = EconomyRules.initial().copy(wallet = EconomyWallet(1_000_000, 1000),
            buildings = EconomyRules.initial().buildings + ("home" to home))
        return state.copy(fishingShop = EconomyFishingShops.create(state, now, { if (it == 10000) gearTicket else 0 }))
    }
    private fun command(action: String, id: String, quantity: Long = 1, price: Long = 0) =
        EconomyCommand(UUID.randomUUID().toString(), "ABCD-EFGH-JKMP", 0, action, id, quantity, price)

    @Test fun `shared deterministic shop vectors keep one offer per category and home gates`() {
        val state = ready(5)
        val first = EconomyFishingShops.create(state, now, { 0 })
        val last = EconomyFishingShops.create(state, now, { it - 1 })
        assertEquals(listOf("river_rod", "barbed_hook", "crumb_bait", "fish"), first.offers.map { it.itemId })
        assertEquals(listOf("starfall_rod", "leviathan_hook", "firefly_bait", "fish_rudd"), last.offers.map { it.itemId })
        assertEquals(now.plusSeconds(21600).toString(), first.refreshAt)
        assertEquals(100L, first.refreshPricePearls)
        val spec = checkNotNull(EconomyRules.catalog.fishing)
        for (home in 1..5) {
            val shop = EconomyFishingShops.create(ready(home), now, { it - 1 })
            assertEquals(listOf("rod", "hook", "bait", "fish"), shop.offers.map { it.kind })
            for (offer in shop.offers) {
                val level = spec.rods.find { it.id == offer.itemId }?.requiredHomeLevel
                    ?: spec.hooks.find { it.id == offer.itemId }?.requiredHomeLevel
                    ?: spec.baits.find { it.itemId == offer.itemId }?.requiredHomeLevel ?: 1
                assertTrue(level <= home)
                assertEquals(when (offer.kind) { "bait" -> 5L; "fish" -> 3L; else -> 1L }, offer.remaining)
            }
        }
        val owned = state.copy(fishing = state.fishing.copy(ownedRods = spec.rods.map { it.id }, ownedHooks = spec.hooks.map { it.id }))
        assertEquals(listOf("bait", "fish"), EconomyFishingShops.create(owned, now).offers.map { it.kind })
    }

    @Test fun `every integer rarity ticket follows level odds and ownership never upgrades a miss`() {
        val spec = checkNotNull(EconomyRules.catalog.fishing)
        for (home in 1..5) {
            val state = ready(home)
            val counts = fishingShopRarities.associateWith { 0 }.toMutableMap()
            repeat(10000) { ticket ->
                val stock = EconomyFishingShops.create(state, now, { if (it == 10000) ticket else 0 }, "ticket")
                val rod = spec.rods.single { rod -> rod.id == stock.offers.single { it.kind == "rod" }.itemId }
                val hook = spec.hooks.single { hook -> hook.id == stock.offers.single { it.kind == "hook" }.itemId }
                assertEquals(rod.rarity, hook.rarity)
                counts[rod.rarity] = counts.getValue(rod.rarity) + 1
            }
            assertEquals(spec.shop.gearRarityBpsByHome[home - 1], counts)
        }
        for (home in listOf(4, 5)) {
            val state = ready(home).let { it.copy(fishing = it.fishing.copy(
                ownedRods = spec.rods.filter { it.rarity != "legendary" }.map { it.id },
                ownedHooks = spec.hooks.filter { it.rarity != "legendary" }.map { it.id })) }
            var legendary = 0
            repeat(10000) { ticket ->
                val shop = EconomyFishingShops.create(state, now, { if (it == 10000) ticket else 0 }, "owned")
                if (shop.offers.any { it.kind == "rod" }) legendary++
                assertEquals(shop.offers.any { it.kind == "rod" }, shop.offers.any { it.kind == "hook" })
            }
            assertEquals(if (home == 4) 20 else 50, legendary)
        }
    }

    @Test fun `stored stock is authoritative and unavailable catalog IDs cannot bypass offers`() {
        val state = ready()
        val shop = checkNotNull(state.fishingShop)
        val offer = shop.offers.single { it.kind == "bait" }
        assertEquals("ECONOMY_FISHING_SHOP_CHANGED", assertFailsWith<AuthFailure> {
            EconomyRules.apply(state, command("buy_fishing_item", offer.itemId, price = offer.unitPrice), now)
        }.code)
        val bought = EconomyRules.apply(state, command("buy_fishing_item", offer.id, 4, offer.unitPrice * 4), now).first
        assertEquals(4L, bought.inventory[offer.itemId])
        assertTrue(bought.fishing.catches.isEmpty())
        assertEquals(1L, checkNotNull(bought.fishingShop).offers.single { it.id == offer.id }.remaining)
        assertEquals("ECONOMY_FISHING_STOCK", assertFailsWith<AuthFailure> {
            EconomyRules.apply(bought, command("buy_fishing_item", offer.id, 2, offer.unitPrice * 2), now)
        }.code)
        assertEquals("ECONOMY_FISHING_SHOP_CHANGED", assertFailsWith<AuthFailure> {
            EconomyRules.apply(state, command("buy_fishing_item", offer.id, price = offer.unitPrice), Instant.parse(shop.refreshAt))
        }.code)
    }

    @Test fun `discounted fish stays bounded pays server quote and never unlocks catch collection`() {
        val state = ready()
        val offer = checkNotNull(state.fishingShop).offers.single { it.kind == "fish" }
        assertEquals(128L, offer.unitPrice)
        val bought = EconomyRules.apply(state, command("buy_fishing_item", offer.id, 2, 300), now).first
        assertEquals(state.wallet.coins - 256, bought.wallet.coins)
        assertEquals((state.inventory[offer.itemId] ?: 0) + 2, bought.inventory[offer.itemId])
        assertEquals(state.fishing, bought.fishing)
        assertEquals(state.progression, bought.progression)
        assertEquals(1L, checkNotNull(bought.fishingShop).offers.single { it.id == offer.id }.remaining)
        assertEquals("ECONOMY_FISHING_PRICE_CHANGED", assertFailsWith<AuthFailure> {
            EconomyRules.apply(state, command("buy_fishing_item", offer.id, price = 127), now)
        }.code)
        assertEquals("ECONOMY_FISHING_STOCK", assertFailsWith<AuthFailure> {
            EconomyRules.apply(state, command("buy_fishing_item", offer.id, 4, 512), now)
        }.code)
        assertEquals("ECONOMY_STORAGE_FULL", assertFailsWith<AuthFailure> {
            EconomyRules.apply(state.copy(inventory = mapOf("wood" to 190L)),
                command("buy_fishing_item", offer.id, price = 128), now, mapOf("stone" to 10L))
        }.code)
        val forged = state.copy(fishingShop = checkNotNull(state.fishingShop).copy(offers = listOf(
            offer.copy(itemId = "fish_shark"))))
        assertEquals("ECONOMY_FISHING_ITEM", assertFailsWith<AuthFailure> {
            EconomyRules.apply(forged, command("buy_fishing_item", offer.id, price = offer.unitPrice), now)
        }.code)
        val spec = checkNotNull(EconomyRules.catalog.fishing)
        for (fish in spec.fish.filter { it.rarity == "common" }) {
            val price = (fish.buyPrice * spec.shop.fishPriceBps + 9999) / 10000
            assertTrue(price > EconomyRules.catalog.items.single { it.id == fish.itemId }.baseSellPrice)
        }
    }

    @Test fun `refresh debits pearls once per accepted state and rejects stale cheap expired and poor requests`() {
        val state = ready(5, 8000)
        val shop = checkNotNull(state.fishingShop)
        val refresh = command("refresh_fishing_shop", shop.id, price = 100)
        assertEquals("ECONOMY_FISHING_PRICE_CHANGED", assertFailsWith<AuthFailure> {
            EconomyRules.apply(state, refresh.copy(totalPrice = 99), now)
        }.code)
        assertEquals("ECONOMY_PEARLS", assertFailsWith<AuthFailure> {
            EconomyRules.apply(state.copy(wallet = state.wallet.copy(pearls = 0)), refresh, now)
        }.code)
        assertEquals("ECONOMY_FISHING_SHOP_CHANGED", assertFailsWith<AuthFailure> {
            EconomyRules.apply(state, refresh, Instant.parse(shop.refreshAt))
        }.code)
        val next = EconomyRules.apply(state, refresh, now.plusSeconds(1)).first
        assertEquals(900L, next.wallet.pearls)
        assertEquals(state.wallet.coins, next.wallet.coins)
        assertNotEquals(shop.id, next.fishingShop?.id)
        assertEquals(listOf("rod", "hook", "bait", "fish"), checkNotNull(next.fishingShop).offers.map { it.kind })
        assertTrue(checkNotNull(next.fishingShop).offers.none { offer -> shop.offers.any { it.itemId == offer.itemId } })
        assertEquals("ECONOMY_FISHING_SHOP_CHANGED", assertFailsWith<AuthFailure> {
            EconomyRules.apply(next, refresh, now.plusSeconds(2))
        }.code)
    }

    @Test fun `paid replacements preserve category slots exclude even sold-out IDs and never raise legendary odds`() {
        val state = ready(5, 8000).let { it.copy(fishingShop = checkNotNull(it.fishingShop).let { shop ->
            shop.copy(offers = shop.offers.map { offer -> offer.copy(remaining = 0) }) }) }
        assertTrue(EconomyFishingShops.canRefresh(state))
        assertEquals(listOf("river_rod", "barbed_hook", "worm_bait", "fish_silverfin"),
            checkNotNull(EconomyFishingShops.refresh(state, now, { 0 })).offers.map { it.itemId })
        val totals = mutableListOf<Int>()
        assertEquals(listOf("starfall_rod", "leviathan_hook", "firefly_bait", "fish_rudd"),
            checkNotNull(EconomyFishingShops.refresh(state, now, { totals += it; it - 1 })).offers.map { it.itemId })
        assertEquals(listOf(10000, 1, 10000, 1, 95, 2), totals)
        var legendary = 0
        repeat(10000) { ticket ->
            val shop = checkNotNull(EconomyFishingShops.refresh(state, now, { if (it == 10000) ticket else 0 }, "paid"))
            assertEquals(listOf("rod", "hook", "bait", "fish"), shop.offers.map { it.kind })
            assertTrue(shop.offers.none { offer -> checkNotNull(state.fishingShop).offers.any { it.itemId == offer.itemId } })
            if (shop.offers.any { it.itemId == "starfall_rod" }) legendary++
        }
        assertEquals(50, legendary)
    }

    @Test fun `starter counter has a different ordinary rod and hook on paid replacement`() {
        val state = ready()
        assertTrue(EconomyFishingShops.canRefresh(state))
        val next = checkNotNull(EconomyFishingShops.refresh(state, now, { 0 }))
        assertEquals(listOf("brook_rod", "round_hook", "worm_bait", "fish_silverfin"), next.offers.map { it.itemId })
        val old = checkNotNull(state.fishingShop)
        assertTrue(next.offers.none { offer -> old.offers.any { it.itemId == offer.itemId } })
        val second = checkNotNull(EconomyFishingShops.refresh(state.copy(fishingShop = next), now, { 0 }))
        assertEquals(listOf("river_rod", "barbed_hook", "crumb_bait", "fish"), second.offers.map { it.itemId })
    }

    @Test fun `exhausted ordinary alternatives cannot charge or promote a rare replacement`() {
        for (home in 1..5) {
            val initial = ready(home).let { it.copy(fishing = it.fishing.copy(
                ownedRods = it.fishing.ownedRods + "brook_rod", ownedHooks = it.fishing.ownedHooks + "round_hook")) }
            assertFalse(EconomyFishingShops.canRefresh(initial))
            assertNull(EconomyFishingShops.refresh(initial, now, { error("must not draw") }))
            assertEquals("ECONOMY_FISHING_SHOP_NO_REPLACEMENT", assertFailsWith<AuthFailure> {
                EconomyRules.apply(initial, command("refresh_fishing_shop", checkNotNull(initial.fishingShop).id, price = 100), now)
            }.code)
            assertEquals(1000L, initial.wallet.pearls)
            assertEquals(4, EconomyFishingShops.create(initial, now.plusSeconds(21600), { 0 }).offers.size)
        }
        val depleted = ready(5, 8000).let { it.copy(fishing = it.fishing.copy(
            ownedRods = it.fishing.ownedRods + listOf("river_rod", "brook_rod"))) }
        assertFalse(EconomyFishingShops.canRefresh(depleted))
        assertNull(EconomyFishingShops.refresh(depleted, now, { error("must not draw") }))
    }
}
