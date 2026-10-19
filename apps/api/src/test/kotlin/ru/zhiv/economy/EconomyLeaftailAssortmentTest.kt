package ru.zhiv.economy

import kotlinx.serialization.encodeToString
import org.junit.jupiter.api.Test
import ru.zhiv.auth.AuthFailure
import java.time.Instant
import java.util.UUID
import kotlin.test.*

class EconomyLeaftailAssortmentTest {
    private val now = Instant.parse("2026-10-18T17:00:00Z")
    private val owner = "ABCD-EFGH-JKMP"
    private val spec get() = checkNotNull(EconomyRules.catalog.leaftailShop)
    private fun ready(home: Int = 3) = EconomyRules.initial(homeLevel = home).copy(inventory = emptyMap(), wallet = EconomyWallet(1_000_000, 10_000))
    private fun offers(home: Int = 3, at: Instant = now, identity: String = owner) =
        EconomyLeaftailShops.offers(EconomyRules.catalog, EconomyLeaftailShops.cycle(at, spec), identity, home)
    private fun command(offer: EconomyLeaftailShops.DailyOffer, at: Instant = now, quantity: Long = 1) = EconomyCommand(UUID.randomUUID().toString(),
        owner, 0, "buy_leaftail_item", EconomyLeaftailShops.targetId(spec, EconomyLeaftailShops.cycle(at, spec), offer.id), quantity, offer.unitPrice * quantity)
    private fun failure(code: String, block: () -> Unit) = assertEquals(code, assertFailsWith<AuthFailure>(block = block).code)

    @Test fun `catalog preserves legacy readers while normalizing supplies and bait into exactly priced units`() {
        assertEquals(spec, economyJson.decodeFromString<EconomyLeaftailShopConfig>(economyJson.encodeToString(spec)))
        assertEquals(3, spec.offers.size)
        assertEquals(8, spec.supplyOffers.size)
        assertEquals(3, spec.pearlOffers.size)
        assertFailsWith<IllegalArgumentException> { spec.pearlOffers.first().copy(pricePearls = ECONOMY_MAX_BALANCE + 1) }
        assertTrue(EconomyLeaftailShops.validCatalog(EconomyRules.catalog, spec))
        val old = economyJson.decodeFromString<EconomyLeaftailOffer>("""{"id":"living_resin","itemId":"living_resin","priceCoins":2400,"stock":1}""")
        assertEquals(1L, old.quantity)
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
        val supply = spec.supplyOffers.first()
        assertFalse(EconomyLeaftailShops.validCatalog(EconomyRules.catalog, spec.copy(supplyOffers = listOf(supply.copy(unitPriceCoins = 1)))))
        assertFalse(EconomyLeaftailShops.validCatalog(EconomyRules.catalog, spec.copy(supplyOffers = listOf(supply.copy(itemId = "fish_common")))))
        assertFalse(EconomyLeaftailShops.validCatalog(EconomyRules.catalog, spec.copy(pearlOffers = listOf(spec.pearlOffers.first().copy(itemId = "berries")))))
    }

    @Test fun `personal section rings rotate every day and never show the complete gear catalog`() {
        fun counts(shelf: List<EconomyLeaftailShops.DailyOffer>): Map<String, Int> = shelf.groupingBy {
            if (it.currency == "pearls") "finds" else if (it.kind == "item") "supplies" else it.kind
        }.eachCount()
        val initial = offers(4)
        assertEquals(mapOf("wardrobe" to 2, "rod" to 1, "hook" to 1, "bait" to 1, "supplies" to 3), counts(initial).filterKeys { it != "finds" })
        assertTrue(counts(initial).getValue("finds") in 1..2)
        assertEquals(initial, offers(4))
        assertTrue(offers(4, identity = "").isEmpty())
        val days = (0..31).map { offers(4, now.plusSeconds(86400L * it)) }
        for (kind in listOf("wardrobe", "rod", "hook", "bait")) {
            val expected = spec.travelOffers.filter { it.kind == kind && it.requiredHomeLevel <= 4 }.map { it.id }.toSet()
            assertEquals(expected, days.flatten().filter { it.kind == kind }.map { it.id }.toSet())
        }
        assertEquals(spec.supplyOffers.map { it.id }.toSet(), days.flatten().filter { it.kind == "item" && it.currency == "coins" }.map { it.id }.toSet())
        assertTrue(days.zipWithNext().all { (a, b) -> a.filter { it.kind == "rod" }.map { it.id } != b.filter { it.kind == "rod" }.map { it.id } })
        assertTrue((0..30).any { offers(4, identity = "Друзья-$it") != initial })
        assertTrue(offers(2).isEmpty())
        assertTrue(offers(3).all { it.requiredHomeLevel <= 3 })
    }

