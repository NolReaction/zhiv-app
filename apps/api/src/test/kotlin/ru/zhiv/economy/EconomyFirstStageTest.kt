package ru.zhiv.economy

import kotlinx.serialization.encodeToString
import org.junit.jupiter.api.Test
import ru.zhiv.auth.AuthFailure
import java.time.Instant
import java.util.UUID
import kotlin.test.*

class EconomyFirstStageTest {
    private val now = Instant.parse("2026-10-13T21:00:00Z")
    private fun command(action: String, target: String, quantity: Long = 1) = EconomyCommand(
        UUID.randomUUID().toString(), "ABCD-EFGH-JKMP", 0, action, target, quantity)
    private fun apply(state: EconomyState, action: String, target: String, at: Instant = now, quantity: Long = 1) =
        EconomyRules.apply(state, command(action, target, quantity), at).first

    @Test fun `first stage batch requests cannot multiply one slot into multiple items`() {
        val original = EconomyRules.initial().copy(inventory = mapOf("wood" to 10L, "berries" to 10L, "fish_common" to 10L),
            buildings = EconomyRules.initial().buildings + mapOf("woodlot" to 1, "workshop" to 1, "dryer" to 1),
            progression = EconomyProgression(recipes = mapOf("cook_compote" to 1L)))
        for (recipe in listOf("grow_berries", "grow_strawberries", "gather_wood", "make_planks", "cook_compote", "cook_grilled_fish")) {
            assertEquals("INVALID_ECONOMY_COMMAND", assertFailsWith<AuthFailure> {
                apply(original, "start_production", recipe, quantity = 2) }.code)
            val started = apply(original, "start_production", recipe)
            assertEquals(1L, started.jobs.single().rewards.values.sum(), recipe)
        }
    }

    @Test fun `compote unlock requires successful collection and strawberry harvest uses the saved collector`() {
        val initial = EconomyRules.initial().copy(inventory = mapOf("berries" to 2L),
            buildings = EconomyRules.initial().buildings + ("dryer" to 1))
        assertFalse("strawberries" in EconomyFood.obtainableOrderItems(initial))
        assertEquals("ECONOMY_RECIPE_REQUIRED", assertFailsWith<AuthFailure> {
            apply(initial, "start_production", "grow_strawberries") }.code)
        val cooking = apply(initial, "start_production", "cook_compote")
        val ready = Instant.parse(cooking.jobs.single().finishesAt)
        assertEquals("ECONOMY_RECIPE_REQUIRED", assertFailsWith<AuthFailure> {
            apply(cooking, "start_production", "grow_strawberries", ready) }.code)
        val cooked = apply(cooking, "claim_job", cooking.jobs.single().id, ready)
        assertEquals(1L, cooked.progression.recipes["cook_compote"])
        assertTrue("strawberries" in EconomyFood.obtainableOrderItems(cooked))
        val growing = apply(cooked, "start_production", "grow_strawberries", ready)
        val saved = economyJson.decodeFromString<EconomyState>(economyJson.encodeToString(growing))
        assertEquals(mapOf("strawberries" to 1L), saved.jobs.single().rewards)
        val ripe = Instant.parse(saved.jobs.single().finishesAt)
        val collecting = apply(saved, "start_collection", saved.jobs.single().id, ripe)
        assertEquals(8L, collecting.jobs.single().collection!!.seconds)
        val done = Instant.parse(collecting.jobs.single().collection!!.finishesAt)
        val collected = apply(collecting, "claim_job", collecting.jobs.single().id, done)
        assertEquals(1L, collected.inventory["strawberries"])
        assertEquals(1L, collected.progression.recipes["grow_strawberries"])
    }

    @Test fun `two berry jobs and one strawberry job occupy three independent slots until claimed`() {
        var state = EconomyRules.initial().copy(productionSlots = mapOf("garden" to 3),
            progression = EconomyProgression(recipes = mapOf("cook_compote" to 1L)))
        for (recipe in listOf("grow_berries", "grow_berries", "grow_strawberries")) state = apply(state, "start_production", recipe)
        assertEquals(listOf(60L, 60L, 300L), state.jobs.map { Instant.parse(it.finishesAt).epochSecond - now.epochSecond })
        assertEquals(3, state.jobs.map { it.id }.distinct().size)
        assertEquals("ECONOMY_BUILDING_BUSY", assertFailsWith<AuthFailure> {
            apply(state, "start_production", "grow_berries", now.plusSeconds(600)) }.code)
    }

    @Test fun `pre v6 jobs still settle frozen harvest quantities`() {
        for (version in 1..5) {
            val job = EconomyJob(UUID.randomUUID().toString(), "production", "woodlot", "gather_wood",
                startedAt = now.minusSeconds(1200).toString(), finishesAt = now.toString(),
                rewards = mapOf("wood" to 5L), catalogVersion = version)
            val state = EconomyRules.initial().copy(inventory = emptyMap(), jobs = listOf(job))
            assertEquals(mapOf("wood" to 5L), apply(state, "claim_job", job.id).inventory)
        }
    }
}
