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
            progression = EconomyProgression(skills = EconomyCraftSkills(buildingHistoryVersion = 1, cookingSeconds = catalog.skills!!.levels[(recipe.experiment?.requiredCookingLevel ?: 1) - 1].requiredSeconds)),
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
            val state = supplied().copy(progression = EconomyProgression(skills = EconomyCraftSkills(buildingHistoryVersion = 1, cookingSeconds = row.requiredSeconds, travelSeconds = row.requiredSeconds)))
            assertEquals(index + 1, EconomySkills.level(state, "cooking"))
            assertEquals(index + 1, EconomySkills.level(state, "travel"))
            assertTrue(EconomySkills.bonus(state, "travel") <= 500)
            assertTrue(EconomySkills.chance(state, experiments.first()) <= 9500)
        }
        assertNull(economyJson.decodeFromString<EconomyProgression>("{}").skills)
        assertFailsWith<IllegalArgumentException> { EconomyCraftSkills(buildingHistoryVersion = 1, cookingSeconds = -1) }
    }

    @Test fun `each experiment compensates failure at base skill and respects maximum skill gross value`() {
        assertEquals(7, experiments.size)
        fun value(items: Map<String, Long>) = items.entries.sumOf { (id, count) -> catalog.items.single { it.id == id }.baseSellPrice * count }.toDouble()
        experiments.forEach { recipe ->
            val work = recipe.seconds / 60.0 * catalog.timeEconomy!!.coinsPerMinute
            val cost = recipe.cost.coins + value(recipe.cost.items)
            val win = value(recipe.rewards); val fail = value(recipe.experiment!!.failureRewards)
            val base = recipe.experiment.successBps / 10000.0
            assertTrue(base * win + (1 - base) * fail - cost >= work, recipe.id)
            assertTrue(base * win + (1 - base) * fail - cost < work + 1, recipe.id)
            assertTrue(.95 * win + .05 * fail <= (cost + work) * 1.12 + 1, recipe.id)
            assertEquals(1L, recipe.rewards.values.sum())
            assertEquals(0L, recipe.experiment.failureRewards.values.sum())
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
        listOf(true).forEach { successful ->
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
        val state = supplied().copy(inventory = emptyMap(), progression = EconomyProgression(skills = EconomyCraftSkills(buildingHistoryVersion = 1, travelSeconds = 2880000)))
        val route = catalog.explorations.single { it.id == "forest" }
        val started = apply(state, "start_exploration", route.id); val job = started.jobs.single()
        assertEquals(route.seconds, job.skillWorkSeconds)
        assertEquals(now.plusSeconds(EconomyFood.heroTrip(state, route.seconds).seconds).toString(), job.finishesAt)
        val claimed = claim(started)
        assertEquals(2880000 + route.seconds, claimed.progression.skills!!.travelSeconds)
        val mining = apply(claimed, "start_exploration", "quarry_stone", now.plusSeconds(86400))
        assertEquals(catalog.explorations.single { it.id == "quarry_stone" }.seconds, mining.jobs.single().skillWorkSeconds)
        assertEquals(claimed.progression.skills.travelSeconds, claim(mining).progression.skills!!.travelSeconds)
    }

    @Test fun `legacy batches keep full paid practice and merges use maxima without stale notifications`() {
        val recipe = catalog.recipes.single { it.id == "cook_grilled_fish" }
        val state = supplied(recipe.id).copy(inventory = emptyMap(), jobs = listOf(EconomyJob(UUID.randomUUID().toString(), "production", "dryer", recipe.id,
            startedAt = now.toString(), finishesAt = now.plusSeconds(recipe.seconds * 3).toString(), rewards = mapOf("grilled_fish" to 3L),
            cost = EconomyCost(items = mapOf("fish_common" to 3L)), catalogVersion = 13)))
        assertEquals(recipe.seconds * 3, claim(state).progression.skills!!.cookingSeconds)
        assertEquals(EconomyCraftSkills(buildingHistoryVersion = 1, cookingSeconds = 1000, travelSeconds = 2000), EconomySkills.merge(
            EconomyCraftSkills(buildingHistoryVersion = 1, cookingSeconds = 1000, travelSeconds = 1), EconomyCraftSkills(buildingHistoryVersion = 1, cookingSeconds = 5, travelSeconds = 2000,
                lastCooking = EconomyCookingResult(UUID.randomUUID().toString(), experiments.first().id, true, now.toString()))))
    }

    @Test fun `all nine careers default safely preserve old work and merge by maximum`() {
        val old = economyJson.decodeFromString<EconomyCraftSkills>("""{"cookingSeconds":18000,"travelSeconds":54000}""")
        assertEquals(18000L, old.cookingSeconds); assertEquals(54000L, old.travelSeconds)
        EconomySkills.ids.forEach { id ->
            val max = 2880000L / if (id == "building") 8 else 1
            val skilled = economyJson.decodeFromString<EconomyCraftSkills>("""{"${id}Seconds":$max}""")
            val state = supplied().copy(progression = EconomyProgression(skills = skilled))
            assertEquals(10, EconomySkills.level(state, id), id)
            assertTrue(EconomySkills.bonus(state, id) <= if (id == "cooking") 1000 else if (id == "travel") 500 else 300)
            assertEquals(max, EconomySkills.seconds(EconomySkills.merge(old, skilled), id))
            assertFailsWith<IllegalArgumentException> { economyJson.decodeFromString<EconomyCraftSkills>("""{"${id}Seconds":-1}""") }
            if (id !in listOf("cooking", "travel")) assertEquals(0L, EconomySkills.seconds(old, id))
        }
    }

    @Test fun `production stations earn only their completed work with distinct bounded bonuses`() {
        listOf("workshop", "kiln", "garden", "woodlot").forEach { building ->
            val recipe = catalog.recipes.first { it.buildingId == building && !it.retired && it.experiment == null }
            val id = checkNotNull(EconomySkills.production(building))
            val skills = economyJson.decodeFromString<EconomyCraftSkills>("""{"buildingHistoryVersion":1,"${id}Seconds":2880000}""")
            val state = supplied(recipe.id).copy(progression = EconomyProgression(skills = skills,
                recipes = catalog.recipes.associate { it.id to 100L }))
            var started = apply(state, "start_production", recipe.id); val job = started.jobs.single()
            assertEquals(recipe.seconds, job.skillWorkSeconds)
            assertTrue(Instant.parse(job.finishesAt).isBefore(now.plusSeconds(recipe.seconds)), building)
            val cancelled = apply(started, "cancel_production", job.id, now.plusMillis(1))
            assertEquals(skills, cancelled.progression.skills)
            if (job.collection != null) started = apply(started, "start_collection", job.id, Instant.parse(job.finishesAt))
            val ready = Instant.parse(started.jobs.single().collection?.finishesAt ?: job.finishesAt)
            val claimed = apply(started, "claim_job", job.id, ready)
            assertEquals(2880000 + recipe.seconds, EconomySkills.seconds(claimed.progression.skills, id), id)
            EconomySkills.ids.filter { it != id }.forEach { other -> assertEquals(0L, EconomySkills.seconds(claimed.progression.skills, other)) }
        }
    }

    @Test fun `fishing uses its own speed and practice without subtracting previous travel`() {
        val route = catalog.explorations.single { it.id == "shore" }
        val state = supplied().copy(inventory = emptyMap(), progression = EconomyProgression(skills = EconomyCraftSkills(buildingHistoryVersion = 1, travelSeconds = 2880000, fishingSeconds = 2880000)))
        assertEquals("fishing", EconomySkills.exploration(route))
        val started = apply(state, "start_exploration", route.id)
        assertEquals(now.plusSeconds(EconomyFood.heroTrip(state, route.seconds, "fishing").seconds).toString(), started.jobs.single().finishesAt)
        val claimed = claim(started)
        assertEquals(2880000L, claimed.progression.skills!!.travelSeconds)
        assertEquals(2880000 + route.seconds, claimed.progression.skills.fishingSeconds)
    }

    @Test fun `partial mining claims train exactly delivered units and cancellation cannot train unfinished work`() {
        val state = supplied().copy(inventory = emptyMap())
        val route = catalog.explorations.single { it.id == "quarry_stone" }
        fun start() = EconomyRules.apply(state, EconomyCommand(UUID.randomUUID().toString(), "ABCD-EFGH-JKMP", 0, "start_exploration", route.id, 3), now).first
        val started = start(); val job = started.jobs.single(); val ready = Instant.parse(job.finishesAt)
        val full = claim(started)
        var partial = started
        repeat(3) { partial = apply(partial, "claim_mining_batch", job.id, ready) }
        assertEquals(full.progression.skills, partial.progression.skills)
        assertEquals(route.seconds * 3, full.progression.skills!!.miningSeconds)
        val firstReady = now.plusSeconds(job.miningBatch!!.unitSeconds)
        val stopped = apply(started, "cancel_exploration", job.id, firstReady)
        assertEquals(0L, stopped.progression.skills?.miningSeconds ?: 0L)
        assertEquals(route.seconds, apply(stopped, "claim_job", job.id, firstReady).progression.skills!!.miningSeconds)
    }

    @Test fun `construction earns frozen baseline work on claim with the construction scale`() {
        val target = catalog.buildings.single { it.id == "warehouse" }.levels.single { it.level == 2 }
        val state = supplied().let { it.copy(buildings = it.buildings + ("warehouse" to 1), inventory = target.cost.items,
            progression = EconomyProgression(skills = EconomyCraftSkills(buildingHistoryVersion = 1, buildingSeconds = 360000))) }
        val started = apply(state, "start_construction", "warehouse"); val job = started.jobs.single()
        assertEquals(300, job.skillSpeedBps); assertEquals(target.seconds, job.skillWorkSeconds)
        assertEquals(now.plusSeconds(EconomySkills.workDuration(state, "building", target.seconds)).toString(), job.finishesAt)
        assertEquals(360000 + target.seconds, claim(started).progression.skills!!.buildingSeconds)
    }

    @Test fun `failed experiment gives zero items at full storage and cannot be cancelled after ready`() {
        val state = prepared(experiments.first(), false).copy(inventory = mapOf("wood" to 750L)); val job = state.jobs.single()
        assertTrue(job.rewards.isEmpty())
        assertFailsWith<AuthFailure> { apply(state, "cancel_production", job.id, Instant.parse(job.finishesAt)) }
        val claimed = claim(state)
        assertEquals(state.inventory, claimed.inventory)
        assertFalse(claimed.progression.skills!!.lastCooking!!.successful)
        assertEquals(experiments.first().seconds, claimed.progression.skills.cookingSeconds)
        assertFailsWith<AuthFailure> { apply(claimed, "claim_job", job.id, Instant.parse(job.finishesAt)) }
    }

    @Test fun `instant teaching harvest gives no gardening practice and cannot be repeated`() {
        val state = EconomyRules.initial()
        val started = apply(state, "start_tutorial_harvest", "grow_berries"); val job = started.jobs.single()
        assertEquals(0L, job.skillWorkSeconds)
        val collecting = apply(started, "start_collection", job.id, now.plusMillis(1))
        val claimed = apply(collecting, "claim_job", job.id, Instant.parse(collecting.jobs.single().collection!!.finishesAt))
        assertEquals(0L, claimed.progression.skills?.gatheringSeconds ?: 0L)
        assertFailsWith<AuthFailure> { apply(claimed, "start_tutorial_harvest", "grow_berries") }
    }


    private fun legacyForest(): EconomyState = supplied().copy(workshopStarterClaimed = true, progression = EconomyProgression())

    @Test fun `completed legacy forest projects its building career purely and seals history once`() {
        val state = legacyForest(); val saved = economyJson.encodeToString(state)
        val normalized = EconomySkills.normalized(state)
        assertEquals(474600L, normalized.progression.skills!!.buildingSeconds)
        assertEquals(1, normalized.progression.skills.buildingHistoryVersion)
        assertEquals(10, EconomySkills.level(state, "building"))
        assertEquals(saved, economyJson.encodeToString(state))
        assertEquals(normalized, EconomySkills.normalized(normalized))
        val recorded = state.copy(progression = EconomyProgression(skills = EconomyCraftSkills(buildingSeconds = 500000)))
        assertEquals(500000L, EconomySkills.normalized(recorded).progression.skills!!.buildingSeconds)
        val changed = catalog.copy(buildings = catalog.buildings.map { building -> building.copy(levels = building.levels.map { it.copy(seconds = it.seconds * 2) }) })
        assertEquals(474600L, EconomySkills.normalized(normalized, changed).progression.skills!!.buildingSeconds)
    }

    @Test fun `fresh and reset forests are sealed at zero while imported older buildings count`() {
        repeat(2) {
            val state = EconomyRules.initial()
            assertEquals(1, state.progression.skills!!.buildingHistoryVersion)
            assertEquals(0L, state.progression.skills.buildingSeconds)
            assertEquals(0L, EconomySkills.normalized(state.copy(buildings = state.buildings + ("warehouse" to 15))).progression.skills!!.buildingSeconds)
        }
        val imported = EconomyRules.initial(homeLevel = 3, workshopLevel = 1)
        assertEquals(9300L, imported.progression.skills!!.buildingSeconds)
        assertEquals(1, imported.progression.skills.buildingHistoryVersion)
        val free = legacyForest().copy(buildings = mapOf("home" to 1, "garden" to 1, "warehouse" to 1, "workshop" to 1))
        assertEquals(0L, EconomySkills.normalized(free).progression.skills!!.buildingSeconds)
        assertEquals(180L, EconomySkills.normalized(free.copy(buildings = free.buildings + ("dryer" to 1))).progression.skills!!.buildingSeconds)
    }

    @Test fun `unclaimed legacy construction counts only after its first confirmed completion`() {
        val target = catalog.buildings.single { it.id == "warehouse" }.levels.single { it.level == 14 }
        val old = legacyForest().let { it.copy(buildings = it.buildings + ("warehouse" to 13)) }
        val job = EconomyJob(UUID.randomUUID().toString(), "construction", "warehouse", targetLevel = 14, startedAt = now.toString(),
            finishesAt = now.plusSeconds(target.seconds).toString(), cost = target.cost, catalogVersion = 15)
        val state = old.copy(jobs = listOf(job)); val saved = economyJson.encodeToString(state)
        assertEquals(445800L, EconomySkills.normalized(state).progression.skills!!.buildingSeconds)
        assertFailsWith<AuthFailure> { apply(state, "claim_job", job.id) }
        assertEquals(saved, economyJson.encodeToString(state))
        val claimed = claim(state)
        assertEquals(445800 + target.seconds, claimed.progression.skills!!.buildingSeconds)
        assertEquals(1, claimed.progression.skills.buildingHistoryVersion)
        assertEquals(claimed, EconomySkills.normalized(claimed))
        assertFailsWith<AuthFailure> { apply(claimed, "claim_job", job.id, Instant.parse(job.finishesAt)) }
    }

    @Test fun `paid and ready construction acceleration grant exactly the same skill as claiming`() {
        listOf(false, true).forEach { ready ->
            val target = catalog.buildings.single { it.id == "warehouse" }.levels.single { it.level == 2 }
            val base = supplied().let { it.copy(buildings = it.buildings + ("warehouse" to 1), inventory = target.cost.items, wallet = it.wallet.copy(pearls = 50000)) }
            val started = apply(base, "start_construction", "warehouse"); val job = started.jobs.single()
            val command = EconomyCommand(UUID.randomUUID().toString(), "ABCD-EFGH-JKMP", 0, "speedup_construction", job.id, 1, if (ready) 0 else 50000)
            val at = if (ready) Instant.parse(job.finishesAt) else now.plusMillis(1)
            val done = EconomyRules.apply(started, command, at).first
            assertEquals(target.seconds, done.progression.skills!!.buildingSeconds)
            assertEquals(2, done.buildings["warehouse"])
            assertEquals(started.progression.player, done.progression.player)
            assertFailsWith<AuthFailure> { EconomyRules.apply(done, command, at) }
        }
    }

    @Test fun `merging separately normalized legacy careers takes maximum and cannot reprice combined ownership`() {
        val left = legacyForest().let { it.copy(buildings = it.buildings + ("warehouse" to 13)) }
        val right = legacyForest().let { it.copy(buildings = it.buildings + ("garden" to 1)) }
        val a = EconomySkills.normalized(left); val b = EconomySkills.normalized(right)
        val merged = EconomyCollectionProgress.merge(a.progression, b.progression)
        val expected = maxOf(a.progression.skills!!.buildingSeconds, b.progression.skills!!.buildingSeconds)
        assertEquals(expected, merged.skills!!.buildingSeconds)
        assertEquals(1, merged.skills.buildingHistoryVersion)
        val combined = left.copy(buildings = catalog.buildings.associate { it.id to maxOf(left.buildings[it.id] ?: 0, right.buildings[it.id] ?: 0) }, progression = merged)
        assertEquals(expected, EconomySkills.normalized(combined).progression.skills!!.buildingSeconds)
        assertEquals(expected, EconomyCollectionProgress.merge(merged, merged).skills!!.buildingSeconds)
    }

}