    @Test fun `daily ring vectors match browser including Cyrillic identity and maximum safe cycle`() {
        data class Vector(val identity: String, val cycle: Long, val home: Int, val expected: List<String>)
        val vectors = listOf(
            Vector("AAAA-0000-0001", 20742, 3, listOf("rain_hood", "dune_moss", "traveller_rod", "spice_bait", "moth_hook", "fiber_each", "planks_each", "grilled_fish_each", "moon_crystal_pearl")),
            Vector("AAAA-0000-0001", 20743, 3, listOf("trail_hat", "sunset_scarf", "spice_bait", "mirror_rod", "weedless_hook", "wood_each", "stone_each", "dried_berries_each", "ancient_core_pearl")),
            Vector("Мохлик", 20743, 4, listOf("sunset_scarf", "dune_moss", "traveller_rod", "spice_bait", "weedless_hook", "planks_each", "rope_each", "charcoal_each", "moon_crystal_pearl")),
            Vector(owner, ECONOMY_MAX_REVISION, 5, listOf("trail_hat", "storm_moss", "spice_bait", "mirror_rod", "spoon_hook", "wood_each", "stone_each", "grilled_fish_each", "ancient_core_pearl")),
        )
        for (v in vectors) assertEquals(v.expected, EconomyLeaftailShops.offers(EconomyRules.catalog, v.cycle, v.identity, v.home).map { it.id })
    }

    @Test fun `permanent clothes use no pantry places and remain on their fixed daily shelf after purchase`() {
        var state = ready().let { it.copy(inventory = mapOf("wood" to EconomyRules.storage(it).capacity)) }
        val initial = state
        val shelf = offers()
        val offer = shelf.first { it.kind == "wardrobe" }
        val next = EconomyRules.apply(state, command(offer), now).first
        assertTrue(offer.itemId in next.wardrobe)
        assertEquals(state.wardrobe.size + 1, next.wardrobe.size)
        assertEquals(initial.inventory, next.inventory)
        assertEquals(initial.fishing, next.fishing)
        assertEquals(state.wallet.coins - offer.unitPrice, next.wallet.coins)
        assertEquals(state.wallet.pearls, next.wallet.pearls)
        assertEquals(shelf, offers(), "Owned items must not cause a replacement roll")
        failure("ECONOMY_LEAFTAIL_STOCK") { EconomyRules.apply(next, command(offer), now) }
        val returnDay = (1..20).map { now.plusSeconds(it * 86400L) }.first { day -> offers(at = day).any { it.id == offer.id } }
        failure("ECONOMY_WARDROBE_OWNED") { EconomyRules.apply(next, command(offer, returnDay), returnDay) }
        for (prefix in listOf("", "coins:", "pearls:")) failure("ECONOMY_WARDROBE_ITEM") {
            EconomyRules.apply(state, command(offer).copy(action = "buy_wardrobe_item", targetId = "$prefix${offer.itemId}"), now)
        }
    }

    @Test fun `rotating rods and hooks are permanent do not autoequip and need no pantry capacity`() {
        val state = ready(4).let { it.copy(inventory = mapOf("wood" to EconomyRules.storage(it).capacity)) }
        for (offer in offers(4).filter { it.kind in setOf("rod", "hook") }) {
            val next = EconomyRules.apply(state, command(offer), now, mapOf("fiber" to 1L)).first
            if (offer.kind == "rod") assertEquals(state.fishing.ownedRods + offer.itemId, next.fishing.ownedRods)
            else assertEquals(state.fishing.ownedHooks + offer.itemId, next.fishing.ownedHooks)
            assertEquals(state.inventory, next.inventory)
            assertEquals(state.fishing.equippedRodId, next.fishing.equippedRodId)
            assertEquals(state.fishing.equippedHookId, next.fishing.equippedHookId)
            assertEquals(state.fishing.equippedBaitId, next.fishing.equippedBaitId)
            failure("INVALID_ECONOMY_COMMAND") { EconomyRules.apply(state, command(offer, quantity = 2), now) }
            val returnDay = (1..20).map { now.plusSeconds(it * 86400L) }.first { day -> offers(4, day).any { it.id == offer.id } }
            failure("ECONOMY_FISHING_OWNED") { EconomyRules.apply(next, command(offer, returnDay), returnDay) }
        }
    }

