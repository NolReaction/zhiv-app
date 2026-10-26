package ru.zhiv.economy

import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.encodeToJsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import org.junit.jupiter.api.Test
import ru.zhiv.auth.AuthFailure
import java.time.Instant
import java.util.UUID
import kotlin.test.*

class EconomyMinerTest {
    private val now = Instant.parse("2026-10-14T12:00:00Z")
    private fun command(action: String, target: String) = EconomyCommand(UUID.randomUUID().toString(), "ABCD-EFGH-JKMP", 0, action, target)
    private fun apply(state: EconomyState, action: String, target: String, at: Instant = now) = EconomyRules.apply(state, command(action, target), at).first
    private fun ready(job: EconomyJob) = Instant.parse(job.finishesAt)
    private fun player(home: Int = 3) = EconomyRules.initial().let { state -> state.copy(wallet = EconomyWallet(100_000),
        inventory = mapOf("grilled_fish" to 2L, "wood" to 10L, "dried_berries" to 2L, "smoked_fish" to 2L),
        buildings = state.buildings + mapOf("home" to home, "quarry" to 2, "kiln" to 1, "workshop" to 1, "woodlot" to 1),
        tutorialOrder = state.tutorialOrder.copy(step = 4, completed = true)) }
    private fun fails(code: String, block: () -> Unit) = assertEquals(code, assertFailsWith<AuthFailure>(block = block).code)

    @Test fun `miner runs beside fishing and berry collection with one independently occupied queue`() {
        val starting = player(2)
        val fishing = apply(starting, "start_fishing", "shore")
        assertEquals("mochlik", fishing.jobs.single().actorId)
        var parallel = apply(fishing, "start_exploration", "quarry_stone")
        val mine = parallel.jobs.single { it.actorId == "miner" }
        assertEquals(2, parallel.jobs.size)
        for (at in listOf(now, ready(mine).plusSeconds(600))) fails("ECONOMY_MINER_BUSY") {
            apply(parallel, "start_exploration", "quarry_clay", at) }
        fails("ECONOMY_EXPLORER_BUSY") { apply(parallel, "start_exploration", "forest") }
        val fish = parallel.jobs.single { it.actorId == "mochlik" }
        val at = maxOf(ready(fish), ready(mine))
        parallel = apply(parallel, "claim_job", fish.id, at)
        val growing = apply(parallel, "start_production", "grow_berries", at)
        val berries = growing.jobs.single { it.targetId == "garden" }
        val collecting = apply(growing, "start_collection", berries.id, ready(berries))
        assertNotNull(collecting.jobs.single { it.id == berries.id }.collection!!.startedAt)
        fails("ECONOMY_MINER_BUSY") { apply(collecting, "start_exploration", "quarry_stone", ready(berries)) }
        val delivered = apply(collecting, "claim_job", mine.id, ready(berries))
        assertEquals(2, apply(delivered, "start_exploration", "quarry_clay", ready(berries)).jobs.size)
    }

    @Test fun `mining neither consumes hero food nor prevents eating or ordinary departure`() {
        val initial = player(2)
        val eating = apply(initial, "eat_food", "grilled_fish")
        val mine = apply(eating, "start_exploration", "quarry_stone")
        assertEquals("grilled_fish", mine.food.heroMeal)
        assertNull(mine.jobs.single().meal)
        assertEquals(EconomyRules.catalog.explorations.single { it.id == "quarry_stone" }.seconds,
            ready(mine.jobs.single()).epochSecond - now.epochSecond)
        val departing = apply(mine, "start_exploration", "forest")
        assertEquals(eating.food.heroMealEffect!!.remainingWorkSeconds - EconomyRules.catalog.explorations.single { it.id == "forest" }.seconds,
            departing.food.heroMealEffect?.remainingWorkSeconds)
        assertEquals("grilled_fish", departing.jobs.single { it.actorId == "mochlik" }.meal!!.itemId)
        val noMeal = apply(initial, "start_exploration", "quarry_stone")
        assertEquals("grilled_fish", apply(noMeal, "eat_food", "grilled_fish").food.heroMeal)
        assertFalse(EconomyRules.commandUsesActor(command("start_exploration", "quarry_stone")))
        assertTrue(EconomyRules.commandUsesActor(command("start_fishing", "shore")))
    }

