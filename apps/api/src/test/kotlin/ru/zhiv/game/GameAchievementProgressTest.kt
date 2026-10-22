package ru.zhiv.game

import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import org.junit.jupiter.api.Test
import ru.zhiv.economy.*
import kotlin.test.*

class GameAchievementProgressTest {
    @Test fun `distinct current routes replace obsolete biome groups and exclude forged ids`() {
        for (route in EconomyRules.catalog.explorations) {
            val visited = EconomyRules.initial().copy(progression = EconomyProgression(routes = mapOf(route.id to 100L, "invented" to 999L)))
            assertEquals(1L, economyAchievementProgress(visited).getValue("familiar_trails"), route.id)
        }
        val state = EconomyRules.initial().copy(progression = EconomyProgression(routes = mapOf("forest" to 2L, "forest_camp" to 1L, "old_woodland" to 1L)))
        assertEquals(3L, economyAchievementProgress(state).getValue("familiar_trails"))
        val historic = achievementWithTiers("familiar_trails", 0L, mapOf(1 to "2026-01-01T00:00:00Z"))
        assertEquals("2026-01-01T00:00:00Z", historic.unlockedAt)
        assertEquals(3L, historic.progress)
    }

    @Test fun `unique completed recipes and personal catch catalogue exclude ownership and arbitrary IDs`() {
        val recipes = EconomyRules.catalog.recipes.take(5).associate { it.id to 100L } + ("unknown" to 999L)
        val fish = EconomyRules.catalog.fishing!!.fish.associate { it.itemId to 99L }
        val state = EconomyRules.initial().copy(inventory=fish,progression=EconomyProgression(recipes=recipes))
        assertEquals(5L,economyAchievementProgress(state).getValue("master_recipes"))
        assertEquals(0L,economyAchievementProgress(state).getValue("river_atlas"))
        assertEquals(12L,economyAchievementProgress(state.copy(fishing=state.fishing.copy(catches=fish + ("unknown" to 999L)))).getValue("river_atlas"))
        assertEquals(0L,economyAchievementProgress(state).getValue("first_sale"))
        assertEquals(1L,economyAchievementProgress(state,true).getValue("first_sale"))
    }

    @Test fun `retired quarry recipes keep promised progress while new mining is a route not a craft`() {
        val paid = EconomyJob(id = "00000000-0000-4000-8000-000000000001", kind = "production", targetId = "quarry",
            recipeId = "quarry_stone", startedAt = "2026-10-06T00:00:00Z", finishesAt = "2026-10-06T00:30:00Z",
            rewards = mapOf("stone" to 8L), catalogVersion = 3)
        assertFalse(EconomyRules.catalog.recipes.any { it.id == paid.recipeId })
        val claimed = EconomyRules.initial().copy(progression = EconomyCollectionProgress.advance(EconomyProgression(), paid))
        assertEquals(1L, economyAchievementProgress(claimed).getValue("master_recipes"))
        val mining = paid.copy(kind = "exploration", targetId = "quarry_ore", recipeId = null)
        val current = claimed.copy(progression = EconomyCollectionProgress.advance(claimed.progression, mining))
        assertEquals(1L, current.progression.routes["quarry_ore"])
        assertNull(current.progression.recipes["quarry_ore"])
        assertEquals(1L, economyAchievementProgress(current).getValue("master_recipes"))
        assertEquals(1L, economyAchievementProgress(current).getValue("familiar_trails"))
        val historical = current.copy(progression = current.progression.copy(recipes = current.progression.recipes +
            mapOf("quarry_sand" to 4L, "quarry_forged" to 99L, "cave" to 99L)))
        assertEquals(2L, economyAchievementProgress(historical).getValue("master_recipes"))
    }

    @Test fun `inherited ownership and wrong chapter time cannot become personal finds`() {
        val state = EconomyRules.initial().copy(progression=EconomyProgression(collections=EconomyBookCollection(listOf("acorn"),0,14400)))
        assertEquals(0L,economyAchievementProgress(state).getValue("lucky_find"))
        val traveled=state.copy(progression=state.progression.copy(collections=state.progression.collections.copy(travelSeconds=7200)))
        assertEquals(0L,economyAchievementProgress(traveled,inheritedFinds=listOf("acorn")).getValue("lucky_find"))
        assertEquals(1L,economyAchievementProgress(traveled).getValue("lucky_find"))
    }

    @Test fun `partial ownership keeps first date and next progress while grants do not require forged counters`() {
        val first="2026-01-01T00:00:00Z"
        val partial=achievementWithTiers("explorer",0,mapOf(1 to first))
        assertEquals(first,partial.unlockedAt); assertEquals(50L,partial.target); assertEquals(10L,partial.progress)
        assertEquals(listOf(first,null,null),partial.tiers.map { it.unlockedAt })
        val full=achievementWithTiers("home_builder",1,(1..4).associateWith { first })
        assertEquals(5L,full.progress); assertEquals(5L,full.target)
        assertTrue(full.tiers.all { it.progress==it.target })
        val json=Json { encodeDefaults=true }
        val old=Json.parseToJsonElement(json.encodeToString(partial.copy(tiers=emptyList()))).jsonObject
        assertFalse("tiers" in old,"catalogue1–4 omits new fields even with encodeDefaults")
    }
    @Test fun `current activity medals use durable personal counters and clamp cumulative values safely`() {
        val empty = EconomyRules.initial().copy(inventory = mapOf("fish" to 200L, "berries" to 500L, "grilled_fish" to 100L))
        val names = listOf("patient_angler", "campfire_cook", "helpful_neighbor", "generous_garden")
        assertTrue(names.all { economyAchievementProgress(empty).getValue(it) == 0L })
        val state = empty.copy(fishing = empty.fishing.copy(catches = mapOf("fish" to 9L, "fish_silverfin" to 1L, "forged" to Long.MAX_VALUE)),
            progression = EconomyProgression(recipes = mapOf("cook_grilled_fish" to 3L, "cook_compote" to 2L,
                "grow_berries" to 9L, "grow_strawberries" to 1L, "quarry_stone" to 100L, "forged" to 999L)),
            residentOrders = empty.residentOrders.copy(completed = 5L))
        val progress = economyAchievementProgress(state)
        assertEquals(10L, progress["patient_angler"]); assertEquals(5L, progress["campfire_cook"])
        assertEquals(5L, progress["helpful_neighbor"]); assertEquals(10L, progress["generous_garden"])
        val huge = economyAchievementProgress(state.copy(
            fishing = state.fishing.copy(catches = mapOf("fish" to Long.MAX_VALUE, "fish_silverfin" to Long.MAX_VALUE)),
            progression = state.progression.copy(recipes = mapOf("cook_grilled_fish" to Long.MAX_VALUE, "cook_compote" to Long.MAX_VALUE,
                "grow_berries" to Long.MAX_VALUE, "grow_strawberries" to Long.MAX_VALUE))))
        assertEquals(200L, huge["patient_angler"]); assertEquals(100L, huge["campfire_cook"]); assertEquals(200L, huge["generous_garden"])
    }

}