    @Test fun `bait can be bought one or several at exact unit price with full capacity and stock checks`() {
        val offer = offers(4).first { it.kind == "bait" }
        val state = ready(4)
        assertEquals(1L, offer.quantity)
        assertEquals(5, offer.stock)
        val raw = spec.travelOffers.first { it.id == offer.id }
        assertEquals(raw.priceCoins, offer.unitPrice * 5)
        val capacity = EconomyRules.storage(state).capacity
        failure("ECONOMY_STORAGE_FULL") { EconomyRules.apply(state.copy(inventory = mapOf("wood" to capacity - 2)), command(offer, quantity = 3), now) }
        failure("ECONOMY_STORAGE_FULL") { EconomyRules.apply(state.copy(inventory = mapOf("wood" to capacity - 3)), command(offer, quantity = 3), now, mapOf("fiber" to 1L)) }
        failure("ECONOMY_CAPACITY") { EconomyRules.apply(state.copy(inventory = mapOf(offer.itemId to ECONOMY_MAX_ITEMS - 2)), command(offer, quantity = 3), now) }
        val one = EconomyRules.apply(state, command(offer), now).first
        val five = EconomyRules.apply(one, command(offer, quantity = 4), now).first
        assertEquals(5L, five.inventory[offer.itemId])
        assertEquals(state.wallet.coins - raw.priceCoins, five.wallet.coins)
        assertEquals(state.fishing, five.fishing)
        failure("ECONOMY_LEAFTAIL_STOCK") { EconomyRules.apply(five, command(offer), now) }
    }

    @Test fun `old catalog remains fixed bundle and retains its old personal relic vectors`() {
        val legacy = spec.copy(supplyOffers = emptyList(), pearlOffers = emptyList(), offers = spec.offers + listOf(
            EconomyLeaftailOffer("ancient_core", "ancient_core", 2400), EconomyLeaftailOffer("moon_crystal", "moon_crystal", 2400), EconomyLeaftailOffer("living_resin", "living_resin", 2400)))
        val catalog = EconomyRules.catalog.copy(version = 11, leaftailShop = legacy)
        assertTrue(EconomyLeaftailShops.validCatalog(catalog, legacy))
        val shelf = EconomyLeaftailShops.offers(catalog, 20742, "AAAA-0000-0001")
        assertEquals(listOf("ancient_core", "living_resin"), shelf.filter { it.itemId in setOf("ancient_core", "moon_crystal", "living_resin") }.map { it.id })
        val wood = shelf.first { it.itemId == "wood" }
        assertEquals(10L, wood.quantity)
        assertEquals(600L, wood.unitPrice)
        assertEquals(1, wood.stock)
        assertEquals("20742:wood_bundle", EconomyLeaftailShops.targetId(legacy, 20742, wood.id))
        val old = economyJson.decodeFromString<EconomyLeaftailShopConfig>(economyJson.encodeToString(legacy))
        assertTrue(old.supplyOffers.isEmpty() && old.pearlOffers.isEmpty())
    }

    @Test fun `Pleska generation and forged saved offers reject exclusive caravan tackle`() {
        val state = ready(5)
        val fishing = checkNotNull(EconomyRules.catalog.fishing)
        val ids = (fishing.rods.filter { it.shop == "leaftail" }.map { it.id } +
            fishing.hooks.filter { it.shop == "leaftail" }.map { it.id } + fishing.baits.filter { it.shop == "leaftail" }.map { it.itemId }).toSet()
        repeat(80) { ticket -> assertTrue(EconomyFishingShops.create(state, now, { ticket % it }).offers.none { it.itemId in ids }) }
        for (offer in spec.travelOffers.filter { it.itemId in ids }) {
            val forged = EconomyFishingOffer("forged:${offer.itemId}", offer.kind, offer.itemId, 1, 5)
            val injected = state.copy(fishingShop = EconomyFishingShop(UUID.randomUUID().toString(), now.toString(), now.plusSeconds(21600).toString(), 100, listOf(forged)))
            val request = EconomyCommand(UUID.randomUUID().toString(), owner, 0, "buy_fishing_item", forged.id, 1, 1)
            failure("ECONOMY_FISHING_ITEM") { EconomyRules.apply(injected, request, now) }
            assertEquals(state.wallet, injected.wallet)
            assertEquals(state.fishing, injected.fishing)
        }
    }
}