    @Test fun `legacy mining without an actor remains Mochlik and retains frozen costs output and time`() {
        val old = EconomyJob(UUID.randomUUID().toString(), "exploration", "quarry_stone", startedAt = now.toString(),
            finishesAt = now.plusSeconds(1800).toString(), rewards = mapOf("stone" to 8L), cost = EconomyCost(25, mapOf("rope" to 2L)), catalogVersion = 6)
        val json = economyJson.encodeToJsonElement(old).jsonObject
        val restored = economyJson.decodeFromString<EconomyJob>(JsonObject(json - "actorId").toString())
        assertNull(restored.actorId); assertFalse(EconomyRules.isMinerJob(restored))
        val legacy = player(2).copy(jobs = listOf(restored), inventory = emptyMap())
        fails("ECONOMY_EXPLORER_BUSY") { apply(legacy, "start_exploration", "forest") }
        val alongside = apply(legacy, "start_exploration", "quarry_clay")
        assertEquals(2, alongside.jobs.size)
        assertEquals(restored, alongside.jobs.first())
        val claimed = apply(alongside, "claim_job", restored.id, ready(restored))
        assertEquals(8L, claimed.inventory["stone"])
        assertEquals(legacy.wallet, claimed.wallet)
        assertEquals(1, claimed.jobs.size)
        val cancelled = apply(legacy, "cancel_exploration", restored.id)
        assertEquals(legacy.wallet, cancelled.wallet); assertTrue(cancelled.inventory.isEmpty())
    }

    @Test fun `saved miner queue blocks quarry upgrades even when its old route is no longer in the catalog`() {
        val original = player(2)
        val upgrade = EconomyRules.catalog.buildings.single { it.id == "quarry" }.levels.single { it.level == 2 }
        val saved = EconomyJob(UUID.randomUUID().toString(), "exploration", "retired_miner_route", actorId = "miner",
            startedAt = now.minusSeconds(1000).toString(), finishesAt = now.toString(), rewards = mapOf("stone" to 3L))
        val state = original.copy(buildings = original.buildings + ("quarry" to 1), inventory = upgrade.cost.items, jobs = listOf(saved))
        fails("ECONOMY_BUILDING_BUSY") { apply(state, "start_construction", "quarry") }
        val cancelled = apply(state, "cancel_exploration", saved.id)
        assertEquals(2, apply(cancelled, "start_construction", "quarry").jobs.single().targetLevel)
    }

    @Test fun `miner cancellation refunds only its saved cost and neither delivery nor cancellation changes the other rare clock`() {
        val heroClock = EconomyRareDropClock(remainingSeconds = 1000, itemId = "moon_crystal")
        val minerClock = EconomyRareDropClock(remainingSeconds = 1500, itemId = "moon_crystal")
        val paid = EconomyJob(UUID.randomUUID().toString(), "exploration", "retired_miner_route", actorId = "miner",
            startedAt = now.toString(), finishesAt = now.plusSeconds(300).toString(), rewards = mapOf("stone" to 9L),
            cost = EconomyCost(73, mapOf("rope" to 2L)))
        val state = player().copy(wallet = EconomyWallet(10), inventory = emptyMap(), jobs = listOf(paid),
            rareDropState = heroClock, minerRareDropState = minerClock)
        val cancelled = apply(state, "cancel_exploration", paid.id)
        assertEquals(EconomyWallet(83), cancelled.wallet); assertEquals(mapOf("rope" to 2L), cancelled.inventory)
        assertTrue(cancelled.jobs.isEmpty()); assertEquals(state.progression, cancelled.progression)
        assertEquals(heroClock, cancelled.rareDropState); assertEquals(minerClock, cancelled.minerRareDropState)
        val delivered = apply(state, "claim_job", paid.id, ready(paid))
        assertEquals(EconomyWallet(10), delivered.wallet); assertEquals(mapOf("stone" to 9L), delivered.inventory)
        assertEquals(heroClock, delivered.rareDropState); assertEquals(minerClock, delivered.minerRareDropState)
        val full = state.copy(inventory = mapOf("wood" to 50L))
        fails("ECONOMY_STORAGE_FULL") { apply(full, "cancel_exploration", paid.id) }
        assertEquals(paid, full.jobs.single())
        fails("ECONOMY_CAPACITY") { apply(state.copy(wallet = EconomyWallet(ECONOMY_MAX_BALANCE)), "cancel_exploration", paid.id) }
    }

