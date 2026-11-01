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
        "grow_blueberries" to "cook_strawberry_compote", "grow_currants" to "cook_blueberry_compote",
        "grow_blackberries" to "cook_currant_jelly", "grow_cranberries" to "cook_blackberry_preserve",
        "grind_lens" to "make_glass_bottle", "assemble_field_kit" to "make_research_gear",
    )
    private fun apply(state: EconomyState, action: String, target: String, at: Instant = now) = EconomyRules.apply(
        state, EconomyCommand(UUID.randomUUID().toString(), "ABCD-EFGH-JKMP", 0, action, target, 1), at).first
    private fun supplied(prerequisite: String) = EconomyRules.initial().copy(
        buildings = catalog.buildings.associate { it.id to it.levels.last().level },
        inventory = catalog.items.associate { it.id to 2L }, wallet = EconomyWallet(100_000),
        progression = EconomyProgression(recipes = catalog.recipes.single { it.id == prerequisite }.requiredRecipes),
    )
    private fun locked(state: EconomyState, target: String, at: Instant = now) {
        val before = economyJson.encodeToString(state)
        assertEquals("ECONOMY_RECIPE_REQUIRED", assertFailsWith<AuthFailure> {
            apply(state, "start_production", target, at)
        }.code, target)
        assertEquals(before, economyJson.encodeToString(state), "Rejected starts cannot spend or alter jobs")
    }

    @Test fun `six crafting lessons require personally claimed results and survive persistence`() {
        unlocks.forEach { (target, prerequisite) ->
            assertEquals(mapOf(prerequisite to 1L), catalog.recipes.single { it.id == target }.requiredRecipes)
            val initial = supplied(prerequisite)
            // Bought or gifted products are already in stock, but do not open recipes.
            locked(initial, target)
            val started = apply(initial, "start_production", prerequisite)
            val job = started.jobs.single()
            val ready = Instant.parse(job.finishesAt)
            locked(started, target, ready)
            val claimed = apply(started, "claim_job", job.id, ready)
            assertEquals(1L, claimed.progression.recipes[prerequisite], target)
            val restored = economyJson.decodeFromString<EconomyState>(economyJson.encodeToString(claimed))
            assertEquals(target, apply(restored, "start_production", target, ready).jobs.single().recipeId)
        }
    }

    @Test fun `cancelled lessons never open their dependent recipes`() {
        unlocks.forEach { (target, prerequisite) ->
            val started = apply(supplied(prerequisite), "start_production", prerequisite)
            val cancelled = apply(started, "cancel_production", started.jobs.single().id, now.plusMillis(1))
            assertEquals(0L, cancelled.progression.recipes[prerequisite] ?: 0L, target)
            locked(cancelled, target, now.plusMillis(1))
        }
    }
}
