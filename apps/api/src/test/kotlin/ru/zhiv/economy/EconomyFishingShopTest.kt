package ru.zhiv.economy

import org.junit.jupiter.api.Test
import ru.zhiv.auth.AuthFailure
import java.time.Instant
import java.util.UUID
import kotlin.test.*

class EconomyFishingShopTest {
    private val now = Instant.parse("2026-10-05T20:00:00Z")
    private fun ready(home: Int = 1): EconomyState {
        val state = EconomyRules.initial().copy(wallet = EconomyWallet(1_000_000, 1000),
            buildings = EconomyRules.initial().buildings + ("home" to home))
        return state.copy(fishingShop = EconomyFishingShops.create(state, now, { 0 }))
    }
    private fun command(action: String, id: String, quantity: Long = 1, price: Long = 0) =
        EconomyCommand(UUID.randomUUID().toString(), "ABCD-EFGH-JKMP", 0, action, id, quantity, price)

    @Test fun `shared deterministic shop vectors home gates and owned tackle match TypeScript`() {
        val state = ready(5)
        val first = EconomyFishingShops.create(state, now, { 0 })
        val last = EconomyFishingShops.create(state, now, { it - 1 })
        assertEquals(listOf("river_rod", "barbed_hook", "crumb_bait", "worm_bait"), first.offers.map { it.itemId })
        assertEquals(listOf("starfall_rod", "leviathan_hook", "firefly_bait", "glow_bait"), last.offers.map { it.itemId })
        assertEquals(now.plusSeconds(21600).toString(), first.refreshAt)
        assertEquals(100L, first.refreshPricePearls)
        val spec = checkNotNull(EconomyRules.catalog.fishing)
        for (home in 1..5) {
            val shop = EconomyFishingShops.create(ready(home), now, { it - 1 })
            assertEquals(shop.offers.size, shop.offers.map { it.itemId }.distinct().size)
            for (offer in shop.offers) {
                val level = spec.rods.find { it.id == offer.itemId }?.requiredHomeLevel
                    ?: spec.hooks.find { it.id == offer.itemId }?.requiredHomeLevel
                    ?: spec.baits.single { it.itemId == offer.itemId }.requiredHomeLevel
                assertTrue(level <= home)
                assertEquals(if (offer.kind == "bait") 5L else 1L, offer.remaining)
            }
        }
        val owned = state.copy(fishing = state.fishing.copy(ownedRods = spec.rods.map { it.id }, ownedHooks = spec.hooks.map { it.id }))
        assertEquals(listOf("bait", "bait", "bait", "bait"), EconomyFishingShops.create(owned, now).offers.map { it.kind })
    }

    @Test fun `stored stock is authoritative and unavailable catalog IDs cannot bypass offers`() {
        val state = ready()
        val shop = checkNotNull(state.fishingShop)
        val offer = shop.offers.single { it.itemId == "worm_bait" }
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

    @Test fun `refresh debits pearls once per accepted state and rejects stale cheap expired and poor requests`() {
        val state = ready()
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
        assertEquals("ECONOMY_FISHING_SHOP_CHANGED", assertFailsWith<AuthFailure> {
            EconomyRules.apply(next, refresh, now.plusSeconds(2))
        }.code)
    }
}
