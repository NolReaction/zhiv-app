package ru.zhiv.economy

import kotlinx.serialization.encodeToString
import org.junit.jupiter.api.Test
import ru.zhiv.auth.AuthFailure
import java.time.Instant
import java.util.UUID
import kotlin.test.*

class EconomyActorTest {
    private val now = Instant.parse("2026-10-05T10:00:00Z")
    private fun command(action: String, target: String) =
        EconomyCommand(UUID.randomUUID().toString(), "ABCD-EFGH-JKMP", 0, action, target, 1)
    private fun apply(state: EconomyState, action: String, target: String, at: Instant = now) =
        EconomyRules.apply(state, command(action, target), at).first
    private fun readyAt(job: EconomyJob) = Instant.parse(job.finishesAt)
    private fun player() = EconomyRules.initial().copy(wallet = EconomyWallet(500_000),
        buildings = EconomyRules.catalog.buildings.associate { it.id to it.levels.last().level },
        inventory = mapOf("wood" to 20L, "fiber" to 20L, "dried_berries" to 20L, "smoked_fish" to 20L, "tools" to 20L, "rope" to 20L))
    private val quarryRecipes get() = EconomyRules.catalog.recipes.filter { it.buildingId == "quarry" }

    @Test fun `quarry and all routes exclude each other until delivery without changing spent resources or rare clocks`() {
        val mining = apply(player(), "start_production", "quarry_stone")
        val before = economyJson.encodeToString(mining)
        for (at in listOf(now, readyAt(mining.jobs.single()))) for (route in EconomyRules.catalog.explorations) {
            val actions = if (route.id in checkNotNull(EconomyRules.catalog.fishing).routeIds) listOf("start_exploration", "start_fishing")
                else listOf("start_exploration")
            for (action in actions) assertEquals("ECONOMY_QUARRY_BUSY", assertFailsWith<AuthFailure> {
                apply(mining, action, route.id, at)
            }.code)
        }
        assertEquals(before, economyJson.encodeToString(mining))
        val travelling = apply(player(), "start_exploration", "cave")
        val paid = economyJson.encodeToString(travelling)
        for (at in listOf(now, readyAt(travelling.jobs.single()))) for (recipe in quarryRecipes)
            assertEquals("ECONOMY_EXPLORER_BUSY", assertFailsWith<AuthFailure> { apply(travelling, "start_production", recipe.id, at) }.code)
        assertEquals(paid, economyJson.encodeToString(travelling))
    }

    @Test fun `berry gathering waits for mining to finish then owns the hero through its successful claim`() {
        val growing = apply(player(), "start_production", "grow_berries")
        val berries = growing.jobs.single()
        val mining = apply(growing, "start_production", "quarry_stone_overnight")
        val mine = mining.jobs.single { it.targetId == "quarry" }
        val finish = readyAt(mine)
        assertEquals("ECONOMY_QUARRY_BUSY", assertFailsWith<AuthFailure> { apply(mining, "start_collection", berries.id, finish.minusNanos(1)) }.code)
        val passive = apply(mining, "start_production", "gather_wood")
        assertEquals(3, passive.jobs.size)
        val upgrade = EconomyRules.catalog.buildings.single { it.id == "warehouse" }.levels.single { it.level == 5 }
        val construction = apply(passive.copy(buildings = passive.buildings + ("warehouse" to 4),
            inventory = passive.inventory + upgrade.cost.items), "start_construction", "warehouse")
        assertTrue(construction.jobs.any { it.kind == "construction" })
        val collecting = apply(construction, "start_collection", berries.id, finish)
        val deliveredAt = Instant.parse(checkNotNull(collecting.jobs.single { it.id == berries.id }.collection?.finishesAt))
        val receivedStone = apply(collecting, "claim_job", mine.id, deliveredAt)
        for (recipe in quarryRecipes) assertEquals("ECONOMY_COLLECTOR_BUSY", assertFailsWith<AuthFailure> {
            apply(receivedStone, "start_production", recipe.id, deliveredAt)
        }.code)
        assertEquals("ECONOMY_COLLECTOR_BUSY", assertFailsWith<AuthFailure> { apply(receivedStone, "start_exploration", "forest", deliveredAt) }.code)
        val receivedBerries = apply(receivedStone, "claim_job", berries.id, deliveredAt)
        assertTrue(apply(receivedBerries, "start_production", "quarry_stone", deliveredAt).jobs.any { it.targetId == "quarry" })
    }

    @Test fun `failed quarry delivery keeps ownership and successful delivery or trip cancellation frees it`() {
        val mining = apply(player(), "start_production", "quarry_stone")
        val job = mining.jobs.single(); val finish = readyAt(job)
        val full = mining.copy(inventory = mapOf("wood" to EconomyRules.storage(mining).capacity))
        assertEquals("ECONOMY_STORAGE_FULL", assertFailsWith<AuthFailure> { apply(full, "claim_job", job.id, finish) }.code)
        assertEquals("ECONOMY_QUARRY_BUSY", assertFailsWith<AuthFailure> { apply(full, "start_exploration", "forest", finish) }.code)
        val claimed = apply(mining.copy(inventory = emptyMap()), "claim_job", job.id, finish)
        assertEquals(job.rewards, claimed.inventory); assertEquals(0L, claimed.completedExplorations)
        val trip = apply(claimed, "start_exploration", "cave", finish)
        val returned = apply(trip, "cancel_exploration", trip.jobs.single().id, finish)
        assertTrue(apply(returned, "start_production", "quarry_stone", finish).jobs.any { it.targetId == "quarry" })
    }

    @Test fun `old overlapping jobs retain rewards and progression in either claim order without requiring known recipes`() {
        for (miningFirst in listOf(true, false)) {
            val original = player()
            val mine = apply(original, "start_production", "quarry_stone").jobs.single().copy(
                recipeId = "retired-quarry-order", rewards = mapOf("stone" to 13L), catalogVersion = 1)
            val cave = apply(original, "start_exploration", "cave").jobs.single().copy(
                rewards = mapOf("ore" to 9L), rareDrop = null, catalogVersion = 1)
            var saved = original.copy(jobs = listOf(mine, cave), inventory = emptyMap())
            val at = maxOf(readyAt(mine), readyAt(cave))
            for (job in if (miningFirst) listOf(mine, cave) else listOf(cave, mine)) saved = apply(saved, "claim_job", job.id, at)
            assertEquals(mapOf("stone" to 13L, "ore" to 9L), saved.inventory)
            assertEquals(1L, saved.completedExplorations)
            assertEquals(1L, saved.progression.recipes["retired-quarry-order"])
            assertEquals(1L, saved.progression.routes["cave"])
            assertEquals(5400L, saved.progression.collections.quarrySeconds)
            assertEquals("ECONOMY_JOB_GONE", assertFailsWith<AuthFailure> { apply(saved, "claim_job", mine.id, at) }.code)
        }
    }
}
