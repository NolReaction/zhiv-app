package ru.zhiv.economy

import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.encodeToJsonElement
import org.junit.jupiter.api.Test
import ru.zhiv.auth.AuthFailure
import ru.zhiv.world.WorldEquipment
import ru.zhiv.world.WorldRules
import java.time.Instant
import java.util.UUID
import kotlin.test.*

class NeighborRulesTest {
    private val settings get() = NeighborRules.defaults

    @Test fun `personal neighbor outfit is valid but never enters player clothing or reward catalogs`() {
        val outfit = settings.equipment
        assertEquals("berest_birch_moss", outfit.palette)
        assertEquals("berest_trail_hat", outfit.head)
        assertEquals("berest_lantern_scarf", outfit.neck)
        assertEquals(setOf("palette", "head", "neck"), NeighborRules.exclusiveWardrobe.map { it.slot }.toSet())
        NeighborRules.validate(settings)
        NeighborRules.validate(settings.copy(equipment = WorldEquipment(palette = "moss", head = "leaf_cap", neck = "amber_scarf")))
        for (item in NeighborRules.exclusiveWardrobe) {
            assertTrue(WorldRules.catalog.items.none { it.id == item.id }, "NPC things are not player wardrobe items")
            assertTrue(EconomyRules.catalog.items.none { it.id == item.id }, "NPC things are not economic items")
        }
        assertFailsWith<AuthFailure> { NeighborRules.validate(settings.copy(equipment = outfit.copy(head = outfit.neck))) }
        assertFailsWith<AuthFailure> { NeighborRules.validate(settings.copy(equipment = outfit.copy(rod = outfit.head))) }
    }

    @Test fun `shipped neighbor is a developed world character with bounded support rather than unlimited market liquidity`() {
        val config = NeighborRules.validate(settings)
        assertEquals("Берест", config.name)
        assertEquals(EconomyRules.catalog.buildings.single { it.id=="home" }.levels.maxOf { it.level }, config.buildings["home"])
        assertEquals(3L, config.offerSlots)
        assertEquals(1L, config.offerQuantity.toLong())
        assertEquals(180L, config.firstDelaySeconds.toLong())
        assertEquals(21600L, config.staleAfterSeconds.toLong())
        assertEquals(2L, config.maxLotsPerDay)
        assertEquals(10000L, config.dailyBudgetCoins)
        assertEquals(5000L, config.maxLotCoins)
        assertEquals(10000000L, config.globalDailyBudgetCoins)
        assertTrue(config.allowedItemIds.all { id -> EconomyRules.catalog.items.any { it.id == id && it.tradable } })
    }

