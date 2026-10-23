package ru.zhiv.economy

import kotlinx.serialization.encodeToString
import org.junit.jupiter.api.Test
import ru.zhiv.auth.AuthFailure
import ru.zhiv.world.WorldEquipment
import java.time.Instant
import java.util.UUID
import kotlin.test.*

class NeighborRulesTest {
    private val settings get() = NeighborRules.defaults

    @Test fun `shipped neighbor is a developed world character with bounded support rather than unlimited market liquidity`() {
        val config = NeighborRules.validate(settings)
        assertEquals("Берест", config.name)
        assertEquals(3, config.buildings["home"])
        assertEquals(3, config.offerSlots)
        assertEquals(1L, config.offerQuantity.toLong())
        assertEquals(180L, config.firstDelaySeconds.toLong())
        assertEquals(21600L, config.staleAfterSeconds.toLong())
        assertEquals(2, config.maxLotsPerDay)
        assertEquals(300L, config.dailyBudgetCoins)
        assertEquals(150L, config.maxLotCoins)
        assertEquals(10000L, config.globalDailyBudgetCoins)
        assertTrue(config.allowedItemIds.all { id -> EconomyRules.catalog.items.any { it.id == id && it.tradable } })
    }

    @Test fun `managed settings reject unsafe prices budgets schedule quantities and unrecognised world content`() {
        val invalid = listOf(
            settings.copy(offerSlots = 0), settings.copy(offerSlots = 4),
            settings.copy(offerQuantity = 0), settings.copy(offerQuantity = 6),
            settings.copy(maxLotsPerDay = -1), settings.copy(maxLotsPerDay = 3),
            settings.copy(dailyBudgetCoins = -1), settings.copy(dailyBudgetCoins = 301),
            settings.copy(maxLotCoins = -1), settings.copy(maxLotCoins = 151),
            settings.copy(globalDailyBudgetCoins = -1), settings.copy(globalDailyBudgetCoins = 10001),
            settings.copy(dailyBudgetCoins = 100, maxLotCoins = 150),
            settings.copy(buyPriceBps = 4999), settings.copy(buyPriceBps = 10001),
            settings.copy(sellPriceBps = 9999), settings.copy(sellPriceBps = 20001),
            settings.copy(firstDelaySeconds = 179), settings.copy(firstDelaySeconds = 86401),
            settings.copy(staleAfterSeconds = 21599), settings.copy(staleAfterSeconds = 604801),
            settings.copy(activeFromHourUtc = -1), settings.copy(activeFromHourUtc = 24),
            settings.copy(activeUntilHourUtc = 0), settings.copy(activeUntilHourUtc = 25),
            settings.copy(activeFromHourUtc = 12, activeUntilHourUtc = 12),
            settings.copy(name = ""), settings.copy(name = "x".repeat(41)), settings.copy(name = "Лес\u0000"),
            settings.copy(description = "x".repeat(241)), settings.copy(description = "Лес\u0000"),
            settings.copy(buildings = settings.buildings + ("unknown_building" to 1)),
            settings.copy(buildings = settings.buildings + ("home" to 6)),
            settings.copy(buildings = settings.buildings + ("home" to 1)),
            settings.copy(buildings = settings.buildings + ("bridge" to 0)),
            settings.copy(buildings = settings.buildings + ("quarry" to -1)),
            settings.copy(equipment = WorldEquipment(palette = "missing_palette")),
            settings.copy(equipment = WorldEquipment(head = "amber_scarf")),
            settings.copy(equipment = WorldEquipment(neck = "leaf_cap")),
            settings.copy(allowedItemIds = listOf("unknown_item")),
            settings.copy(allowedItemIds = listOf("ancient_core")),
        )
        for (value in invalid) assertFailsWith<AuthFailure>(value.toString()) { NeighborRules.validate(value) }
        NeighborRules.validate(settings.copy(enabled = false, autoBuyEnabled = false, maxLotsPerDay = 0,
            dailyBudgetCoins = 0, maxLotCoins = 0, globalDailyBudgetCoins = 0))
    }

