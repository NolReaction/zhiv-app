package ru.zhiv.economy

import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.JsonObject
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
    private fun ready(home: Int = 3) = EconomyRules.initial(homeLevel = home).copy(inventory = emptyMap(), wallet = EconomyWallet(1_000_000, 10_000))
    private fun offers(at: Instant = now, home: Int = 3, identity: String = owner) =
        EconomyLeaftailShops.offers(EconomyRules.catalog, EconomyLeaftailShops.cycle(at, spec), identity, home)
    private fun finds(at: Instant = now) = offers(at).filter { it.currency == "pearls" }
    private fun command(offer: EconomyLeaftailShops.DailyOffer = finds().first(), at: Instant = now, quantity: Long = 1, price: Long = offer.unitPrice * quantity) =
        EconomyCommand(UUID.randomUUID().toString(), owner, 0, "buy_leaftail_item",
            EconomyLeaftailShops.targetId(spec, EconomyLeaftailShops.cycle(at, spec), offer.id), quantity, price)
    private fun failure(code: String, block: () -> Unit) = assertEquals(code, assertFailsWith<AuthFailure>(block = block).code)

    @Test fun `daily relics cost exactly 150 visible pearls and do not spend coins or advance free collection clocks`() {
        assertEquals(13, EconomyRules.catalog.version)
        assertEquals(3, spec.requiredHomeLevel)
        assertEquals(86400L, spec.refreshSeconds)
        assertEquals(setOf("ancient_core", "moon_crystal", "living_resin"), spec.pearlOffers.map { it.itemId }.toSet())
        assertTrue(spec.pearlOffers.all { it.stock == 1 && it.pricePearls == 300L })
        val delivered = finds()
        assertTrue(delivered.size in 1..2)
        var current = ready()
        val original = current
        for (offer in delivered) {
            current = EconomyRules.apply(current, command(offer), now).first
            assertEquals(1L, current.inventory[offer.itemId])
            failure("ECONOMY_LEAFTAIL_STOCK") { EconomyRules.apply(current, command(offer), now) }
        }
        assertEquals(original.wallet.coins, current.wallet.coins)
        assertEquals(original.wallet.pearls - 300L * delivered.size, current.wallet.pearls)
        assertEquals(delivered.associate { it.id to 1 }, current.leaftailShop.purchased)
        assertEquals(original.progression, current.progression)
        assertEquals(original.completedExplorations, current.completedExplorations)
        assertEquals(original.rareDropState, current.rareDropState)
        assertEquals(original.minerRareDropState, current.minerRareDropState)
        assertEquals(original.fishing, current.fishing)
    }

    @Test fun `new catalog rejects legacy coin targets even if their quoted amount matches the pearl price`() {
        val state = ready()
        val buy = command()
        failure("ECONOMY_LEAFTAIL_SHOP_CHANGED") { EconomyRules.apply(state, buy.copy(targetId = buy.targetId.removePrefix("v2:")), now) }
        failure("ECONOMY_LEAFTAIL_SHOP_CHANGED") { EconomyRules.apply(state, buy.copy(targetId = "v2:${EconomyLeaftailShops.cycle(now, spec)}:ancient_core"), now) }
        failure("ECONOMY_LEAFTAIL_PRICE_CHANGED") { EconomyRules.apply(state, buy.copy(totalPrice = 2400), now) }
        failure("ECONOMY_PEARLS") { EconomyRules.apply(state.copy(wallet = EconomyWallet(1_000_000, 299)), buy, now) }
        failure("ECONOMY_LEAFTAIL_PRICE_CHANGED") { EconomyRules.apply(state, buy.copy(totalPrice = 150), now) }
        assertEquals(ready(), state)
    }

    @Test fun `missing personal relic is rejected without mutating balance inventory or stock`() {
        val state = ready()
        val selected = finds().map { it.id }.toSet()
        val absent = spec.pearlOffers.first { it.id !in selected }
        failure("ECONOMY_LEAFTAIL_SHOP_CHANGED") {
            EconomyRules.apply(state, command().copy(targetId = EconomyLeaftailShops.targetId(spec, EconomyLeaftailShops.cycle(now, spec), absent.id)), now)
        }
        assertEquals(ready(), state)
    }

    @Test fun `server cycle exact prices home gate and singular relic quantity fail before spending`() {
        val state = ready()
        failure("ECONOMY_HOME_REQUIRED") { EconomyRules.apply(ready(2), command(), now) }
        failure("ECONOMY_LEAFTAIL_SHOP_CHANGED") { EconomyRules.apply(state, command(at = now.minusSeconds(86400)), now) }
        for (price in listOf(0L, 299L, 301L)) failure("ECONOMY_LEAFTAIL_PRICE_CHANGED") { EconomyRules.apply(state, command(price = price), now) }
        for (quantity in listOf(0L, 2L, 21L)) failure("INVALID_ECONOMY_COMMAND") { EconomyRules.apply(state, command(quantity = quantity), now) }
        assertEquals(EconomyLeaftailShopState(), state.leaftailShop)
    }

    @Test fun `UTC midnight changes target but keeps accepted inventory and does not accept yesterday quote`() {
        val midnight = Instant.parse("2026-10-17T00:00:00Z")
        val last = midnight.minusNanos(1)
        val request = command(finds(last).first(), last)
        val bought = EconomyRules.apply(ready(), request, last).first
        failure("ECONOMY_LEAFTAIL_SHOP_CHANGED") { EconomyRules.apply(bought, request, midnight) }
        val nextOffer = finds(midnight).first()
        val next = EconomyRules.apply(bought, command(nextOffer, midnight), midnight).first
        assertEquals((bought.inventory[nextOffer.itemId] ?: 0L) + 1, next.inventory[nextOffer.itemId])
        assertEquals(bought.wallet.pearls - 300, next.wallet.pearls)
        assertEquals(bought.wallet.coins, next.wallet.coins)
        assertEquals(bought.leaftailShop.cycle + 1, next.leaftailShop.cycle)
        assertEquals(mapOf(nextOffer.id to 1), next.leaftailShop.purchased)
    }

    @Test fun `relic storage cap and escrow are validated atomically before pearl debit or consuming daily stock`() {
        val state = ready()
        val capacity = EconomyRules.storage(state).capacity
        failure("ECONOMY_STORAGE_FULL") { EconomyRules.apply(state.copy(inventory = mapOf("wood" to capacity)), command(), now) }
        failure("ECONOMY_STORAGE_FULL") { EconomyRules.apply(state.copy(inventory = mapOf("wood" to capacity - 1)), command(), now, mapOf("stone" to 1L)) }
        val itemId = finds().first().itemId
        failure("ECONOMY_CAPACITY") { EconomyRules.apply(state.copy(inventory = mapOf(itemId to ECONOMY_MAX_ITEMS)), command(), now) }
        failure("ECONOMY_CAPACITY") { EconomyRules.apply(state.copy(inventory = mapOf(itemId to ECONOMY_MAX_ITEMS - 1)), command(), now, mapOf(itemId to 1L)) }
        assertEquals(ready(), state)
    }

    @Test fun `supplies buy selected individual quantities across multiple purchases and consume unit stock`() {
        val supply = offers().first { it.kind == "item" && it.currency == "coins" && it.stock >= 10 }
        assertEquals(1L, supply.quantity)
        val initial = ready()
        val first = EconomyRules.apply(initial, command(supply, quantity = 3), now).first
        val next = EconomyRules.apply(first, command(supply, quantity = 4), now).first
        assertEquals(7L, next.inventory[supply.itemId])
        assertEquals(7, next.leaftailShop.purchased[supply.id])
        assertEquals(initial.wallet.coins - 7 * supply.unitPrice, next.wallet.coins)
        assertEquals(initial.wallet.pearls, next.wallet.pearls)
        assertEquals(initial.progression, next.progression)
        val remaining = supply.stock - 7L
        val exhausted = EconomyRules.apply(next, command(supply, quantity = remaining), now).first
        assertEquals(supply.stock.toLong(), exhausted.inventory[supply.itemId])
        failure("ECONOMY_LEAFTAIL_STOCK") { EconomyRules.apply(exhausted, command(supply), now) }
        failure("INVALID_ECONOMY_COMMAND") { EconomyRules.apply(initial, command(supply, quantity = 21), now) }
    }

    @Test fun `supply quote remaining stock funds and full selected capacity reject without partial purchases`() {
        val offer = offers().first { it.kind == "item" && it.currency == "coins" && it.stock >= 10 }
        val state = ready()
        val buy = command(offer, quantity = 4)
        val capacity = EconomyRules.storage(state).capacity
        failure("ECONOMY_LEAFTAIL_PRICE_CHANGED") { EconomyRules.apply(state, buy.copy(totalPrice = offer.unitPrice), now) }
        failure("ECONOMY_RESOURCES") { EconomyRules.apply(state.copy(wallet = state.wallet.copy(coins = buy.totalPrice - 1)), buy, now) }
        failure("ECONOMY_STORAGE_FULL") { EconomyRules.apply(state.copy(inventory = mapOf("wood" to capacity - 3)), buy, now) }
        failure("ECONOMY_STORAGE_FULL") { EconomyRules.apply(state.copy(inventory = mapOf("wood" to capacity - 4)), buy, now, mapOf("fiber" to 1L)) }
        failure("ECONOMY_CAPACITY") { EconomyRules.apply(state.copy(inventory = mapOf(offer.itemId to ECONOMY_MAX_ITEMS - 3)), buy, now) }
        val bought = EconomyRules.apply(state, command(offer, quantity = offer.stock - 1L), now).first
        failure("ECONOMY_LEAFTAIL_STOCK") { EconomyRules.apply(bought, command(offer, quantity = 2), now) }
        assertEquals(ready(), state)
    }

    @Test fun `legacy saved counters decode and higher unit counters survive roundtrip`() {
        val initial = ready()
        val legacy = economyJson.parseToJsonElement(economyJson.encodeToString(initial)).jsonObject.filterKeys { it != "leaftailShop" }
        assertEquals(EconomyLeaftailShopState(), economyJson.decodeFromString<EconomyState>(JsonObject(legacy).toString()).leaftailShop)
        val offer = offers().first { it.kind == "item" && it.currency == "coins" && it.stock >= 10 }
        val bought = EconomyRules.apply(initial, command(offer, quantity = 10), now).first
        val restored = economyJson.decodeFromString<EconomyState>(economyJson.encodeToString(bought))
        assertEquals(bought.leaftailShop, restored.leaftailShop)
        assertEquals(10, restored.leaftailShop.purchased[offer.id])
        assertEquals(EconomyLeaftailShopState(20742, mapOf("wood_bundle" to 1)), economyJson.decodeFromString<EconomyLeaftailShopState>("""{"cycle":20742,"purchased":{"wood_bundle":1}}"""))
        assertFailsWith<IllegalArgumentException> { EconomyLeaftailShopState(20742, mapOf("wood_each" to 101)) }
    }

    @Test fun `account merge sums consumed unit stock and caps it without reopening older cycles`() {
        val cycle = EconomyLeaftailShops.cycle(now, spec)
        val first = EconomyLeaftailShopState(cycle, mapOf("wood_each" to 8, "living_resin_pearl" to 1))
        val second = EconomyLeaftailShopState(cycle, mapOf("wood_each" to 8, "moon_crystal_pearl" to 1))
        val merged = EconomyLeaftailShops.merge(first, second)
        assertEquals(16, merged.purchased["wood_each"])
        assertEquals(merged, EconomyLeaftailShops.merge(second, first))
        assertEquals(100, EconomyLeaftailShops.merge(first.copy(purchased = mapOf("wood_each" to 80)), second.copy(purchased = mapOf("wood_each" to 80))).purchased["wood_each"])
        assertEquals(2, EconomyLeaftailShops.merge(first.copy(purchased = mapOf("old_bundle" to 1)), second.copy(purchased = mapOf("old_bundle" to 1))).purchased["old_bundle"])
        val newer = EconomyLeaftailShopState(cycle + 1, mapOf("wood_each" to 3))
        assertEquals(newer, EconomyLeaftailShops.merge(first, newer))
        assertEquals(newer, EconomyLeaftailShops.merge(newer, first))
    }

    @Test fun `clock rollback cannot replenish a consumed delivery`() {
        val request = command()
        val bought = EconomyRules.apply(ready(), request, now).first
        assertEquals(bought.leaftailShop, EconomyLeaftailShops.normalized(bought.leaftailShop, now.minusSeconds(86400), spec))
        failure("ECONOMY_LEAFTAIL_STOCK") { EconomyRules.apply(bought, request, now.minusSeconds(86400)) }
    }
}
