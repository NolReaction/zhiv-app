package ru.zhiv.economy

import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.*
import org.junit.jupiter.api.Test
import ru.zhiv.auth.AuthFailure
import java.time.Instant
import java.util.UUID
import kotlin.test.*

class EconomyItemUnlocksTest {
    private val now = Instant.parse("2026-10-14T12:00:00Z")
    private fun command(action: String, target: String, price: Long = 0) =
        EconomyCommand(UUID.randomUUID().toString(), "ABCD-EFGH-JKMP", 0, action, target, totalPrice = price)
    private fun apply(state: EconomyState, action: String, target: String) = EconomyRules.apply(state, command(action, target), now).first

    @Test fun `knowledge follows real source chains and remains after goods and buildings disappear`() {
        val initial = EconomyRules.initial()
        assertEquals(1, initial.itemUnlockVersion)
        val source = initial.copy(buildings = initial.buildings + mapOf("home" to 3, "quarry" to 1))
        val before = economyJson.encodeToString(source)
        assertTrue("ore" in EconomyItemUnlocks.project(source))
        assertEquals(before, economyJson.encodeToString(source), "Projection never persists or mutates a profile")
        val pinned = apply(source, "start_exploration", "forest")
        assertTrue("ore" in pinned.unlockedItems)
        val reduced = pinned.copy(inventory = emptyMap(), buildings = initial.buildings, jobs = emptyList())
        assertTrue("ore" in EconomyItemUnlocks.project(reduced))
        assertTrue(EconomyMarketRules.eligible("ore", 1,
            EconomyRules.catalog.items.single { it.id == "ore" }.baseSellPrice, reduced))
        val houseOnly = initial.copy(buildings = initial.buildings + ("home" to 5))
        assertFalse("ore" in EconomyItemUnlocks.project(houseOnly), "A house alone does not provide a quarry source")
    }

    @Test fun `new gifts and NPC inventory do not teach unavailable goods while legacy evidence is inherited once`() {
        val initial = EconomyRules.initial().copy(inventory = mapOf("tools" to 1L, "rope" to 1L))
        assertFalse("tools" in EconomyItemUnlocks.project(initial))
        assertFalse("rope" in EconomyItemUnlocks.project(initial))
        val old = initial.copy(itemUnlockVersion = 0)
        val original = economyJson.encodeToString(old)
        assertTrue(EconomyItemUnlocks.project(old, setOf("glass")).containsAll(listOf("tools", "rope", "glass")))
        assertEquals(original, economyJson.encodeToString(old))
        val persisted = EconomyItemUnlocks.persist(old, setOf("glass"))
        assertEquals(1, persisted.itemUnlockVersion)
        assertTrue(EconomyItemUnlocks.project(persisted.copy(inventory = emptyMap())).containsAll(listOf("tools", "rope", "glass")))
        assertFalse("reinforced_parts" in EconomyItemUnlocks.project(persisted.copy(inventory = mapOf("reinforced_parts" to 1L)),
            setOf("reinforced_parts")))
    }

    @Test fun `retired paid jobs teach their frozen rewards only after successful delivery`() {
        val job = EconomyJob(UUID.randomUUID().toString(), "production", "workshop", "retired_tools_recipe",
            startedAt = now.minusSeconds(100).toString(), finishesAt = now.toString(), rewards = mapOf("tools" to 1L), catalogVersion = 7)
        val state = EconomyRules.initial().copy(inventory = emptyMap(), jobs = listOf(job))
        assertFalse("tools" in EconomyItemUnlocks.project(state))
        val full = state.copy(inventory = mapOf("wood" to 50L))
        val before = economyJson.encodeToString(full)
        assertEquals("ECONOMY_STORAGE_FULL", assertFailsWith<AuthFailure> { apply(full, "claim_job", job.id) }.code)
        assertEquals(before, economyJson.encodeToString(full))
        val claimed = apply(state, "claim_job", job.id)
        assertTrue("tools" in claimed.unlockedItems)
        val sold = apply(claimed, "sell", "tools")
        assertFalse("tools" in sold.inventory); assertTrue("tools" in sold.unlockedItems)
    }

    @Test fun `confirmed route recipe and fish history survive later locks and normalize species to classes`() {
        val state = EconomyRules.initial().copy(inventory = emptyMap(),
            progression = EconomyProgression(routes = mapOf("cave" to 1), recipes = mapOf("make_tools" to 1)),
            fishing = EconomyFishing(catches = mapOf("fish_shark" to 1)))
        val projection = EconomyItemUnlocks.project(state)
        assertTrue(projection.containsAll(listOf("ore", "tools", "fish_legendary")))
        assertFalse("fish_shark" in projection)
        assertEquals(projection.distinct().sorted(), projection)
        val encoded = economyJson.encodeToJsonElement(state).jsonObject
        val previous = economyJson.decodeFromJsonElement<EconomyState>(JsonObject(encoded - setOf("marketSlots", "unlockedItems", "itemUnlockVersion")))
        assertEquals(5, previous.marketSlots); assertTrue(previous.unlockedItems.isEmpty()); assertEquals(0, previous.itemUnlockVersion)
    }

    @Test fun `market capacity upgrades are sequential exact quoted and bounded without changing stored goods`() {
        var state = EconomyRules.initial().let { it.copy(wallet = EconomyWallet(100, 5000), completedExplorations = 1,
            buildings = it.buildings + mapOf("home" to 2, "bridge" to 1)) }
        val inventory = state.inventory
        val initialPearls = state.wallet.pearls
        assertEquals(listOf(100L, 160L, 240L, 360L, 500L), EconomyRules.catalog.market.slotPricesPearls)
        for (slots in 6..10) {
            val offer = checkNotNull(EconomyRules.marketSlotOffer(state))
            assertEquals(slots, offer.slots); assertEquals("market:$slots", offer.targetId)
            val original = economyJson.encodeToString(state)
            assertEquals("MARKET_SLOT_CHANGED", assertFailsWith<AuthFailure> {
                EconomyRules.apply(state, command("buy_market_slot", "market:${slots + 1}", offer.pricePearls), now) }.code)
            assertEquals("MARKET_SLOT_PRICE_CHANGED", assertFailsWith<AuthFailure> {
                EconomyRules.apply(state, command("buy_market_slot", offer.targetId, offer.pricePearls + 1), now) }.code)
            assertEquals("ECONOMY_PEARLS", assertFailsWith<AuthFailure> {
                EconomyRules.apply(state.copy(wallet = state.wallet.copy(pearls = offer.pricePearls - 1)),
                    command("buy_market_slot", offer.targetId, offer.pricePearls), now) }.code)
            assertEquals(original, economyJson.encodeToString(state))
            state = EconomyRules.apply(state, command("buy_market_slot", offer.targetId, offer.pricePearls), now).first
            assertEquals(slots, state.marketSlots); assertEquals(inventory, state.inventory)
        }
        assertEquals(initialPearls - 1360, state.wallet.pearls)
        assertNull(EconomyRules.marketSlotOffer(state))
        assertEquals("MARKET_SLOTS_MAX", assertFailsWith<AuthFailure> {
            EconomyRules.apply(state, command("buy_market_slot", "market:11", 500), now) }.code)
        assertEquals(5, EconomyRules.initial().marketSlots)
        assertTrue(EconomyRules.initial().unlockedItems.isEmpty())
    }
}
