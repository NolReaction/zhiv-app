package ru.zhiv.economy

import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.jsonObject
import org.junit.jupiter.api.Test
import ru.zhiv.auth.AuthFailure
import java.time.Instant
import java.util.UUID
import kotlin.test.*

class EconomyLeaftailShopTest {
    private val now = Instant.parse("2026-10-16T21:00:00Z")
    private val spec get() = checkNotNull(EconomyRules.catalog.leaftailShop)
    private fun ready() = EconomyRules.initial(homeLevel = 3).copy(inventory = emptyMap(), wallet = EconomyWallet(20_000, 100))
    private fun command(itemId: String = "living_resin", at: Instant = now, price: Long = 2400, quantity: Long = 1) =
        EconomyCommand(UUID.randomUUID().toString(), "ABCD-EFGH-JKMP", 0, "buy_leaftail_item",
            "${EconomyLeaftailShops.cycle(at, spec)}:$itemId", quantity, price)
    private fun failure(code: String, block: () -> Unit) = assertEquals(code, assertFailsWith<AuthFailure>(block = block).code)

    @Test fun `shared catalog sells exactly one of each special item per UTC day for coins`() {
        assertEquals(3, spec.requiredHomeLevel)
        assertEquals(86400L, spec.refreshSeconds)
        assertEquals(setOf("ancient_core", "moon_crystal", "living_resin"), spec.offers.map { it.itemId }.toSet())
        assertTrue(spec.offers.all { it.stock == 1 && it.priceCoins == 2400L })
        var current = ready()
        val original = current
        for (offer in spec.offers) {
            current = EconomyRules.apply(current, command(offer.id), now).first
            assertEquals(1L, current.inventory[offer.itemId])
            failure("ECONOMY_LEAFTAIL_STOCK") { EconomyRules.apply(current, command(offer.id), now) }
        }
        assertEquals(original.wallet.coins - 7200L, current.wallet.coins)
        assertEquals(original.wallet.pearls, current.wallet.pearls)
        assertEquals(spec.offers.associate { it.id to 1 }, current.leaftailShop.purchased)
        assertEquals(original.progression, current.progression)
        assertEquals(original.completedExplorations, current.completedExplorations)
        assertEquals(original.rareDropState, current.rareDropState)
        assertEquals(original.fishing, current.fishing)
    }

    @Test fun `server day and exact quote reject stale malformed gated and unfunded commands`() {
        val state = ready()
        failure("ECONOMY_HOME_REQUIRED") {
            EconomyRules.apply(state.copy(buildings = state.buildings + ("home" to 2)), command(), now)
        }
        failure("ECONOMY_LEAFTAIL_SHOP_CHANGED") {
            EconomyRules.apply(state, command(at = now.minusSeconds(86400)), now)
        }
        failure("ECONOMY_LEAFTAIL_SHOP_CHANGED") { EconomyRules.apply(state, command("wood"), now) }
        for (price in listOf(0L, 2399L, 2401L)) failure("ECONOMY_LEAFTAIL_PRICE_CHANGED") {
            EconomyRules.apply(state, command(price = price), now)
        }
        failure("INVALID_ECONOMY_COMMAND") { EconomyRules.apply(state, command(quantity = 2), now) }
        failure("ECONOMY_RESOURCES") {
            EconomyRules.apply(state.copy(wallet = state.wallet.copy(coins = 2399)), command(), now)
        }
        assertEquals(EconomyLeaftailShopState(), state.leaftailShop)
        assertEquals(20_000L, state.wallet.coins)
        assertTrue(state.inventory.isEmpty())
    }

