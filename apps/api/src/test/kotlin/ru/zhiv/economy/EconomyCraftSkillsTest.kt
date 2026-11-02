package ru.zhiv.economy

import kotlinx.serialization.encodeToString
import org.junit.jupiter.api.Test
import ru.zhiv.auth.AuthFailure
import java.time.Instant
import java.util.UUID
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

class EconomyCraftSkillsTest {
    private val now = Instant.parse("2026-11-02T12:00:00Z")
    private val catalog = EconomyRules.catalog
    private val experiments = catalog.recipes.filter { it.experiment != null }
    private fun supplied(id: String = "experiment_currant_fish"): EconomyState {
        val recipe = catalog.recipes.single { it.id == id }
        return EconomyRules.initial().copy(
            buildings = catalog.buildings.associate { it.id to it.levels.last().level }, inventory = recipe.cost.items,
            wallet = EconomyWallet(100_000), itemUnlockVersion = 1,
            progression = EconomyProgression(skills = EconomyCraftSkills(cookingSeconds = catalog.skills!!.levels[(recipe.experiment?.requiredCookingLevel ?: 1) - 1].requiredSeconds)),
        )
    }
    private fun apply(state: EconomyState, action: String, target: String, at: Instant = now) = EconomyRules.apply(state,
        EconomyCommand(UUID.randomUUID().toString(), "ABCD-EFGH-JKMP", 0, action, target, 1), at).first
    private fun prepared(recipe: EconomyRecipe, successful: Boolean): EconomyState {
        val started = apply(supplied(recipe.id), "start_production", recipe.id)
        val job = started.jobs.single()
        assertEquals(recipe.seconds, job.skillWorkSeconds)
        assertEquals(EconomySkills.chance(supplied(recipe.id), recipe), job.cooking?.successChanceBps)
        return started.copy(jobs = listOf(job.copy(cooking = job.cooking!!.copy(successful = successful),
            rewards = if (successful) recipe.rewards else recipe.experiment!!.failureRewards)))
    }
    private fun claim(state: EconomyState): EconomyState = state.jobs.single().let { apply(state, "claim_job", it.id, Instant.parse(it.finishesAt)) }

    @Test fun `ten gradual skill levels preserve zero legacy defaults and bounded bonuses`() {
        val config = checkNotNull(catalog.skills)
        assertEquals(listOf(0L, 5L, 15L, 35L, 70L, 125L, 210L, 340L, 520L, 800L), config.levels.map { it.requiredSeconds / 3600 })
        assertEquals(1, EconomySkills.level(EconomyRules.initial(), "cooking"))
        assertEquals(8500, EconomySkills.chance(EconomyRules.initial(), experiments.first()))
        config.levels.forEachIndexed { index, row ->
            val state = supplied().copy(progression = EconomyProgression(skills = EconomyCraftSkills(cookingSeconds = row.requiredSeconds, travelSeconds = row.requiredSeconds)))
            assertEquals(index + 1, EconomySkills.level(state, "cooking"))
            assertEquals(index + 1, EconomySkills.level(state, "travel"))
            assertTrue(EconomySkills.bonus(state, "travel") <= 500)
            assertTrue(EconomySkills.chance(state, experiments.first()) <= 9500)
        }
        assertNull(economyJson.decodeFromString<EconomyProgression>("{}").skills)
        assertFailsWith<IllegalArgumentException> { EconomyCraftSkills(cookingSeconds = -1) }
    }

    @Test fun `each experiment compensates failure at base skill and respects maximum skill work value`() {
        assertEquals(4, experiments.size)
        fun value(items: Map<String, Long>) = items.entries.sumOf { (id, count) -> catalog.items.single { it.id == id }.baseSellPrice * count }.toDouble()
        experiments.forEach { recipe ->
            val work = recipe.seconds / 60.0 * catalog.timeEconomy!!.coinsPerMinute
            val cost = recipe.cost.coins + value(recipe.cost.items)
            val win = value(recipe.rewards); val fail = value(recipe.experiment!!.failureRewards)
            val base = recipe.experiment.successBps / 10000.0
            assertTrue(base * win + (1 - base) * fail - cost >= work, recipe.id)
            assertTrue(base * win + (1 - base) * fail - cost < work + 1, recipe.id)
            assertTrue(.95 * win + .05 * fail - cost <= work * 1.15, recipe.id)
            assertEquals(1L, recipe.rewards.values.sum())
            assertEquals(1L, recipe.experiment.failureRewards.values.sum())
            assertTrue(EconomySkills.prepare(supplied(recipe.id), recipe) { 0 }!!.successful!!)
            assertFalse(EconomySkills.prepare(supplied(recipe.id), recipe) { 9999 }!!.successful!!)
        }
    }

    @Test fun `saved success and failure remain private through ready time then train and discover once on claim`() {
        experiments.forEach { recipe -> listOf(false, true).forEach { successful ->
            val started = prepared(recipe, successful)
            val restored = economyJson.decodeFromString<EconomyState>(economyJson.encodeToString(started))
            val job = restored.jobs.single(); val ready = Instant.parse(job.finishesAt)
            listOf(now, ready).forEach { at ->
                val public = EconomyPublicJobs.project(job, at)
                assertNull(public.cooking!!.successful)
                assertEquals(recipe.rewards, public.rewards)
                assertFalse(economyJson.encodeToString(public).contains("\"successful\""))
                assertEquals(successful, job.cooking!!.successful)
            }
            val claimed = claim(restored)
            assertEquals(if (successful) recipe.rewards else recipe.experiment!!.failureRewards, claimed.inventory)
            assertEquals((restored.progression.skills?.cookingSeconds ?: 0) + recipe.seconds, claimed.progression.skills!!.cookingSeconds)
            assertEquals(if (successful) 1L else 0L, claimed.progression.recipes[recipe.id] ?: 0L)
            assertEquals(successful, claimed.progression.skills.lastCooking!!.successful)
            assertEquals("ECONOMY_JOB_GONE", assertFailsWith<AuthFailure> { apply(claimed, "claim_job", job.id, ready) }.code)
        } }
    }

