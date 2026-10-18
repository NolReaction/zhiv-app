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
    private val owner = "ABCD-EFGH-JKMP"
    private val spec get() = checkNotNull(EconomyRules.catalog.leaftailShop)
    private fun ready() = EconomyRules.initial(homeLevel = 3).copy(inventory = emptyMap(), wallet = EconomyWallet(20_000, 100))
    private fun finds(at: Instant = now) = EconomyLeaftailShops.offers(EconomyRules.catalog, EconomyLeaftailShops.cycle(at, spec), owner)
        .filter { offer -> EconomyRules.catalog.items.any { it.id == offer.itemId && it.category == "special" } }
    private fun command(itemId: String? = null, at: Instant = now, price: Long = 2400, quantity: Long = 1) =
        EconomyCommand(UUID.randomUUID().toString(), owner, 0, "buy_leaftail_item",
            "${EconomyLeaftailShops.cycle(at, spec)}:${itemId ?: finds(at).first().id}", quantity, price)
    private fun failure(code: String, block: () -> Unit) = assertEquals(code, assertFailsWith<AuthFailure>(block = block).code)

    @Test fun `delivery sells only one or two selected special items per account and UTC day for coins`() {
        assertEquals(3, spec.requiredHomeLevel)
        assertEquals(86400L, spec.refreshSeconds)
        val pool = spec.offers.filter { it.itemId in setOf("ancient_core", "moon_crystal", "living_resin") }
        assertEquals(setOf("ancient_core", "moon_crystal", "living_resin"), pool.map { it.itemId }.toSet())
        assertTrue(pool.all { it.stock == 1 && it.quantity == 1L && it.priceCoins == 2400L })
        val delivered = finds()
        assertTrue(delivered.size in 1..2)
        var current = ready()
        val original = current
        for (offer in delivered) {
            current = EconomyRules.apply(current, command(offer.id), now).first
            assertEquals(1L, current.inventory[offer.itemId])
            failure("ECONOMY_LEAFTAIL_STOCK") { EconomyRules.apply(current, command(offer.id), now) }
        }
        assertEquals(original.wallet.coins - delivered.sumOf { it.priceCoins }, current.wallet.coins)
        assertEquals(original.wallet.pearls, current.wallet.pearls)
        assertEquals(delivered.associate { it.id to 1 }, current.leaftailShop.purchased)
        assertEquals(original.progression, current.progression)
        assertEquals(original.completedExplorations, current.completedExplorations)
        assertEquals(original.rareDropState, current.rareDropState)
        assertEquals(original.fishing, current.fishing)
    }

    @Test fun `personal finding vectors match browser stock including long cycle and UTF16 identity`() {
        val special = EconomyRules.catalog.items.filter { it.category == "special" }.map { it.id }.toSet()
        fun ids(identity: String, cycle: Long) = EconomyLeaftailShops.offers(EconomyRules.catalog, cycle, identity)
            .filter { it.itemId in special }.map { it.id }
        val vectors = listOf(
            Triple("AAAA-0000-0001", 20742L, listOf("ancient_core", "living_resin")),
            Triple("AAAA-0000-0001", 20743L, listOf("living_resin")),
            Triple("AAAA-0000-0002", 20742L, listOf("living_resin")),
            Triple("AAAA-0000-0002", 20743L, listOf("moon_crystal", "living_resin")),
            Triple(owner, ECONOMY_MAX_REVISION, listOf("moon_crystal", "living_resin")),
            Triple("Мохлик", 20743L, listOf("ancient_core")),
        )
        for ((identity, cycle, expected) in vectors) assertEquals(expected, ids(identity, cycle))
        val deliveries = (0..255).map { ids("AAAA-0000-${it.toString().padStart(4, '0')}", 20742L + it % 8) }
        assertTrue(deliveries.all { it.size in 1..2 })
        assertEquals(setOf(1, 2), deliveries.map { it.size }.toSet())
        assertEquals(3, deliveries.flatten().toSet().size)
        assertTrue(ids("", 20742).isEmpty())
    }

    @Test fun `an absent personal finding is rejected before any balance inventory or stock mutation`() {
        val initial = ready()
        val selected = finds().map { it.id }.toSet()
        val absent = spec.offers.first { it.itemId in setOf("ancient_core", "moon_crystal", "living_resin") && it.id !in selected }
        failure("ECONOMY_LEAFTAIL_SHOP_CHANGED") { EconomyRules.apply(initial, command(absent.id), now) }
        assertEquals(ready(), initial)
        val bought = EconomyRules.apply(initial, command(), now).first
        val saved = EconomyLeaftailShops.normalized(bought.leaftailShop, now.minusSeconds(86400), spec)
        assertEquals(bought.leaftailShop.cycle, saved.cycle)
        assertEquals(EconomyLeaftailShops.offers(EconomyRules.catalog, saved.cycle, owner),
            EconomyLeaftailShops.offers(EconomyRules.catalog, EconomyLeaftailShops.cycle(now, spec), owner))
        failure("ECONOMY_LEAFTAIL_SHOP_CHANGED") { EconomyRules.apply(bought, command(absent.id), now.minusSeconds(86400)) }
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
        val nextId = finds(midnight).first().itemId
        assertEquals((bought.inventory[nextId] ?: 0L) + 1, next.inventory[nextId])
        assertEquals(bought.wallet.coins - 2400, next.wallet.coins)
        assertEquals(bought.leaftailShop.cycle + 1, next.leaftailShop.cycle)
        assertEquals(mapOf(finds(midnight).first().id to 1), next.leaftailShop.purchased)
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
        val itemId = finds().first().itemId
        failure("ECONOMY_CAPACITY") {
            EconomyRules.apply(initial.copy(inventory = mapOf(itemId to ECONOMY_MAX_ITEMS)), command(), now)
        }
        failure("ECONOMY_CAPACITY") {
            EconomyRules.apply(initial.copy(inventory = mapOf(itemId to ECONOMY_MAX_ITEMS - 1)), command(), now,
                mapOf(itemId to 1L))
        }
        assertEquals(20_000L, initial.wallet.coins)
        assertEquals(EconomyLeaftailShopState(), initial.leaftailShop)
    }

    @Test fun `old saved profiles default stock and bought counters survive JSON roundtrip`() {
        val initial = ready()
        val legacy = economyJson.parseToJsonElement(economyJson.encodeToString(initial)).jsonObject
            .filterKeys { it != "leaftailShop" }.let { kotlinx.serialization.json.JsonObject(it).toString() }
        assertEquals(EconomyLeaftailShopState(), economyJson.decodeFromString<EconomyState>(legacy).leaftailShop)
        val selected = EconomyLeaftailShops.offers(EconomyRules.catalog, EconomyLeaftailShops.cycle(now, spec), owner)
            .filter { it.kind == "item" }
        val exhausted = selected.fold(initial) { state, offer -> EconomyRules.apply(state, command(offer.id, price = offer.priceCoins), now).first }
        val restored = economyJson.decodeFromString<EconomyState>(economyJson.encodeToString(exhausted))
        assertEquals(exhausted.leaftailShop, restored.leaftailShop)
        for (offer in selected) failure("ECONOMY_LEAFTAIL_STOCK") { EconomyRules.apply(restored, command(offer.id, price = offer.priceCoins), now) }
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

    @Test fun `ordinary supplies buy exactly one fixed bundle at twice catalog value without opening collections`() {
        val supplies = spec.offers.filter { it.itemId in setOf("wood", "stone", "fiber") }
        assertEquals(mapOf("wood" to 10L, "stone" to 10L, "fiber" to 5L), supplies.associate { it.itemId to it.quantity })
        assertEquals(mapOf("wood" to 600L, "stone" to 800L, "fiber" to 100L), supplies.associate { it.itemId to it.priceCoins })
        var current = ready()
        val original = current
        for (offer in supplies) {
            val item = EconomyRules.catalog.items.first { it.id == offer.itemId }
            assertEquals(2L * item.baseSellPrice * offer.quantity, offer.priceCoins)
            current = EconomyRules.apply(current, command(offer.id, price = offer.priceCoins), now).first
            assertEquals(offer.quantity, current.inventory[offer.itemId])
            assertEquals(1, current.leaftailShop.purchased[offer.id])
            failure("ECONOMY_LEAFTAIL_STOCK") { EconomyRules.apply(current, command(offer.id, price = offer.priceCoins), now) }
            failure("INVALID_ECONOMY_COMMAND") {
                EconomyRules.apply(original, command(offer.id, price = offer.priceCoins, quantity = offer.quantity), now)
            }
        }
        assertEquals(original.wallet.coins - 1500L, current.wallet.coins)
        assertEquals(original.wallet.pearls, current.wallet.pearls)
        assertEquals(original.progression, current.progression)
        val midnight = Instant.parse("2026-10-17T00:00:00Z")
        val fiber = supplies.first { it.itemId == "fiber" }
        val next = EconomyRules.apply(current, command(fiber.id, at = midnight, price = fiber.priceCoins), midnight).first
        assertEquals(10L, next.inventory["fiber"])
    }

    @Test fun `bundle capacity validates full grant including escrow and item caps before consuming coins or stock`() {
        val initial = ready()
        val stone = spec.offers.first { it.itemId == "stone" }
        val capacity = EconomyRules.storage(initial).capacity
        val buyStone = command(stone.id, price = stone.priceCoins)
        failure("ECONOMY_STORAGE_FULL") {
            EconomyRules.apply(initial.copy(inventory = mapOf("wood" to capacity - stone.quantity + 1)), buyStone, now)
        }
        failure("ECONOMY_STORAGE_FULL") {
            EconomyRules.apply(initial.copy(inventory = mapOf("wood" to capacity - stone.quantity)), buyStone, now, mapOf("fiber" to 1L))
        }
        failure("ECONOMY_CAPACITY") {
            EconomyRules.apply(initial.copy(inventory = mapOf("stone" to ECONOMY_MAX_ITEMS - stone.quantity + 1)), buyStone, now)
        }
        val fits = EconomyRules.apply(initial.copy(inventory = mapOf("wood" to capacity - stone.quantity)), buyStone, now).first
        assertEquals(0L, EconomyRules.storage(fits).available)
        assertEquals(stone.quantity, fits.inventory["stone"])
        assertEquals(EconomyLeaftailShopState(), initial.leaftailShop)
    }

    @Test fun `old offer JSON defaults to one item and bundle quantity is bounded`() {
        val old = economyJson.decodeFromString<EconomyLeaftailOffer>(
            """{"id":"living_resin","itemId":"living_resin","priceCoins":2400,"stock":1}""")
        assertEquals(1L, old.quantity)
        for (quantity in listOf(0L, 101L)) assertFailsWith<IllegalArgumentException> {
            EconomyLeaftailOffer("wood_bundle", "wood", 600, quantity = quantity)
        }
    }

    @Test fun `clock rollback cannot replenish a consumed delivery`() {
        val bought = EconomyRules.apply(ready(), command(), now).first
        assertEquals(bought.leaftailShop, EconomyLeaftailShops.normalized(bought.leaftailShop, now.minusSeconds(86400), spec))
        failure("ECONOMY_LEAFTAIL_STOCK") {
            EconomyRules.apply(bought, command(), now.minusSeconds(86400))
        }
    }
}
