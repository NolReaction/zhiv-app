package ru.zhiv.economy

import kotlinx.serialization.encodeToString
import org.junit.jupiter.api.Test
import kotlin.test.*

class NeighborStockProgressionTest {
    private val settings get() = NeighborRules.defaults
    private val maximumBuildings get() = EconomyRules.catalog.buildings.associate { building -> building.id to building.levels.maxOf { it.level } }
    private fun opened(state: EconomyState) = NeighborRules.eligibleItems(state, settings).map { it.id }.toSet()

    @Test fun `default stock contains the full ordinary catalog without premium currencies relics or raw fish`() {
        val fishing = checkNotNull(EconomyRules.catalog.fishing)
        val rawFishIds = (fishing.fish.map { it.itemId } + fishing.classes.map { it.itemId }).toSet()
        val ordinary = EconomyRules.catalog.items.filter { it.tradable && it.baseSellPrice > 0 && it.category != "special" && it.id !in rawFishIds }
        assertEquals(ordinary.map { it.id }.toSet(), settings.allowedItemIds.toSet())
        assertTrue(settings.allowedItemIds.containsAll(listOf("tools", "research_gear", "cranberry_glaze", "strawberry_compote", "fish_soup", "lens", "festive_sturgeon")))
    }

    @Test fun `learned fish soup is ordinary stock but raw fish never enters the shop`() {
        val state = EconomyRules.initial().copy(buildings = maximumBuildings)
        assertFalse("fish_soup" in opened(state))
        val learned = state.copy(progression = state.progression.copy(recipes = mapOf("cook_grilled_fish" to 1L)))
        assertTrue("fish_soup" in opened(learned))
        val discovered = learned.copy(unlockedItems = EconomyRules.catalog.items.map { it.id })
        val fishing = checkNotNull(EconomyRules.catalog.fishing)
        for (fishId in fishing.fish.map { it.itemId } + fishing.classes.map { it.itemId })
            assertFalse(fishId in opened(discovered))
    }

    @Test fun `the players development opens ordinary materials intermediate products and late crafted goods`() {
        val early = EconomyRules.initial().copy(buildings = EconomyRules.initial().buildings + mapOf("home" to 2, "bridge" to 1))
        val middle = early.copy(buildings = early.buildings + mapOf("home" to 3, "warehouse" to 3, "workshop" to 2,
            "quarry" to 2, "garden" to 2, "kiln" to 1, "dryer" to 1, "woodlot" to 2))
        val late = early.copy(buildings = maximumBuildings)
        val untouched = listOf(early, middle, late).map { economyJson.encodeToString(it) }
        val first = opened(early); val second = opened(middle); val third = opened(late)
        assertTrue(first.containsAll(listOf("wood", "berries")))
        for (id in listOf("planks", "cloth", "blueberries")) { assertFalse(id in first); assertTrue(id in second) }
        for (id in listOf("tools", "research_gear", "cranberry_glaze")) { assertFalse(id in second); assertTrue(id in third) }
        assertEquals(untouched, listOf(early, middle, late).map { economyJson.encodeToString(it) })
    }

    @Test fun `house level does not bypass production prerequisites or the learned compote chain`() {
        val bare = EconomyRules.initial().copy(buildings = EconomyRules.initial().buildings + ("home" to 5))
        assertFalse("tools" in opened(bare))
        val developed = bare.copy(buildings = maximumBuildings)
        assertFalse("strawberries" in opened(developed)); assertFalse("strawberry_compote" in opened(developed))
        val learned = developed.copy(progression = developed.progression.copy(recipes = mapOf("cook_compote" to 1L)))
        assertTrue("strawberries" in opened(learned)); assertTrue("strawberry_compote" in opened(learned))
    }

    @Test fun `gifts do not discover future goods and prior discoveries survive spent inventory`() {
        val gifted = EconomyRules.initial().copy(inventory = mapOf("tools" to 1L, "research_gear" to 1L))
        assertFalse("tools" in opened(gifted)); assertFalse("research_gear" in opened(gifted))
        val remembered = gifted.copy(inventory = emptyMap(), unlockedItems = listOf("research_gear"))
        assertTrue("research_gear" in opened(remembered))
        assertFalse("research_gear" in NeighborRules.eligibleItems(remembered, settings.copy(allowedItemIds = listOf("wood"))).map { it.id })
    }
}
