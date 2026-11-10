package ru.zhiv.economy

import kotlinx.serialization.encodeToString
import org.junit.jupiter.api.Test
import ru.zhiv.auth.AuthFailure
import ru.zhiv.game.economyAchievementProgress
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

    @Test fun `new bait and meal finds have exact probabilities and preserve ordinary acquisition`() {
        data class FindCase(val routeId: String, val itemId: String, val quantity: Long, val weight: Int, val emptyWeight: Int, val maximum: Long)
        for ((routeId, itemId, quantity, weight, emptyWeight, maximum) in listOf(
            FindCase("forest", "worm_bait", 3L, 20, 30, 20L),
            FindCase("far_bank_grove", "currant_jelly", 1L, 6, 64, 22L))) {
            val route = EconomyRules.catalog.explorations.first { it.id == routeId }
            val finds = requireNotNull(route.finds)
            assertEquals(emptyWeight, finds.emptyWeight)
            assertEquals(100, finds.emptyWeight + finds.entries.sumOf { it.weight })
            assertEquals(EconomyExpeditionFind(itemId, quantity, weight), finds.entries.first { it.itemId == itemId })
            val outcomes = (0 until 100).map { roll -> EconomyExpeditionLoot.draw(finds) { roll } }
            assertEquals(weight, outcomes.count { it[itemId] == quantity })
            assertEquals(emptyWeight, outcomes.count { it.isEmpty() })
            for (entry in finds.entries) assertEquals(entry.weight, outcomes.count { it[entry.itemId] == entry.quantity })
            assertEquals(maximum, route.rewards.values.sum() + EconomyExpeditionLoot.maximumBonus(route))
        }
        assertEquals(1L, EconomyRules.catalog.fishing!!.baits.first { it.itemId == "worm_bait" }.price)
        val recipe = EconomyRules.catalog.recipes.first { it.id == "cook_currant_jelly" }
        assertFalse(recipe.retired)
        assertEquals(mapOf("currants" to 2L, "berry_compote" to 1L, "ceramic_jar" to 1L), recipe.cost.items)
        assertEquals(mapOf("currant_jelly" to 1L), recipe.rewards)
    }

    @Test fun `three bait outcome claims at exactly fifty slots and remains unchanged after a full storage failure`() {
        val route = EconomyRules.catalog.explorations.first { it.id == "forest" }
        val started = apply(fresh(), "start_exploration", route.id)
        val job = started.jobs.single().copy(expeditionFinds = EconomyExpeditionLoot.draw(route) { it - 1 })
        assertEquals(3L, job.expeditionFinds?.get("worm_bait"))
        assertEquals(20L, EconomyExpeditionLoot.delivery(job).rewards.values.sum())
        val end = Instant.parse(job.finishesAt)
        val blocked = started.copy(inventory = mapOf("wood" to 31L), jobs = listOf(job))
        assertEquals("ECONOMY_STORAGE_FULL", assertFailsWith<AuthFailure> { apply(blocked, "claim_job", job.id, end) }.code)
        assertEquals(job, blocked.jobs.single())
        val claimed = apply(blocked.copy(inventory = mapOf("wood" to 30L)), "claim_job", job.id, end)
        assertEquals(3L, claimed.inventory["worm_bait"])
        assertEquals(50L, claimed.inventory.values.sum())
        assertTrue(claimed.jobs.isEmpty())
    }

    @Test fun `found meal is usable but gives no cooking mastery additional XP or resale pearls`() {
        val route = EconomyRules.catalog.explorations.first { it.id == "far_bank_grove" }
        val initial = fresh().let { it.copy(buildings = it.buildings + mapOf("home" to 4, "bridge" to 1, "kiln" to 1, "dryer" to 2),
            inventory = mapOf("packed_berries" to 1L)) }
        val started = apply(initial, "start_exploration", route.id)
        val job = started.jobs.single().copy(expeditionFinds = EconomyExpeditionLoot.draw(route) { it - 1 })
        val end = Instant.parse(job.finishesAt)
        val lucky = apply(started.copy(jobs = listOf(job)), "claim_job", job.id, end)
        val ordinary = apply(started.copy(jobs = listOf(job.copy(expeditionFinds = emptyMap()))), "claim_job", job.id, end)
        assertEquals(1L, lucky.inventory["currant_jelly"])
        assertNull(ordinary.inventory["currant_jelly"])
        assertEquals(ordinary.progression.player, lucky.progression.player)
        assertEquals(113L, lucky.progression.player?.xp, "40 first-route XP plus 3300 / 45 work XP")
        assertEquals(ordinary.wallet.pearls, lucky.wallet.pearls)
        assertTrue(lucky.progression.recipes.isEmpty())
        for (id in listOf("master_recipes", "campfire_cook", "forest_cuisine", "first_sale"))
            assertEquals(0L, economyAchievementProgress(lucky)[id], id)
        val eaten = apply(lucky, "eat_food", "currant_jelly", end)
        assertEquals(0L, eaten.inventory["currant_jelly"] ?: 0L)
        assertEquals("currant_jelly", eaten.food.heroMeal)
        assertEquals(lucky.progression, eaten.progression)
        val sold = apply(lucky, "sell", "currant_jelly", end)
        assertEquals(570L, sold.wallet.coins - lucky.wallet.coins)
        assertEquals(lucky.wallet.pearls, sold.wallet.pearls)
        assertEquals(lucky.progression, sold.progression)
        assertEquals(0L, economyAchievementProgress(sold)["first_sale"])
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