    @Test fun `parallel rare finds settle independently in either claim order and private miner clock never enters a view`() {
        val rareItems = EconomyRules.catalog.rareDrops!!.itemIds
        for (minerFirst in listOf(true, false)) {
            val state = player().copy(inventory = emptyMap(),
                rareDropState = EconomyRareDropClock(remainingSeconds = 1, itemId = rareItems[0]),
                minerRareDropState = EconomyRareDropClock(remainingSeconds = 1, itemId = rareItems[1]))
            val mining = apply(state, "start_exploration", "quarry_stone")
            var both = apply(mining, "start_exploration", "forest")
            val hero = both.jobs.single { it.actorId == "mochlik" }; val miner = both.jobs.single { it.actorId == "miner" }
            assertEquals(1L, hero.rewards[rareItems[0]]); assertEquals(1L, miner.rewards[rareItems[1]])
            val at = maxOf(ready(hero), ready(miner))
            val first = if (minerFirst) miner else hero; val second = if (minerFirst) hero else miner
            val preserved = if (minerFirst) both.rareDropState else both.minerRareDropState
            both = apply(both, "claim_job", first.id, at)
            assertEquals(preserved, if (minerFirst) both.rareDropState else both.minerRareDropState)
            both = apply(both, "claim_job", second.id, at)
            assertEquals(1L, both.inventory[rareItems[0]]); assertEquals(1L, both.inventory[rareItems[1]])
            assertTrue(both.jobs.isEmpty())
            val view = EconomyView("ABCD-EFGH-JKMP", 0, at.toString(), both.wallet, both.inventory, both.buildings,
                both.jobs, both.migration, EconomyRules.catalog, EconomyRules.storage(both), stageOrders = both.stageOrders)
            val public = economyJson.encodeToJsonElement(view).jsonObject
            assertFalse("minerRareDropState" in public); assertFalse("rareDropState" in public)
        }
    }

    @Test fun `legacy overlapping paid jobs can be claimed but new work cannot exceed eighteen queues`() {
        val recipes = mapOf("garden" to "grow_berries", "woodlot" to "gather_wood", "workshop" to "make_planks",
            "dryer" to "cook_compote", "kiln" to "make_charcoal")
        val production = recipes.flatMap { (station, recipe) ->
            val definition = EconomyRules.catalog.recipes.single { it.id == recipe }
            List(3) { EconomyJob(UUID.randomUUID().toString(), "production", station, recipe,
                startedAt = now.minusSeconds(600).toString(), finishesAt = now.toString(),
                rewards = definition.rewards, cost = definition.cost, catalogVersion = 6) }
        }
        val heroes = List(2) { EconomyJob(UUID.randomUUID().toString(), "exploration", "forest",
            startedAt = now.minusSeconds(1800).toString(), finishesAt = now.toString(), rewards = mapOf("wood" to 2L), catalogVersion = 6) }
        val miner = EconomyJob(UUID.randomUUID().toString(), "exploration", "quarry_stone", actorId = "miner",
            startedAt = now.toString(), finishesAt = now.plusSeconds(180).toString(), rewards = mapOf("stone" to 1L), catalogVersion = 7)
        val upgrade = EconomyRules.catalog.buildings.single { it.id == "warehouse" }.levels.single { it.level == 2 }
        val full = player(2).copy(inventory = upgrade.cost.items, jobs = production + heroes + miner,
            productionSlots = recipes.keys.associateWith { 3 }, food = EconomyFoodState(builderMeal = "grilled_fish"))
        assertEquals(18, full.jobs.size)
        val before = economyJson.encodeToString(full)
        fails("ECONOMY_JOBS_CAPACITY") { apply(full, "start_construction", "warehouse") }
        assertEquals(before, economyJson.encodeToString(full), "No payment, meal or paid job is lost")
        val freed = apply(full, "claim_job", production.first().id)
        assertEquals(17, freed.jobs.size)
        val started = apply(freed, "start_construction", "warehouse")
        assertEquals(18, started.jobs.size)
        assertTrue(started.jobs.any { it.actorId == "miner" })
        assertEquals(2, started.jobs.count { it.kind == "exploration" && it.actorId == null })
    }

}