    @Test fun `UTC midnight renews stock but never honors yesterday quote`() {
        val midnight = Instant.parse("2026-10-17T00:00:00Z")
        val last = midnight.minusNanos(1)
        val request = command(at = last)
        val bought = EconomyRules.apply(ready(), request, last).first
        failure("ECONOMY_LEAFTAIL_SHOP_CHANGED") { EconomyRules.apply(bought, request, midnight) }
        val next = EconomyRules.apply(bought, command(at = midnight), midnight).first
        assertEquals(2L, next.inventory["living_resin"])
        assertEquals(bought.wallet.coins - 2400, next.wallet.coins)
        assertEquals(bought.leaftailShop.cycle + 1, next.leaftailShop.cycle)
        assertEquals(mapOf("living_resin" to 1), next.leaftailShop.purchased)
    }

    @Test fun `inventory item caps and occupied escrow reject atomically without spending stock`() {
        val initial = ready()
        val capacity = EconomyRules.storage(initial).capacity
        failure("ECONOMY_STORAGE_FULL") {
            EconomyRules.apply(initial.copy(inventory = mapOf("wood" to capacity)), command(), now)
        }
        failure("ECONOMY_STORAGE_FULL") {
            EconomyRules.apply(initial.copy(inventory = mapOf("wood" to capacity - 1)), command(), now, mapOf("stone" to 1L))
        }
        failure("ECONOMY_CAPACITY") {
            EconomyRules.apply(initial.copy(inventory = mapOf("living_resin" to ECONOMY_MAX_ITEMS)), command(), now)
        }
        failure("ECONOMY_CAPACITY") {
            EconomyRules.apply(initial.copy(inventory = mapOf("living_resin" to ECONOMY_MAX_ITEMS - 1)), command(), now,
                mapOf("living_resin" to 1L))
        }
        assertEquals(20_000L, initial.wallet.coins)
        assertEquals(EconomyLeaftailShopState(), initial.leaftailShop)
    }

    @Test fun `old saved profiles default stock and bought counters survive JSON roundtrip`() {
        val initial = ready()
        val legacy = economyJson.parseToJsonElement(economyJson.encodeToString(initial)).jsonObject
            .filterKeys { it != "leaftailShop" }.let { kotlinx.serialization.json.JsonObject(it).toString() }
        assertEquals(EconomyLeaftailShopState(), economyJson.decodeFromString<EconomyState>(legacy).leaftailShop)
        val exhausted = spec.offers.fold(initial) { state, offer -> EconomyRules.apply(state, command(offer.id), now).first }
        val restored = economyJson.decodeFromString<EconomyState>(economyJson.encodeToString(exhausted))
        assertEquals(exhausted.leaftailShop, restored.leaftailShop)
        for (offer in spec.offers) failure("ECONOMY_LEAFTAIL_STOCK") { EconomyRules.apply(restored, command(offer.id), now) }
    }

    @Test fun `account merge keeps newest cycle and union of consumed daily stock`() {
        val cycle = EconomyLeaftailShops.cycle(now, spec)
        val first = EconomyLeaftailShopState(cycle, mapOf("living_resin" to 1))
        val second = EconomyLeaftailShopState(cycle, mapOf("moon_crystal" to 1, "living_resin" to 1))
        assertEquals(second, EconomyLeaftailShops.merge(first, second))
        assertEquals(second, EconomyLeaftailShops.merge(second, first))
        val next = EconomyLeaftailShopState(cycle + 1, mapOf("ancient_core" to 1))
        assertEquals(next, EconomyLeaftailShops.merge(first, next))
        assertEquals(next, EconomyLeaftailShops.merge(next, first))
        assertEquals(first, EconomyLeaftailShops.merge(first, EconomyLeaftailShopState()))
    }

    @Test fun `clock rollback cannot replenish a consumed delivery`() {
        val bought = EconomyRules.apply(ready(), command(), now).first
        assertEquals(bought.leaftailShop, EconomyLeaftailShops.normalized(bought.leaftailShop, now.minusSeconds(86400), spec))
        failure("ECONOMY_LEAFTAIL_STOCK") {
            EconomyRules.apply(bought, command(), now.minusSeconds(86400))
        }
    }
}
