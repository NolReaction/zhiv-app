package ru.zhiv.economy

import kotlinx.serialization.encodeToString
import org.junit.jupiter.api.Test
import ru.zhiv.auth.AuthFailure
import java.time.Instant
import java.util.UUID
import kotlin.test.*

class EconomyExpeditionLootTest {
    private val now = Instant.parse("2026-11-01T12:00:00Z")
    private fun apply(state: EconomyState, action: String, target: String, at: Instant = now) =
        EconomyRules.apply(state, EconomyCommand(UUID.randomUUID().toString(), "ABCD-EFGH-JKMP", 0, action, target), at).first
    private fun fresh() = EconomyRules.initial(includeStartingPack = false)

    @Test fun `uniform ranges include both endpoints and add a rare find of the same material`() {
        val route = EconomyExploration("loot_test", "Test", "", seconds = 60, rewards = mapOf("wood" to 1L),
            loot = listOf(EconomyExpeditionLootRange("wood", 0, 2), EconomyExpeditionLootRange("stone", 1, 3)),
            finds = EconomyExpeditionFinds(1, listOf(EconomyExpeditionFind("wood", 2, 1))))
        assertEquals(mapOf("stone" to 1L), EconomyExpeditionLoot.draw(route) { 0 })
        assertEquals(mapOf("wood" to 4L, "stone" to 3L), EconomyExpeditionLoot.draw(route) { it - 1 })
        assertEquals(7L, EconomyExpeditionLoot.maximumBonus(route))
        assertFailsWith<IllegalArgumentException> { EconomyExpeditionLoot.draw(route) { -1 } }
        assertFailsWith<IllegalArgumentException> { EconomyExpeditionLoot.draw(route) { it } }
        assertFailsWith<IllegalArgumentException> { EconomyExpeditionLootRange("wood", 3, 2) }
        assertFailsWith<IllegalArgumentException> { route.copy(loot = listOf(EconomyExpeditionLootRange("wood", 0, 1), EconomyExpeditionLootRange("wood", 0, 2))) }
    }

    @Test fun `catalog preserves expected basic resources and keeps maximum delivery within base storage`() {
        val old = mapOf(
            "forest" to mapOf("wood" to 5L, "stone" to 3L, "fiber" to 4L),
            "old_woodland" to mapOf("hardwood" to 4L, "resin" to 2L, "wood" to 1L),
            "coastal_deposits" to mapOf("clay" to 3L, "sand" to 3L, "ore" to 3L),
            "uplands" to mapOf("hardwood" to 4L, "ore" to 6L, "resin" to 4L, "stone" to 4L),
            "far_bank_path" to mapOf("wood" to 4L, "fiber" to 4L, "hardwood" to 6L, "stone" to 4L),
            "far_bank_grove" to mapOf("hardwood" to 4L, "ore" to 3L, "sand" to 3L, "clay" to 4L),
            "ancient_ruins" to mapOf("wood" to 1L, "hardwood" to 10L, "ore" to 10L, "sand" to 8L, "resin" to 6L, "quartz" to 3L))
        for ((id, previous) in old) {
            val route = EconomyRules.catalog.explorations.first { it.id == id }
            val doubledMean = route.rewards.mapValues { it.value * 2 }.toMutableMap()
            for (entry in requireNotNull(route.loot)) doubledMean[entry.itemId] = (doubledMean[entry.itemId] ?: 0L) + entry.min + entry.max
            assertEquals(previous.mapValues { it.value * 2 }, doubledMean, id)
            assertTrue(route.rewards.values.sum() + EconomyExpeditionLoot.maximumBonus(route) <= 49L)
        }
    }

    @Test fun `saved random outcomes stay hidden through completion and failed claims and give XP exactly once`() {
        val started = apply(fresh(), "start_exploration", "forest")
        val job = started.jobs.single()
        assertNotNull(job.expeditionFinds)
        assertNull(started.progression.player)
        val end = Instant.parse(job.finishesAt)
        assertNull(EconomyPublicJobs.project(job, now).expeditionFinds)
        assertNull(EconomyPublicJobs.project(job, end).expeditionFinds)
        val restored = economyJson.decodeFromString<EconomyJob>(economyJson.encodeToString(job))
        assertEquals(job, restored)
        val blocked = started.copy(inventory = mapOf("wood" to 50L), jobs = listOf(restored))
        assertEquals("ECONOMY_STORAGE_FULL", assertFailsWith<AuthFailure> { apply(blocked, "claim_job", job.id, end) }.code)
        assertEquals(restored, blocked.jobs.single())
        val claimed = apply(blocked.copy(inventory = emptyMap()), "claim_job", job.id, end)
        assertEquals(EconomyExpeditionLoot.delivery(job).rewards, claimed.inventory)
        assertEquals(77L, claimed.progression.player?.xp, "40 first-route XP plus 1680 / 45 work XP")
        assertEquals(1L, claimed.completedExplorations)
        assertTrue(claimed.jobs.isEmpty())
        assertEquals("ECONOMY_JOB_GONE", assertFailsWith<AuthFailure> { apply(claimed, "claim_job", job.id, end.plusSeconds(1)) }.code)
    }

    @Test fun `old fixed deliveries stay unchanged and cancelled variable trips give no loot or experience`() {
        val started = apply(fresh(), "start_exploration", "forest")
        val old = started.jobs.single().copy(rewards = mapOf("wood" to 5L, "stone" to 3L, "fiber" to 4L), expeditionFinds = null)
        val claimed = apply(started.copy(jobs = listOf(old)), "claim_job", old.id, Instant.parse(old.finishesAt))
        assertEquals(old.rewards, claimed.inventory)
        val cancelled = apply(started, "cancel_exploration", old.id, now.plusSeconds(1))
        assertTrue(cancelled.inventory.isEmpty())
        assertNull(cancelled.progression.player)
    }
}
