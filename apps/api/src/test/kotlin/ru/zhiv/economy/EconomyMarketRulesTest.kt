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
        EconomyMarketRules.validatePrice(2, 300, 30)
        EconomyMarketRules.validatePrice(2, 60, 30)
        assertFailsWith<AuthFailure> { EconomyMarketRules.validatePrice(2, 50, 30) }
        assertFailsWith<AuthFailure> { EconomyMarketRules.validatePrice(2, 310, 30) }
        assertFailsWith<AuthFailure> { EconomyMarketRules.validatePrice(2, 61, 30) }
        assertFailsWith<AuthFailure> { EconomyMarketRules.validatePrice(2, 10, 30) }
        assertFailsWith<AuthFailure> { EconomyMarketRules.validatePrice(0, 10, 30) }
        assertFailsWith<AuthFailure> { EconomyMarketRules.validatePrice(1, Long.MAX_VALUE, Long.MAX_VALUE) }
        assertFailsWith<AuthFailure> { EconomyMarketRules.validatePrice(1, 1, 0) }
        assertFailsWith<AuthFailure> { EconomyMarketRules.validatePrice(99, 1_000_000_000, Long.MAX_VALUE) }
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
