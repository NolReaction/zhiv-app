package ru.zhiv.relationships

import kotlinx.serialization.encodeToString
import org.junit.jupiter.api.Test
import ru.zhiv.economy.*
import java.util.UUID
import kotlin.test.*

class FriendGameSummaryRulesTest {
    private fun state() = EconomyRules.initial().copy(buildings = mapOf("home" to 2, "bridge" to 1),
        completedExplorations = 1, itemUnlockVersion = 1, unlockedItems = listOf("wood"))
    private fun lot(item: String = "wood", price: Long? = null) = FriendMarketPreview(UUID.randomUUID().toString(), item, 1,
        price ?: EconomyRules.catalog.items.single { it.id == item }.baseSellPrice)

    @Test fun `summary exposes XP level with separate world sharing and never invents an open shop`() {
        val empty = FriendGameSummaryRules.project(0, null, null, true, emptyList())
        assertEquals(1, empty.level); assertEquals("buyer_locked", empty.market.reason)
        val hidden = FriendGameSummaryRules.project(480, state(), state(), false, listOf(lot()))
        assertEquals(5, hidden.level)
        assertEquals(FriendMarketSummary(false, "world_hidden", 0, emptyList()), hidden.market)
        val json = economyJson.encodeToString(hidden)
        for (privateField in listOf("wallet", "inventory", "xp", "jobs", "seed")) assertFalse(privateField in json)
    }

    @Test fun `eligible count precedes three-lot preview and private or invalid goods are excluded`() {
        val ordinary = List(4) { lot() }
        val rows = listOf(lot("metal_parts"), lot(price = 0), lot("ancient_core", 10)) + ordinary
        val summary = FriendGameSummaryRules.project(480, state(), state(), true, rows)
        assertTrue(summary.market.available); assertNull(summary.market.reason)
        assertEquals(4, summary.market.count); assertEquals(ordinary.take(3), summary.market.listings)
    }

    @Test fun `both confirmed building gates and buyer discovery are required`() {
        val locked = state().copy(buildings = mapOf("home" to 2, "bridge" to 0))
        assertEquals("buyer_locked", FriendGameSummaryRules.project(0, state(), locked, true, listOf(lot())).market.reason)
        assertEquals("seller_locked", FriendGameSummaryRules.project(0, locked, state(), true, listOf(lot())).market.reason)
        val undiscovered = state().copy(unlockedItems = emptyList(), buildings = mapOf("home" to 2, "bridge" to 1))
        val summary = FriendGameSummaryRules.project(0, state(), undiscovered, true, listOf(lot("metal_parts")))
        assertTrue(summary.market.available); assertEquals(0, summary.market.count)
    }
}