    @Test fun `whole lot prices use one ceil ten step and never permit profitable resell to the neighbor`() {
        assertEquals(20L, NeighborRules.sellPrice(10, 1, settings))
        assertEquals(30L, NeighborRules.sellPrice(10, 2, settings))
        assertEquals(70L, NeighborRules.sellPrice(55, 1, settings))
        assertEquals(140L, NeighborRules.sellPrice(55, 2, settings))
        assertEquals(10L, NeighborRules.buyCap(10, 1, settings))
        assertEquals(50L, NeighborRules.buyCap(55, 1, settings))
        assertEquals(110L, NeighborRules.buyCap(55, 2, settings))
        val nominal = settings.copy(sellPriceBps = 10000)
        assertEquals(50L, NeighborRules.buyCap(55, 1, nominal),
            "Rounding a buyback upward would let a player split a two-item 110 coin purchase into profitable 60 coin sales")
        for (config in listOf(settings, settings.copy(sellPriceBps = 10000, buyPriceBps = 10000),
            settings.copy(sellPriceBps = 20000, buyPriceBps = 5000))) {
            NeighborRules.validate(config)
            for (item in EconomyRules.catalog.items.filter { it.tradable && it.baseSellPrice > 0 }) {
                for (quantity in 1L..5L) {
                    val buy = NeighborRules.buyCap(item.baseSellPrice, quantity, config)
                    val purchase = NeighborRules.sellPrice(item.baseSellPrice, quantity, config)
                    assertTrue(buy <= purchase, "${item.id}: no gross buyback profit on a whole purchased lot")
                    assertTrue(buy - EconomyMarketRules.sellerFee(buy, 500) <= purchase,
                        "${item.id}: normal seller fee cannot create a profit")
                    assertEquals(0L, purchase % 10)
                }
            }
        }
    }

    @Test fun `UTC schedule is inclusive at opening exclusive at closing and respects global disable`() {
        val opening = Instant.parse("2026-10-23T08:00:00Z")
        val config = settings.copy(activeFromHourUtc = 8, activeUntilHourUtc = 20)
        assertFalse(NeighborRules.active(opening.minusSeconds(1), config))
        assertTrue(NeighborRules.active(opening, config))
        assertTrue(NeighborRules.active(Instant.parse("2026-10-23T19:59:59Z"), config))
        assertFalse(NeighborRules.active(Instant.parse("2026-10-23T20:00:00Z"), config))
        assertFalse(NeighborRules.active(opening, config.copy(enabled = false)))
        assertTrue(NeighborRules.active(Instant.parse("2026-10-23T23:59:59Z"), settings))
        assertTrue(NeighborRules.active(Instant.parse("2026-10-24T00:00:00Z"), settings))
        val overnight = settings.copy(activeFromHourUtc = 20, activeUntilHourUtc = 8)
        NeighborRules.validate(overnight)
        assertTrue(NeighborRules.active(Instant.parse("2026-10-23T20:00:00Z"), overnight))
        assertTrue(NeighborRules.active(Instant.parse("2026-10-24T07:59:59Z"), overnight))
        assertFalse(NeighborRules.active(Instant.parse("2026-10-24T08:00:00Z"), overnight))
        assertFalse(NeighborRules.active(Instant.parse("2026-10-23T19:59:59Z"), overnight))
    }

    @Test fun `personal offers require permanent discoveries and never teach a gifted late item`() {
        val initial = EconomyRules.initial().copy(inventory = mapOf("ore" to 1L, "tools" to 1L))
        val broad = settings.copy(allowedItemIds = listOf("berries", "wood", "ore", "tools"))
        NeighborRules.validate(broad)
        val before = economyJson.encodeToString(initial)
        val known = NeighborRules.eligibleItems(initial, broad).map { it.id }
        assertTrue("berries" in known)
        assertFalse("ore" in known)
        assertFalse("tools" in known)
        assertEquals(before, economyJson.encodeToString(initial), "Offer projection cannot mutate progress")
        val remembered = initial.copy(unlockedItems = listOf("ore"), inventory = emptyMap())
        assertTrue("ore" in NeighborRules.eligibleItems(remembered, broad).map { it.id })
        assertFalse("ore" in NeighborRules.eligibleItems(remembered, broad.copy(allowedItemIds = listOf("wood"))).map { it.id })
    }

    @Test fun `neighbor purchase accepts only a bounded full lot with an explicit quote and canonical target`() {
        val command = EconomyCommand(UUID.randomUUID().toString(), "ABCD-EFGH-JKMP", 0,
            "buy_offer", UUID.randomUUID().toString(), quantity = 1, totalPrice = 20)
        NeighborRules.validatePurchase(command)
        for (bad in listOf(command.copy(requestId = "bad"), command.copy(ownerPublicId = ""),
            command.copy(action = "buy_listing"), command.copy(targetId = "berries"),
            command.copy(quantity = 0), command.copy(quantity = 6), command.copy(totalPrice = 0),
            command.copy(totalPrice = ECONOMY_MAX_BALANCE + 1), command.copy(expectedRevision = -1),
            command.copy(fishSelection = mapOf("fish_carp" to 1)))) {
            assertFailsWith<AuthFailure>(bad.toString()) { NeighborRules.validatePurchase(bad) }
        }
    }
}