    @Test fun `start metadata and public reward slots cannot expose the refundable outcome`() {
        val recipe = experiments.first(); val win = prepared(recipe, true); val lose = prepared(recipe, false)
        val publicWin = EconomyPublicJobs.project(win.jobs.single())
        val publicLose = EconomyPublicJobs.project(lose.jobs.single()).copy(id = publicWin.id)
        assertEquals(publicWin, publicLose)
        listOf(win, lose).forEach { started ->
            val cancelled = apply(started, "cancel_production", started.jobs.single().id, now.plusMillis(1))
            assertEquals(recipe.cost.items, cancelled.inventory)
            assertEquals(started.progression.skills, cancelled.progression.skills)
            assertEquals(0L, cancelled.progression.recipes[recipe.id] ?: 0L)
        }
    }

    @Test fun `capacity failure awards nothing and retry keeps the exact outcome`() {
        val recipe = experiments.first()
        listOf(false, true).forEach { successful ->
            val state = prepared(recipe, successful).copy(inventory = mapOf("wood" to 750L))
            val saved = economyJson.encodeToString(state)
            assertEquals("ECONOMY_STORAGE_FULL", assertFailsWith<AuthFailure> { claim(state) }.code)
            assertEquals(saved, economyJson.encodeToString(state))
            val claimed = claim(state.copy(inventory = emptyMap()))
            assertEquals(recipe.seconds, claimed.progression.skills!!.cookingSeconds)
            assertEquals(successful, claimed.progression.skills.lastCooking!!.successful)
        }
    }

    @Test fun `ordinary recipes never roll and ids cannot bypass skill requirements`() {
        val normal = catalog.recipes.single { it.id == "cook_berry_tea" }
        assertNull(EconomySkills.prepare(supplied(normal.id), normal) { error("ordinary cooking cannot consume entropy") })
        val cooked = claim(apply(supplied(normal.id), "start_production", normal.id))
        assertEquals(normal.rewards, cooked.inventory)
        val blocked = supplied("experiment_river_aspic").copy(progression = EconomyProgression())
        assertEquals("ECONOMY_COOKING_SKILL", assertFailsWith<AuthFailure> { apply(blocked, "start_production", "experiment_river_aspic") }.code)
        val win = claim(prepared(experiments.first(), true)); val lose = claim(prepared(experiments.first(), false))
        assertTrue(win.progression.player!!.xp > lose.progression.player!!.xp)
    }

    @Test fun `hidden random foods never become mandatory generated order sources`() {
        val state = supplied().copy(progression = EconomyProgression(
            recipes = catalog.recipes.associate { it.id to 100L }, routes = catalog.explorations.associate { it.id to 100L }),
            fishing = EconomyFishing(catches = mapOf(catalog.fishing!!.fish.first().itemId to 100L)))
        val reachable = EconomyFood.obtainableOrderItems(state)
        experiments.forEach { recipe -> assertTrue(recipe.rewards.keys.none { it in reachable }, recipe.id) }
    }

    @Test fun `travel duration agrees with preview and only the hero trains frozen base work`() {
        val state = supplied().copy(inventory = emptyMap(), progression = EconomyProgression(skills = EconomyCraftSkills(travelSeconds = 2880000)))
        val route = catalog.explorations.single { it.id == "forest" }
        val started = apply(state, "start_exploration", route.id); val job = started.jobs.single()
        assertEquals(route.seconds, job.skillWorkSeconds)
        assertEquals(now.plusSeconds(EconomyFood.heroTrip(state, route.seconds).seconds).toString(), job.finishesAt)
        val claimed = claim(started)
        assertEquals(2880000 + route.seconds, claimed.progression.skills!!.travelSeconds)
        val mining = apply(claimed, "start_exploration", "quarry_stone", now.plusSeconds(86400))
        assertNull(mining.jobs.single().skillWorkSeconds)
        assertEquals(claimed.progression.skills.travelSeconds, claim(mining).progression.skills!!.travelSeconds)
    }

    @Test fun `legacy batches keep full paid practice and merges use maxima without stale notifications`() {
        val recipe = catalog.recipes.single { it.id == "cook_grilled_fish" }
        val state = supplied(recipe.id).copy(inventory = emptyMap(), jobs = listOf(EconomyJob(UUID.randomUUID().toString(), "production", "dryer", recipe.id,
            startedAt = now.toString(), finishesAt = now.plusSeconds(recipe.seconds * 3).toString(), rewards = mapOf("grilled_fish" to 3L),
            cost = EconomyCost(items = mapOf("fish_common" to 3L)), catalogVersion = 13)))
        assertEquals(recipe.seconds * 3, claim(state).progression.skills!!.cookingSeconds)
        assertEquals(EconomyCraftSkills(cookingSeconds = 1000, travelSeconds = 2000), EconomySkills.merge(
            EconomyCraftSkills(cookingSeconds = 1000, travelSeconds = 1), EconomyCraftSkills(cookingSeconds = 5, travelSeconds = 2000,
                lastCooking = EconomyCookingResult(UUID.randomUUID().toString(), experiments.first().id, true, now.toString()))))
    }
}
