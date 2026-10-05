package ru.zhiv.economy

import org.junit.jupiter.api.Test
import ru.zhiv.auth.AuthFailure
import ru.zhiv.world.WorldRules
import java.time.Instant
import java.util.UUID
import kotlin.test.*

class EconomyWardrobeTest {
    private val now = Instant.parse("2026-10-05T20:00:00Z")
    private fun command(target: String, price: Long, quantity: Long = 1) = EconomyCommand(
        UUID.randomUUID().toString(), "ABCD-EFGH-JKMP", 0, "buy_wardrobe_item", target, quantity, price)

    @Test fun `every sellable cosmetic spends its declared currency once without affecting gameplay or storage`() {
        val initial = EconomyRules.initial().copy(wallet = EconomyWallet(20_000, 2_000), inventory = mapOf("wood" to 1000L))
        for (item in WorldRules.catalog.items.filter { it.purchase != null }) {
            val price = checkNotNull(item.purchase)
            val cmd = command("${price.currency}:${item.id}", price.amount)
            val next = EconomyRules.apply(initial, cmd, now).first
            assertTrue(item.id in next.wardrobe)
            assertEquals(initial.inventory, next.inventory)
            assertEquals(initial.fishing, next.fishing)
            assertEquals(initial.jobs, next.jobs)
            assertEquals(initial.wallet.coins - if (price.currency == "coins") price.amount else 0, next.wallet.coins)
            assertEquals(initial.wallet.pearls - if (price.currency == "pearls") price.amount else 0, next.wallet.pearls)
            assertEquals("ECONOMY_WARDROBE_OWNED", assertFailsWith<AuthFailure> { EconomyRules.apply(next, cmd, now) }.code)
        }
    }

    @Test fun `currency substitutions stale quotes bulk orders and missing funds cannot buy clothes`() {
        val initial = EconomyRules.initial().copy(wallet = EconomyWallet(20_000, 2_000))
        for (target in listOf("coins:heather", "pearls:fern", "coins:moss", "coins:explorer_cap", "coins:willow_rod", "coins:fish"))
            assertEquals("ECONOMY_WARDROBE_ITEM", assertFailsWith<AuthFailure> { EconomyRules.apply(initial, command(target, 150), now) }.code)
        for (price in listOf(0L, 149L, 151L))
            assertEquals("ECONOMY_WARDROBE_PRICE_CHANGED", assertFailsWith<AuthFailure> { EconomyRules.apply(initial, command("pearls:heather", price), now) }.code)
        assertEquals("INVALID_ECONOMY_COMMAND", assertFailsWith<AuthFailure> { EconomyRules.apply(initial, command("pearls:heather", 150, 2), now) }.code)
        assertEquals("ECONOMY_RESOURCES", assertFailsWith<AuthFailure> { EconomyRules.apply(EconomyRules.initial(), command("pearls:heather", 150), now) }.code)
        assertEquals(listOf("moss", "amber_scarf"), initial.wardrobe)
    }
}
