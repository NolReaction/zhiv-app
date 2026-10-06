package ru.zhiv.economy

import org.junit.jupiter.api.Test
import ru.zhiv.auth.AuthFailure
import java.util.UUID
import kotlin.test.*

class EconomyMarketRulesTest {
    private fun command() = EconomyCommand(UUID.randomUUID().toString(), "ABCD-EFGH-JKMP", 0,
        "create_listing", "berries", quantity = 2, totalPrice = 6)

    @Test fun `market commands have bounded lots canonical ids and explicit owner`() {
        EconomyMarketRules.validate(command())
        for (bad in listOf(
            command().copy(requestId = "wrong"), command().copy(ownerPublicId = ""),
            command().copy(expectedRevision = -1), command().copy(expectedRevision = ECONOMY_MAX_REVISION),
            command().copy(quantity = 0), command().copy(quantity = 100), command().copy(quantity = Long.MAX_VALUE),
            command().copy(totalPrice = -1), command().copy(totalPrice = Long.MAX_VALUE),
            command().copy(action = "credit_coins"), command().copy(targetId = ""),
            command().copy(action = "buy_listing", targetId = "not-an-id"),
        )) assertFailsWith<AuthFailure> { EconomyMarketRules.validate(bad) }
        EconomyMarketRules.validate(command().copy(action = "cancel_listing", targetId = UUID.randomUUID().toString(), quantity = 1, totalPrice = 0))
        assertFailsWith<AuthFailure> { EconomyMarketRules.validate(command().copy(action = "cancel_listing", targetId = UUID.randomUUID().toString())) }
    }

    @Test fun `whole lot price allows exact cap but no overflow or one coin over`() {
        EconomyMarketRules.validatePrice(2, 120, 30)
        EconomyMarketRules.validatePrice(2, 60, 30)
        assertFailsWith<AuthFailure> { EconomyMarketRules.validatePrice(2, 50, 30) }
        assertFailsWith<AuthFailure> { EconomyMarketRules.validatePrice(2, 130, 30) }
        assertFailsWith<AuthFailure> { EconomyMarketRules.validatePrice(2, 61, 30) }
        assertFailsWith<AuthFailure> { EconomyMarketRules.validatePrice(2, 10, 30) }
        assertFailsWith<AuthFailure> { EconomyMarketRules.validatePrice(0, 10, 30) }
        assertFailsWith<AuthFailure> { EconomyMarketRules.validatePrice(1, Long.MAX_VALUE, Long.MAX_VALUE) }
        assertFailsWith<AuthFailure> { EconomyMarketRules.validatePrice(1, 1, 0) }
        assertFailsWith<AuthFailure> { EconomyMarketRules.validatePrice(99, 1_000_000_000, Long.MAX_VALUE) }
    }

    @Test fun `segments limits fee rounding and price ceiling bound premium trade`() {
        assertTrue(EconomyMarketRules.sameHomeBand(2, 3))
        assertTrue(EconomyMarketRules.sameHomeBand(4, 5))
        for ((a,b) in listOf(1 to 1, 2 to 4, 3 to 5, 4 to 3, 5 to 2, 6 to 5))
            assertFalse(EconomyMarketRules.sameHomeBand(a,b))
        assertEquals(listOf(0L,2400L,4800L,9600L,14400L), (1..5).map { EconomyMarketRules.dailyTradeLimit(it) })
        EconomyMarketRules.assertTradeBudget(2340,60,2400)
        assertEquals("ECONOMY_MARKET_DAILY_LIMIT", assertFailsWith<AuthFailure> { EconomyMarketRules.assertTradeBudget(2341,60,2400) }.code)
        assertEquals("ECONOMY_MARKET_SELLER_DAILY_LIMIT", assertFailsWith<AuthFailure> { EconomyMarketRules.assertTradeBudget(2401,1,2400,true) }.code)
        assertEquals(0L, EconomyMarketRules.sellerFee(30,0))
        assertEquals(2L, EconomyMarketRules.sellerFee(30,500))
        assertEquals(3L, EconomyMarketRules.sellerFee(60,500))
        assertEquals(500_000_000L, EconomyMarketRules.sellerFee(ECONOMY_MAX_BALANCE,500))
        assertTrue(EconomyMarketRules.eligible("berries",2,120,2))
        assertFalse(EconomyMarketRules.eligible("berries",2,130,2))
        assertTrue(EconomyBarterRules.sameHomeBand(3,3))
        assertTrue(EconomyBarterRules.sameHomeBand(4,5))
        assertFalse(EconomyBarterRules.sameHomeBand(2,3))
        assertFalse(EconomyBarterRules.sameHomeBand(3,4))
        EconomyBarterRules.assertDailyLimit(0)
        assertEquals("ECONOMY_BARTER_DAILY_LIMIT", assertFailsWith<AuthFailure> { EconomyBarterRules.assertDailyLimit(1) }.code)
    }

    @Test fun `home tiers include producer dependencies and fishing without requiring workshop ownership`() {
        assertEquals(2, EconomyMarketRules.requiredHomeLevel("charcoal"))
        assertEquals(3, EconomyMarketRules.requiredHomeLevel("resin"))
        assertEquals(4, EconomyMarketRules.requiredHomeLevel("tools"))
        assertEquals(4, EconomyMarketRules.requiredHomeLevel("reinforced_parts"))
        assertEquals(1, EconomyMarketRules.requiredHomeLevel("fish_mooncarp"))
        assertEquals(1, EconomyMarketRules.requiredHomeLevel("worm_bait"))
        assertEquals(2, EconomyMarketRules.requiredHomeLevel("glow_bait"))
        assertEquals(3, EconomyMarketRules.requiredHomeLevel("firefly_bait"))
        assertEquals(4, EconomyMarketRules.requiredHomeLevel("fish_shark"))
        assertEquals(Int.MAX_VALUE, EconomyMarketRules.requiredHomeLevel("pearls"))
        assertTrue(EconomyMarketRules.eligible("tools", 1, 1000, 4))
        assertFalse(EconomyMarketRules.eligible("tools", 1, 1000, 3))
        assertFalse(EconomyMarketRules.eligible("tools", 1, 990, 4))
        assertFalse(EconomyMarketRules.eligible("fish_mooncarp", 1, 31, 4))
        for (item in EconomyRules.catalog.items.filter { it.tradable }) {
            assertTrue(EconomyMarketRules.requiredHomeLevel(item.id) in 1..5, item.id)
            EconomyMarketRules.validatePrice(99, item.baseSellPrice * 99, item.baseSellPrice)
            assertFailsWith<AuthFailure> { EconomyMarketRules.validatePrice(99, item.baseSellPrice * 99 - 1, item.baseSellPrice) }
        }
    }
}
