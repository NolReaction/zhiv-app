package ru.zhiv.economy

import kotlinx.serialization.encodeToString
import org.junit.jupiter.api.Test
import ru.zhiv.auth.AuthFailure
import java.time.Instant
import java.util.UUID
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith

class EconomyRecipeUnlockTest {
    private val now = Instant.parse("2026-11-01T12:00:00Z")
    private val catalog = EconomyRules.catalog
    private val unlocks = mapOf(
        "grow_strawberries" to mapOf("cook_compote" to 1L),
        "make_trade_crate" to mapOf("make_planks" to 3L, "make_rope" to 1L), "make_tools" to mapOf("make_metal_parts" to 2L),
        "make_ceramic_jar" to mapOf("fire_bricks" to 2L), "make_glass_bottle" to mapOf("make_glass" to 2L),
        "grind_lens" to mapOf("make_glass_bottle" to 1L), "assemble_field_kit" to mapOf("make_research_gear" to 1L),
    )
    private fun apply(state: EconomyState, action: String, target: String, at: Instant = now) = EconomyRules.apply(
        state, EconomyCommand(UUID.randomUUID().toString(), "ABCD-EFGH-JKMP", 0, action, target, 1), at).first
    private fun supplied(target: String, prerequisite: String, count: Long) = EconomyRules.initial().copy(
        buildings = catalog.buildings.associate { it.id to it.levels.last().level },
        inventory = catalog.items.associate { it.id to 4L }, wallet = EconomyWallet(100_000),
        progression = EconomyProgression(recipes = catalog.recipes.single { it.id == prerequisite }.requiredRecipes +
            catalog.recipes.single { it.id == target }.requiredRecipes + (prerequisite to count - 1)),
    )
    private fun locked(state: EconomyState, target: String, at: Instant = now) {
        val before = economyJson.encodeToString(state)
        assertEquals("ECONOMY_RECIPE_REQUIRED", assertFailsWith<AuthFailure> {
            apply(state, "start_production", target, at)
        }.code, target)
        assertEquals(before, economyJson.encodeToString(state), "Rejected starts cannot spend or alter jobs")
    }

    @Test fun `crafting lessons and strawberry compote require personally claimed results and survive persistence`() {
        unlocks.forEach { (target, required) -> required.forEach { (prerequisite, count) ->
            assertEquals(required, catalog.recipes.single { it.id == target }.requiredRecipes)
            val initial = supplied(target, prerequisite, count)
            // Bought or gifted products are already in stock, but do not open recipes.
            locked(initial, target)
            val started = apply(initial, "start_production", prerequisite)
            val job = started.jobs.single()
            val ready = Instant.parse(job.finishesAt)
            locked(started, target, ready)
            val claimed = apply(started, "claim_job", job.id, ready)
            assertEquals(count, claimed.progression.recipes[prerequisite], target)
            val restored = economyJson.decodeFromString<EconomyState>(economyJson.encodeToString(claimed))
            assertEquals(target, apply(restored, "start_production", target, ready).jobs.single().recipeId)
        } }
    }

    @Test fun `cancelled lessons never open their dependent recipes`() {
        unlocks.forEach { (target, required) -> required.forEach { (prerequisite, count) ->
            val started = apply(supplied(target, prerequisite, count), "start_production", prerequisite)
            val cancelled = apply(started, "cancel_production", started.jobs.single().id, now.plusMillis(1))
            assertEquals(count - 1, cancelled.progression.recipes[prerequisite] ?: 0L, target)
            locked(cancelled, target, now.plusMillis(1))
        } }
    }

    @Test fun `berries other than strawberries open at their actual level without crafting lessons or a kitchen`() {
        catalog.recipes.filter { it.buildingId == "garden" && it.id != "grow_strawberries" }.forEach { assertEquals(emptyMap(), it.requiredRecipes, it.id) }
        assertEquals(emptyMap(), catalog.recipes.single { it.id == "cook_strawberry_compote" }.requiredRecipes)
        catalog.recipes.filter { it.buildingId == "garden" && it.collection != null && !it.retired && it.id != "grow_strawberries" }.forEach { crop ->
            val initial = EconomyRules.initial()
            val state = initial.copy(buildings = initial.buildings + mapOf("home" to crop.requiredHomeLevel, "garden" to crop.buildingLevel))
            assertEquals(emptyMap(), state.progression.recipes)
            assertEquals(crop.id, apply(state, "start_production", crop.id).jobs.single().recipeId)
        }
    }
}