    @Test fun `managed settings reject unsafe prices budgets schedule quantities and unrecognised world content`() {
        val invalid = listOf(
            settings.copy(offerSlots = -1), settings.copy(offerSlots = NeighborRules.MAX_SAFE_SETTING+1),
            settings.copy(offerQuantity = 0), settings.copy(offerQuantity = ECONOMY_MAX_ITEMS+1),
            settings.copy(maxLotsPerDay = -1), settings.copy(maxLotsPerDay = NeighborRules.MAX_SAFE_SETTING+1),
            settings.copy(dailyBudgetCoins = -1), settings.copy(dailyBudgetCoins = NeighborRules.MAX_SAFE_SETTING+1),
            settings.copy(maxLotCoins = -1), settings.copy(maxLotCoins = ECONOMY_MAX_BALANCE+1),
            settings.copy(globalDailyBudgetCoins = -1), settings.copy(globalDailyBudgetCoins = NeighborRules.MAX_SAFE_SETTING+1),
            settings.copy(buyPriceBps = -1), settings.copy(sellPriceBps = -1),
            settings.copy(firstDelaySeconds = -1), settings.copy(staleAfterSeconds = -1),
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
        assertEquals(30L, NeighborRules.sellPrice(10, 1, settings))
        assertEquals(50L, NeighborRules.sellPrice(10, 2, settings))
        assertEquals(130L, NeighborRules.sellPrice(55, 1, settings))
        assertEquals(250L, NeighborRules.sellPrice(55, 2, settings))
        assertEquals(20L, NeighborRules.buyCap(10, 1, settings))
        assertEquals(110L, NeighborRules.buyCap(55, 1, settings))
        assertEquals(220L, NeighborRules.buyCap(55, 2, settings))
        val nominal = settings.copy(sellPriceBps = 10000, buyPriceBps = 10000)
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

    @Test fun `default buybacks of every stock item cannot profit from any resident acquisition or split lot`() {
        assertEquals(20000L,settings.buyPriceBps)
        assertEquals(22500L,settings.sellPriceBps)
        assertEquals(60L,NeighborRules.itemBuyCap("wood",1,settings))
        assertEquals(10L,NeighborRules.itemBuyCap("crumb_bait",10,settings))
        assertEquals(10L,NeighborRules.itemBuyCap("crumb_bait",10,settings.copy(buyPriceBps=100000)))
        assertEquals(0L,NeighborRules.itemBuyCap("crumb_bait",5,settings))
        for (id in settings.allowedItemIds) {
            val item=EconomyRules.catalog.items.single { it.id==id }
            for(quantity in 1L..99L) {
                val cap=NeighborRules.itemBuyCap(id,quantity,settings)
                val proceeds=cap-EconomyMarketRules.sellerFee(cap,500)
                val stock=NeighborRules.sellPrice(item.baseSellPrice,quantity,settings)
                assertTrue(proceeds<stock,"$id × $quantity: neighbor resale")
                NeighborRules.cheapestUnitAcquisition(id)?.let { cost ->
                    assertTrue(proceeds<cost*quantity,"$id × $quantity: another resident resale")
                }
                assertTrue(quantity*NeighborRules.itemBuyCap(id,1,settings)<=stock,"$id: splitting cannot help")
            }
        }
    }

    @Test fun `administrator values are independent and use exact overflow safe prices`() {
        val large = settings.copy(offerSlots=50,offerQuantity=20,maxLotsPerDay=50,dailyBudgetCoins=100000,
            maxLotCoins=3000,globalDailyBudgetCoins=1000000,firstDelaySeconds=0,staleAfterSeconds=0,
            sellPriceBps=1000,buyPriceBps=50000)
        NeighborRules.validate(large)
        NeighborRules.validate(large.copy(maxLotCoins=3000,dailyBudgetCoins=300,offerSlots=0,allowedItemIds=emptyList()))
        assertEquals(30L,NeighborRules.sellPrice(30,10,large))
        assertEquals(1500L,NeighborRules.buyCap(30,10,large))
        assertEquals(0L,NeighborRules.sellPrice(30,10,large.copy(sellPriceBps=0)))
        val extreme=large.copy(sellPriceBps=NeighborRules.MAX_SAFE_SETTING,buyPriceBps=NeighborRules.MAX_SAFE_SETTING)
        assertEquals(ECONOMY_MAX_BALANCE+1,NeighborRules.sellPrice(1000000,ECONOMY_MAX_ITEMS,extreme))
        assertEquals(ECONOMY_MAX_BALANCE,NeighborRules.buyCap(1000000,ECONOMY_MAX_ITEMS,extreme))
        assertEquals(Instant.EPOCH,NeighborRules.candidateCutoff(Instant.parse("2026-10-25T10:00:00Z"),
            extreme.copy(firstDelaySeconds=NeighborRules.MAX_SAFE_SETTING,staleAfterSeconds=NeighborRules.MAX_SAFE_SETTING)))
        val command=EconomyCommand(UUID.randomUUID().toString(),"ABCD-EFGH-JKMP",0,"buy_offer",UUID.randomUUID().toString(),quantity=20000,totalPrice=0)
        assertEquals(command,decodeEconomyCommand(economyJson.encodeToJsonElement(command),NeighborRules::validatePurchase))
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
            command.copy(quantity = 0), command.copy(quantity = ECONOMY_MAX_ITEMS+1), command.copy(totalPrice = -1),
            command.copy(totalPrice = ECONOMY_MAX_BALANCE + 1), command.copy(expectedRevision = -1),
            command.copy(fishSelection = mapOf("fish_carp" to 1)))) {
            assertFailsWith<AuthFailure>(bad.toString()) { NeighborRules.validatePurchase(bad) }
        }
    }
}
