package ru.zhiv.economy

import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.*
import org.junit.jupiter.api.Test
import ru.zhiv.auth.AuthFailure
import java.time.Duration
import java.time.Instant
import java.util.UUID
import kotlin.test.*

class EconomyRulesTest {
    private val now = Instant.parse("2026-10-01T00:00:00Z")
    private fun command(action: String, target: String, quantity: Long = 1) =
        EconomyCommand(UUID.randomUUID().toString(), "ABCD-EFGH-JKMP", 0, action, target, quantity)
    private fun apply(state: EconomyState, action: String, target: String, quantity: Long = 1, at: Instant = now) =
        EconomyRules.apply(state, command(action, target, quantity), at).first
    private fun stocked(): EconomyState = EconomyRules.initial().copy(wallet = EconomyWallet(100_000),
        inventory = EconomyFishInventory.items(EconomyRules.catalog.items.associate { it.id to 100L }),
        buildings = EconomyRules.initial().buildings + ("warehouse" to 5),
        tutorialOrder = EconomyRules.initial().tutorialOrder.copy(completed = true, step = 4))
    private fun requirements(state: EconomyState, home: Int, buildings: Map<String, Int>) = state.copy(
        buildings = state.buildings + buildings.mapValues { (id, level) -> maxOf(state.buildings[id] ?: 0, level) } +
            ("home" to maxOf(state.buildings["home"] ?: 1, home)),
        tutorialOrder = state.tutorialOrder.copy(completed = true, step = 4))

    @Test fun `new players receive fixed supplies and retain renewable gathering without spending`() {
        val start = EconomyRules.initial()
        assertEquals(EconomyWallet(100, 0), start.wallet)
        assertEquals(mapOf("wood" to 3L, "stone" to 5L), start.inventory)
        val garden = apply(start, "start_production", "grow_berries")
        val travelling = apply(garden, "start_exploration", "forest")
        assertEquals(2, travelling.jobs.size)
        val gardenJob = travelling.jobs.first { it.kind == "production" }
        val readyAt = travelling.jobs.maxOf { Instant.parse(it.finishesAt) }
        val collecting = apply(travelling, "start_collection", gardenJob.id, at = readyAt)
        val harvest = apply(collecting, "claim_job", gardenJob.id, at = readyAt.plusSeconds(checkNotNull(gardenJob.collection).seconds))
        val berryCount = gardenJob.rewards.getValue("berries")
        val sold = apply(harvest, "sell", "berries", berryCount)
        assertEquals(start.wallet.coins + EconomyRules.localSellPrice(EconomyRules.catalog.items.single { it.id == "berries" }.baseSellPrice, berryCount, itemId = "berries"), sold.wallet.coins)
        assertEquals(0L, sold.inventory["berries"] ?: 0)
        assertEquals(1, sold.jobs.size)
    }

    @Test fun `free gathering rejects bulk orders without spending`() {
        val initial = EconomyRules.initial()
        assertEquals("INVALID_ECONOMY_COMMAND", assertFailsWith<AuthFailure> {
            apply(initial, "start_production", "grow_berries", 2)
        }.code)
        assertEquals(EconomyRules.initial(), initial)
    }

    @Test fun `first stage recipes produce one item and strawberry unlock waits for claimed compote`() {
        val seconds = mapOf("grow_berries" to 60L, "grow_strawberries" to 300L, "gather_wood" to 180L,
            "make_planks" to 120L, "cook_compote" to 180L, "cook_grilled_fish" to 180L)
        val supplied = EconomyRules.initial().copy(inventory = mapOf("berries" to 2L, "wood" to 1L, "fish_common" to 1L),
            buildings = EconomyRules.initial().buildings + mapOf("woodlot" to 1, "workshop" to 1, "dryer" to 1))
        for ((id, duration) in seconds) {
            val recipe = EconomyRules.catalog.recipes.single { it.id == id }
            assertEquals(duration, recipe.seconds, id)
            assertEquals(1, recipe.maxBatch, id)
            assertEquals(1L, recipe.rewards.values.sum(), id)
            assertEquals("INVALID_ECONOMY_COMMAND", assertFailsWith<AuthFailure> {
                apply(supplied, "start_production", id, 2)
            }.code, id)
        }
        assertEquals("ECONOMY_RECIPE_REQUIRED", assertFailsWith<AuthFailure> {
            apply(supplied, "start_production", "grow_strawberries")
        }.code)
        val cooking = apply(supplied, "start_production", "cook_compote")
        val job = cooking.jobs.single()
        assertEquals("ECONOMY_RECIPE_REQUIRED", assertFailsWith<AuthFailure> {
            apply(cooking, "start_production", "grow_strawberries", at = Instant.parse(job.finishesAt))
        }.code)
        val claimed = apply(cooking, "claim_job", job.id, at = Instant.parse(job.finishesAt))
        assertEquals(1L, claimed.progression.recipes["cook_compote"])
        val growing = apply(claimed, "start_production", "grow_strawberries", at = Instant.parse(job.finishesAt))
        assertEquals(mapOf("strawberries" to 1L), growing.jobs.single().rewards)
    }

    @Test fun `berry recipes snapshot a separate server timed collection and deliver locked rewards only after it finishes`() {
        val berryRecipes = EconomyRules.catalog.recipes.filter { it.buildingId == "garden" && (it.rewards["berries"] ?: 0L) > 0L }
        assertEquals(setOf("grow_berries", "grow_berries_large", "garden_season"), berryRecipes.map { it.id }.toSet())
        assertEquals(EconomyCollectionSpec("berry_harvest", 8), EconomyRules.catalog.recipes.single { it.id == "grow_strawberries" }.collection)
        for (recipe in berryRecipes) {
            assertEquals(EconomyCollectionSpec("berry_harvest", 8), recipe.collection)
            assertEquals(1, recipe.maxBatch)
            assertEquals(mapOf("berries" to 1L), recipe.rewards)
        }
        val started = apply(EconomyRules.initial(), "start_production", "grow_berries", 1)
        val job = started.jobs.single()
        assertEquals(EconomyCollection("berry_harvest", 8, null, null), job.collection)
        val ripeAt = Instant.parse(job.finishesAt)
        assertEquals("ECONOMY_JOB_NOT_READY", assertFailsWith<AuthFailure> {
            apply(started, "start_collection", job.id, at = ripeAt.minusNanos(1))
        }.code)
        assertEquals("ECONOMY_COLLECTION_REQUIRED", assertFailsWith<AuthFailure> {
            apply(started, "claim_job", job.id, at = ripeAt.plusSeconds(3600))
        }.code)
        val collecting = apply(started, "start_collection", job.id, at = ripeAt)
        val collection = checkNotNull(collecting.jobs.single().collection)
        assertEquals(ripeAt.toString(), collection.startedAt)
        assertEquals(ripeAt.plusSeconds(8).toString(), collection.finishesAt)
        assertEquals(started.wallet, collecting.wallet)
        assertEquals(started.inventory, collecting.inventory)
        assertEquals(job.rewards, collecting.jobs.single().rewards)
        assertEquals("ECONOMY_COLLECTION_STARTED", assertFailsWith<AuthFailure> {
            apply(collecting, "start_collection", job.id, at = ripeAt.plusSeconds(9))
        }.code)
        assertEquals("ECONOMY_COLLECTION_NOT_READY", assertFailsWith<AuthFailure> {
            apply(collecting, "claim_job", job.id, at = ripeAt.plusSeconds(8).minusNanos(1))
        }.code)
        val claimed = apply(collecting, "claim_job", job.id, at = ripeAt.plusSeconds(8))
        assertEquals(started.inventory + job.rewards, claimed.inventory)
        assertTrue(claimed.jobs.isEmpty())
        assertEquals("ECONOMY_JOB_GONE", assertFailsWith<AuthFailure> {
            apply(claimed, "claim_job", job.id, at = ripeAt.plusSeconds(8))
        }.code)
    }

    @Test fun `harvest and exploration cannot use the hero together but returned journeys no longer block collection`() {
        val growing = apply(EconomyRules.initial(), "start_production", "grow_berries")
        val job = growing.jobs.single()
        val ripeAt = Instant.parse(job.finishesAt)
        val exploration = EconomyJob(UUID.randomUUID().toString(), "exploration", "forest", startedAt = now.toString(),
            finishesAt = ripeAt.plusSeconds(60).toString())
        assertEquals("ECONOMY_EXPLORER_BUSY", assertFailsWith<AuthFailure> {
            apply(growing.copy(jobs = growing.jobs + exploration), "start_collection", job.id, at = ripeAt)
        }.code)
        val returned = growing.copy(jobs = growing.jobs + exploration.copy(finishesAt = ripeAt.toString()))
        val collecting = apply(returned, "start_collection", job.id, at = ripeAt)
        assertNotNull(collecting.jobs.first().collection?.startedAt)
        for (at in listOf(ripeAt, ripeAt.plusSeconds(60))) assertEquals("ECONOMY_COLLECTOR_BUSY", assertFailsWith<AuthFailure> {
            apply(collecting, "start_exploration", "forest", at = at)
        }.code, "an unclaimed collection retains ownership after its minimum duration")
        val other = job.copy(id = UUID.randomUUID().toString())
        assertEquals("ECONOMY_COLLECTOR_BUSY", assertFailsWith<AuthFailure> {
            apply(collecting.copy(jobs = collecting.jobs + other), "start_collection", other.id, at = ripeAt.plusSeconds(60))
        }.code)
    }

    @Test fun `collection preflight includes market escrow and claim rechecks capacity without consuming the harvest`() {
        val started = apply(EconomyRules.initial(), "start_production", "grow_berries")
        val job = started.jobs.single()
        val readyAt = Instant.parse(job.finishesAt)
        val capacity = EconomyRules.storage(started).capacity
        val nearlyFull = started.copy(inventory = mapOf("wood" to capacity - 10))
        val request = command("start_collection", job.id)
        assertEquals("ECONOMY_STORAGE_FULL", assertFailsWith<AuthFailure> {
            EconomyRules.apply(nearlyFull, request, readyAt, mapOf("stone" to 10L))
        }.code)
        assertEquals("ECONOMY_CAPACITY", assertFailsWith<AuthFailure> {
            EconomyRules.apply(started, request, readyAt, mapOf("berries" to ECONOMY_MAX_ITEMS))
        }.code)
        assertNull(started.jobs.single().collection?.startedAt)
        val collecting = EconomyRules.apply(started, request, readyAt).first
        val filled = collecting.copy(inventory = mapOf("wood" to capacity))
        assertEquals("ECONOMY_STORAGE_FULL", assertFailsWith<AuthFailure> {
            apply(filled, "claim_job", job.id, at = readyAt.plusSeconds(8))
        }.code)
        assertEquals(collecting.jobs, filled.jobs)
        val freed = apply(filled, "sell", "wood", job.rewards.values.sum(), readyAt.plusSeconds(8))
        val claimed = apply(freed, "claim_job", job.id, at = readyAt.plusSeconds(8))
        assertEquals(capacity, EconomyRules.storage(claimed).used)
    }

    @Test fun `legacy berry jobs without collection remain directly claimable and can opt in without replacing rewards`() {
        val legacy = EconomyJob(UUID.randomUUID().toString(), "production", "garden", "grow_berries", startedAt = now.minusSeconds(60).toString(),
            finishesAt = now.toString(), rewards = mapOf("berries" to 7L), catalogVersion = 1)
        val encoded = economyJson.encodeToJsonElement(legacy).jsonObject
        val restored = economyJson.decodeFromJsonElement<EconomyJob>(JsonObject(encoded - "collection"))
        assertNull(restored.collection)
        val initial = EconomyRules.initial().copy(jobs = listOf(restored))
        assertEquals(7L, apply(initial, "claim_job", legacy.id).inventory["berries"])
        val collecting = apply(initial, "start_collection", legacy.id)
        assertEquals(legacy.rewards, collecting.jobs.single().rewards)
        assertEquals(8L, collecting.jobs.single().collection?.seconds)
        assertEquals(7L, apply(collecting, "claim_job", legacy.id, at = now.plusSeconds(8)).inventory["berries"])
        val locked = legacy.copy(recipeId = "retired-berry-recipe", collection = EconomyCollection("berry_harvest", 11, null, null))
        val original = initial.copy(jobs = listOf(locked))
        assertEquals(now.plusSeconds(11).toString(), apply(original, "start_collection", locked.id).jobs.single().collection?.finishesAt)
    }

    @Test fun `collection validates job kind command fields and persisted timing pairs`() {
        val started = apply(EconomyRules.initial(), "start_production", "grow_berries")
        val job = started.jobs.single()
        val at = Instant.parse(job.finishesAt)
        val request = command("start_collection", job.id)
        for (invalid in listOf(request.copy(quantity = 2), request.copy(totalPrice = 1)))
            assertEquals("INVALID_ECONOMY_COMMAND", assertFailsWith<AuthFailure> { EconomyRules.apply(started, invalid, at) }.code)
        for (invalid in listOf(job.copy(kind = "construction", collection = null), job.copy(targetId = "workshop", collection = null), job.copy(rewards = mapOf("wood" to 1L), collection = null)))
            assertEquals("ECONOMY_COLLECTION_KIND", assertFailsWith<AuthFailure> { EconomyRules.apply(started.copy(jobs = listOf(invalid)), request, at) }.code)
        assertEquals("ECONOMY_JOB_GONE", assertFailsWith<AuthFailure> { EconomyRules.apply(started, request.copy(targetId = UUID.randomUUID().toString()), at) }.code)
        val persistedJob = economyJson.encodeToJsonElement(job).jsonObject
        for (patch in listOf(mapOf("kind" to JsonPrimitive("construction")), mapOf("targetId" to JsonPrimitive("workshop")),
            mapOf("rewards" to buildJsonObject { put("wood", 1) })))
            assertFails { economyJson.decodeFromJsonElement<EconomyJob>(JsonObject(persistedJob + patch)) }
        val recipe = EconomyRules.catalog.recipes.single { it.id == "grow_berries" }
        val persistedRecipe = economyJson.encodeToJsonElement(recipe).jsonObject
        for (patch in listOf(mapOf("buildingId" to JsonPrimitive("workshop")), mapOf("rewards" to JsonObject(emptyMap()))))
            assertFails { economyJson.decodeFromJsonElement<EconomyRecipe>(JsonObject(persistedRecipe + patch)) }
        val json = economyJson.encodeToJsonElement(request).jsonObject
        for (field in listOf("collection", "startedAt", "finishesAt", "rewards"))
            assertFailsWith<AuthFailure> { decodeEconomyCommand(JsonObject(json + (field to JsonPrimitive(8)))) }
        for (raw in listOf(
            """{"kind":"berry_harvest","seconds":8,"startedAt":"2026-10-01T00:00:00Z","finishesAt":null}""",
            """{"kind":"berry_harvest","seconds":8,"startedAt":"2026-10-01T00:00:00Z","finishesAt":"2026-10-01T00:00:07Z"}""",
            """{"kind":"berry_harvest","seconds":0,"startedAt":null,"finishesAt":null}""",
            """{"kind":"free_items","seconds":8,"startedAt":null,"finishesAt":null}""",
        )) assertFails { economyJson.decodeFromString<EconomyCollection>(raw) }
    }

    @Test fun `new quarry and kiln construction waits for home two even with enough materials`() {
        val quarryState = stocked()
        val kilnState = quarryState.copy(buildings = quarryState.buildings + mapOf("quarry" to 1, "workshop" to 1))
        for ((target, state) in listOf("quarry" to quarryState, "kiln" to kilnState)) {
            assertEquals("ECONOMY_HOME_REQUIRED", assertFailsWith<AuthFailure> {
                apply(state, "start_construction", target)
            }.code, target)
            assertEquals(0, state.buildings[target])
            assertTrue(state.jobs.isEmpty())
        }
    }

    @Test fun `an empty account recovers supplies and completes both courses before home three`() {
        var state = EconomyRules.initial().copy(wallet = EconomyWallet(), inventory = emptyMap())
        var at = now
        fun complete(action: String, target: String) {
            var started = apply(state, action, target, at = at)
            val job = started.jobs.single()
            at = Instant.parse(job.finishesAt)
            job.collection?.let {
                started = apply(started, "start_collection", job.id, at = at)
                at = at.plusSeconds(it.seconds)
            }
            state = apply(started, "claim_job", job.id, at = at)
        }
        fun collect(recipeId: String, itemId: String, needed: Long) {
            while ((state.inventory[itemId] ?: 0L) < needed) complete("start_production", recipeId)
        }
        fun earn(needed: Long) {
            while (state.wallet.coins < needed) {
                complete("start_production", "grow_berries")
                state = apply(state, "sell", "berries", 1, at)
            }
        }
        fun order() {
            state = apply(state, "complete_resident_order", checkNotNull(state.tutorialOrder.terms).id, at = at)
        }

        complete("start_exploration", "forest")
        collect("grow_berries", "berries", 2)
        order()
        complete("start_construction", "woodlot")
        collect("gather_wood", "wood", 2)
        order()
        complete("start_construction", "dryer")
        collect("grow_berries", "berries", 4)
        repeat(2) { complete("start_production", "cook_compote") }
        order()
        collect("gather_wood", "wood", 2)
        complete("start_construction", "workshop")
        collect("gather_wood", "wood", 2)
        repeat(2) { complete("start_production", "make_planks") }
        order()
        assertTrue(state.tutorialOrder.completed)
        assertEquals(4, state.tutorialOrder.step)
        complete("start_exploration", "forest")
        collect("gather_wood", "wood", 5)
        repeat(2) { complete("start_production", "make_planks") }
        earn(250)
        assertEquals(0, state.buildings["quarry"])
        assertEquals(0, state.buildings["kiln"])
        complete("start_construction", "home")
        assertEquals(2, state.buildings["home"])
        assertEquals(0, state.buildings["quarry"])
        assertEquals(0, state.buildings["kiln"])

        val shore = EconomyRules.catalog.explorations.single { it.id == "shore" }
        val fishSeed = (1..100).map { "recovery-common-$it" }.first { candidate ->
            (0 until shore.rewards.getValue("fish").toInt()).all { index ->
                EconomyFishInventory.itemId(EconomyRules.selectFishingCatch(candidate, "reed_rod", null, "bare_hook", index)) == "fish_common"
            }
        }
        fun obtain(itemId: String, amount: Long) {
            val production = mapOf("wood" to "gather_wood", "fiber" to "gather_fiber", "planks" to "make_planks",
                "rope" to "make_rope", "charcoal" to "make_charcoal", "bricks" to "fire_bricks", "grilled_fish" to "cook_grilled_fish")
            while ((state.inventory[itemId] ?: 0L) < amount) {
                if (itemId == "fish_common") {
                    state = state.copy(fishingCastSeed = fishSeed)
                    complete("start_fishing", "shore")
                }
                else if (itemId in setOf("stone", "clay")) complete("start_exploration", "quarry_$itemId")
                else {
                    val recipe = EconomyRules.catalog.recipes.single { it.id == production.getValue(itemId) }
                    recipe.cost.items.forEach { (id, count) -> obtain(id, count) }
                    complete("start_production", recipe.id)
                }
            }
        }
        fun build(target: String) {
            val next = (state.buildings[target] ?: 0) + 1
            val upgrade = EconomyRules.catalog.buildings.single { it.id == target }.levels.single { it.level == next }
            do {
                upgrade.cost.items.forEach { (id, count) -> obtain(id, count) }
            } while (upgrade.cost.items.any { (id, count) -> (state.inventory[id] ?: 0L) < count })
            earn(upgrade.cost.coins)
            complete("start_construction", target)
        }
        fun stageOrder() {
            val terms = checkNotNull(EconomyStageOrders.offer(state))
            terms.items.forEach { (id, count) -> obtain(id, count) }
            state = apply(state, "complete_resident_order", terms.id, at = at)
        }
        stageOrder()
        build("quarry")
        stageOrder()
        build("quarry")
        stageOrder()
        build("kiln")
        stageOrder()
        stageOrder()
        while (EconomyStageOrders.offer(state) != null) stageOrder()
        build("home")
        assertEquals(3, state.buildings["home"])
        assertEquals(2, state.buildings["quarry"])
        assertEquals(1, state.buildings["kiln"])
        assertTrue(state.stageOrders.stages.getValue("2").completed)
        assertTrue(state.jobs.isEmpty())
        assertEquals(0L, state.wallet.pearls)
        assertEquals(0L, EconomyRules.storage(state).overflow)
    }

    @Test fun `kiln construction needs claimed quarry and workshop levels after home two`() {
        val before = stocked().copy(buildings = stocked().buildings + ("home" to 2))
        for (missing in listOf("quarry", "workshop")) {
            val locked = before.copy(buildings = before.buildings + mapOf("quarry" to 2, "workshop" to 1) + (missing to 0),
                jobs = listOf(EconomyJob(UUID.randomUUID().toString(), "construction", missing, targetLevel = if (missing == "quarry") 2 else 1,
                    startedAt = now.minusSeconds(60).toString(), finishesAt = now.toString())))
            assertEquals("ECONOMY_BUILDING_REQUIRED", assertFailsWith<AuthFailure> {
                apply(locked, "start_construction", "kiln")
            }.code, missing)
            val claimed = apply(locked, "claim_job", locked.jobs.single().id)
            val started = apply(claimed, "start_construction", "kiln")
            assertEquals(1, started.jobs.single().targetLevel)
            assertEquals(0, started.buildings["kiln"])
        }
    }

    @Test fun `completed quarry and kiln construction from the former unlocks keeps its paid snapshot`() {
        for (target in listOf("quarry", "kiln")) {
            val paidCost = EconomyRules.catalog.buildings.single { it.id == target }.levels.single { it.level == 1 }.cost
            val job = EconomyJob(UUID.randomUUID().toString(), "construction", target, targetLevel = 1,
                startedAt = now.minusSeconds(3600).toString(), finishesAt = now.toString(),
                cost = paidCost, catalogVersion = 2)
            val before = EconomyRules.initial().copy(wallet = EconomyWallet(170),
                inventory = mapOf("wood" to 5L), jobs = listOf(job),
                buildings = EconomyRules.initial().buildings + ("quarry" to if (target == "kiln") 1 else 0))
            val claimed = apply(before, "claim_job", job.id)
            assertEquals(1, claimed.buildings[target])
            assertEquals(1, claimed.buildings["home"])
            assertEquals(0, claimed.buildings["workshop"])
            assertEquals(before.wallet, claimed.wallet)
            assertEquals(before.inventory, claimed.inventory)
            assertTrue(claimed.jobs.isEmpty())
        }
    }

    @Test fun `existing home one kiln rejects new second stage work but keeps locked rewards`() {
        val existing = EconomyRules.initial().copy(buildings = EconomyRules.initial().buildings + mapOf("quarry" to 1, "kiln" to 1),
            inventory = mapOf("wood" to 4L))
        assertEquals("ECONOMY_HOME_REQUIRED", assertFailsWith<AuthFailure> {
            apply(existing, "start_production", "make_charcoal")
        }.code)
        assertTrue(existing.jobs.isEmpty())

        val lockedJob = EconomyJob(UUID.randomUUID().toString(), "production", "kiln", "make_charcoal",
            startedAt = now.minusSeconds(1800).toString(), finishesAt = now.toString(),
            rewards = mapOf("charcoal" to 7L), cost = EconomyCost(items = mapOf("wood" to 2L)), catalogVersion = 2)
        val claimed = apply(existing.copy(jobs = listOf(lockedJob)), "claim_job", lockedJob.id)
        assertEquals(7L, claimed.inventory["charcoal"])
        assertEquals(existing.inventory["wood"], claimed.inventory["wood"])
        assertEquals(existing.buildings, claimed.buildings)
    }

    @Test fun `legacy conversion remains bounded and adds to the fixed supplies while preserving buildings`() {
        assertEquals(EconomyMigration(coinsGranted = 0, woodGranted = 0, stoneGranted = 0), EconomyRules.legacyConversion(0, 0, 0))
        assertEquals(EconomyMigration(coinsGranted = 360, woodGranted = 9, stoneGranted = 7), EconomyRules.legacyConversion(100, 81, 49))
        val small = EconomyRules.initial(100, 81, 49, 4, 2)
        assertEquals(460L, small.wallet.coins)
        assertEquals(mapOf("wood" to 12L, "stone" to 12L), small.inventory)
        assertEquals(4, small.buildings["home"])
        assertEquals(2, small.buildings["workshop"])
        assertEquals(0L, small.wallet.pearls)
        val rich = EconomyRules.initial(ECONOMY_MAX_REVISION, ECONOMY_MAX_REVISION, ECONOMY_MAX_REVISION)
        assertEquals(5100L, rich.wallet.coins)
        assertEquals(mapOf("wood" to 33L, "stone" to 35L), rich.inventory)
        assertEquals(EconomyMigration(coinsGranted = 5000, woodGranted = 30, stoneGranted = 30), rich.migration)
        assertFailsWith<IllegalArgumentException> { EconomyRules.legacyConversion(-1, 0, 0) }
    }

    @Test fun `single rope processing consumes exact inputs and legacy batches keep their frozen output`() {
        val recipe = EconomyRules.catalog.recipes.single { it.id == "make_rope" }
        val before = requirements(stocked().copy(inventory = mapOf("fiber" to 100L, "rope" to 100L)),
            recipe.requiredHomeLevel, recipe.requiredBuildings + (recipe.buildingId to recipe.buildingLevel))
        assertEquals(0L, EconomyRules.storage(before).overflow)
        assertEquals("INVALID_ECONOMY_COMMAND", assertFailsWith<AuthFailure> { apply(before, "start_production", recipe.id, 3) }.code)
        val single = apply(before, "start_production", recipe.id)
        assertEquals(recipe.cost, single.jobs.single().cost); assertEquals(recipe.rewards, single.jobs.single().rewards)
        val legacyJob = EconomyJob(UUID.randomUUID().toString(), "production", recipe.buildingId, recipe.id,
            startedAt = now.toString(), finishesAt = now.plusSeconds(1800).toString(),
            cost = EconomyCost(items = mapOf("fiber" to 9L)), rewards = mapOf("rope" to 3L), catalogVersion = 6)
        val started = before.copy(inventory = mapOf("fiber" to 91L, "rope" to 100L), jobs = listOf(legacyJob))
        assertEquals(91L, started.inventory["fiber"])
        assertEquals(100L, started.inventory["rope"])
        val job = started.jobs.single()
        assertEquals(mapOf("fiber" to 9L), job.cost.items)
        assertEquals(mapOf("rope" to 3L), job.rewards)
        assertEquals(6, job.catalogVersion)
        assertEquals(Duration.ofSeconds(1800), Duration.between(Instant.parse(job.startedAt), Instant.parse(job.finishesAt)))
        assertEquals("ECONOMY_JOB_NOT_READY", assertFailsWith<AuthFailure> { apply(started, "claim_job", job.id, at = Instant.parse(job.finishesAt).minusMillis(1)) }.code)
        val completed = apply(started, "claim_job", job.id, at = Instant.parse(job.finishesAt))
        assertEquals(100L + job.rewards.getValue("rope"), completed.inventory["rope"])
        assertEquals(started.inventory["fiber"], completed.inventory["fiber"])
        assertEquals("ECONOMY_JOB_GONE", assertFailsWith<AuthFailure> { apply(completed, "claim_job", job.id, at = now.plusSeconds(3600)) }.code)
        assertEquals("INVALID_ECONOMY_COMMAND", assertFailsWith<AuthFailure> {
            apply(before, "start_production", recipe.id, checkNotNull(recipe.maxBatch) + 1L)
        }.code)
    }

    @Test fun `construction costs coins and materials and switches level only after completion`() {
        val upgrade = EconomyRules.catalog.buildings.single { it.id == "home" }.levels.single { it.level == 2 }
        val before = requirements(stocked(), upgrade.requiredHomeLevel, upgrade.requiredBuildings)
        val started = apply(before, "start_construction", "home")
        assertEquals(before.wallet.coins - upgrade.cost.coins, started.wallet.coins)
        upgrade.cost.items.forEach { (item, quantity) -> assertEquals(before.inventory.getValue(item) - quantity, started.inventory[item] ?: 0L) }
        assertEquals(1, started.buildings["home"])
        assertEquals("ECONOMY_CONSTRUCTION_BUSY", assertFailsWith<AuthFailure> { apply(started, "start_construction", "home") }.code)
        val job = started.jobs.single()
        assertEquals(2, job.targetLevel)
        val ready = apply(started, "claim_job", job.id, at = Instant.parse(job.finishesAt))
        assertEquals(2, ready.buildings["home"])
        assertTrue(ready.jobs.isEmpty())
        assertEquals("ECONOMY_MAX_LEVEL", assertFailsWith<AuthFailure> { apply(before.copy(buildings = before.buildings + ("home" to 5)), "start_construction", "home") }.code)
    }

    @Test fun `same station cannot produce during construction and queues cannot duplicate the hero`() {
        val upgrade = EconomyRules.catalog.buildings.single { it.id == "garden" }.levels.single { it.level == 2 }
        val before = requirements(stocked(), upgrade.requiredHomeLevel, upgrade.requiredBuildings)
        val producing = apply(before, "start_production", "grow_berries")
        assertEquals("ECONOMY_BUILDING_BUSY", assertFailsWith<AuthFailure> { apply(producing, "start_construction", "garden") }.code)
        val building = apply(before, "start_construction", "garden")
        assertEquals("ECONOMY_BUILDING_BUSY", assertFailsWith<AuthFailure> { apply(building, "start_production", "grow_berries") }.code)
        val exploring = apply(building, "start_exploration", "forest")
        assertEquals("ECONOMY_EXPLORER_BUSY", assertFailsWith<AuthFailure> { apply(exploring, "start_exploration", "forest") }.code)
        assertEquals(2, exploring.jobs.size)
    }

    @Test fun `one builder stays reserved across buildings until completion without taking the hero or production`() {
        val before = stocked().copy(buildings = stocked().buildings + mapOf("home" to 3, "garden" to 1, "woodlot" to 1, "workshop" to 1))
        val started = apply(before, "start_construction", "garden")
        val job = started.jobs.single()
        val readyAt = Instant.parse(job.finishesAt)
        for (at in listOf(now, readyAt, readyAt.plusSeconds(3600))) {
            val failure = assertFailsWith<AuthFailure> { apply(started, "start_construction", "woodlot", at = at) }
            assertEquals("ECONOMY_CONSTRUCTION_BUSY", failure.code)
            assertEquals("Строитель занят. Сначала завершите текущую стройку", failure.message)
            assertEquals(listOf(job), started.jobs)
        }
        val producing = apply(started, "start_production", "make_planks")
        val exploring = apply(producing, "start_exploration", "forest")
        assertEquals(setOf("construction", "production", "exploration"), exploring.jobs.map { it.kind }.toSet())
        val finished = apply(exploring, "claim_job", job.id, at = readyAt)
        val next = apply(finished, "start_construction", "woodlot", at = readyAt)
        assertEquals("woodlot", next.jobs.single { it.kind == "construction" }.targetId)
        assertEquals(2, next.buildings["garden"])
        val price = EconomyRules.constructionSpeedupPrice(job, now)
        val accelerated = EconomyRules.apply(started.copy(wallet = started.wallet.copy(pearls = price)),
            command("speedup_construction", job.id).copy(totalPrice = price), now).first
        assertEquals("woodlot", apply(accelerated, "start_construction", "woodlot").jobs.single().targetId)
    }

    private fun construction(remainingMillis: Long = 900_000) = EconomyJob(UUID.randomUUID().toString(), "construction", "home",
        targetLevel = 2, startedAt = now.minusSeconds(900).toString(), finishesAt = now.plusMillis(remainingMillis).toString(),
        cost = EconomyCost(1500, mapOf("wood" to 20L)), catalogVersion = 2)

    @Test fun `construction quote uses one visible pearl steps with exact subsecond readiness`() {
        assertEquals(15000L, EconomyRules.catalog.constructionSpeedup.secondsPerPearl)
        for ((milliseconds, price) in listOf(-1L to 0L, 0L to 0L, 1L to 1L, 59_999L to 1L, 60_000L to 1L,
            60_001L to 2L, 900_000L to 6L, 3_600_000L to 20L, 3_600_001L to 21L,
            86_400_000L to 260L, 86_400_001L to 261L, 172_800_000L to 384L,
            604_800_000L to 1000L, 604_800_001L to 1001L))
            assertEquals(price * 2, EconomyRules.constructionSpeedupPrice(construction(milliseconds), now))
        assertEquals(4L, EconomyRules.constructionSpeedupPrice(construction(60_000), now.minusNanos(1)))
        assertEquals(2L, EconomyRules.constructionSpeedupPrice(construction(0), now.minusNanos(1)))
        for (kind in listOf("production", "exploration"))
            assertEquals(0L, EconomyRules.constructionSpeedupPrice(construction().copy(kind = kind), now))
    }

    @Test fun `speedup spends current pearls below the accepted quote and completes the locked construction atomically`() {
        val job = construction()
        val before = EconomyRules.initial().copy(wallet = EconomyWallet(710, 1000), inventory = mapOf("berries" to 8L), jobs = listOf(job))
        val request = command("speedup_construction", job.id).copy(totalPrice = 500)
        val result = EconomyRules.apply(before, request, now).first
        assertEquals(EconomyWallet(710, 988), result.wallet)
        assertEquals(before.inventory, result.inventory)
        assertEquals(2, result.buildings["home"])
        assertTrue(result.jobs.isEmpty())
        assertEquals(0L, result.completedExplorations)
        assertEquals(992L, EconomyRules.apply(before, request, now.plusSeconds(300)).first.wallet.pearls)
        // Waiting for readiness never costs pearls, even when a former nonzero quote is submitted.
        val ready = EconomyRules.apply(before.copy(wallet = EconomyWallet()), request, Instant.parse(job.finishesAt)).first
        assertEquals(0L, ready.wallet.pearls)
        assertEquals(2, ready.buildings["home"])
    }

    @Test fun `speedup rejects inadequate quote insufficient currency and other job kinds without mutation`() {
        val job = construction()
        val before = EconomyRules.initial().copy(wallet = EconomyWallet(710, 11), jobs = listOf(job))
        val request = command("speedup_construction", job.id).copy(totalPrice = 12)
        assertEquals("ECONOMY_PEARLS", assertFailsWith<AuthFailure> { EconomyRules.apply(before, request, now) }.code)
        assertEquals("ECONOMY_SPEEDUP_PRICE_CHANGED", assertFailsWith<AuthFailure> { EconomyRules.apply(before, request.copy(totalPrice = 11), now) }.code)
        assertEquals("ECONOMY_JOB_GONE", assertFailsWith<AuthFailure> { EconomyRules.apply(before, request.copy(targetId = UUID.randomUUID().toString()), now) }.code)
        assertEquals("INVALID_ECONOMY_COMMAND", assertFailsWith<AuthFailure> { EconomyRules.apply(before, request.copy(quantity = 2), now) }.code)
        for (kind in listOf("production", "exploration")) assertEquals("ECONOMY_SPEEDUP_KIND", assertFailsWith<AuthFailure> {
            EconomyRules.apply(before.copy(jobs = listOf(job.copy(kind = kind))), request, now)
        }.code)
        assertEquals(EconomyWallet(710, 11), before.wallet)
        assertEquals(listOf(job), before.jobs)
        assertEquals(1, before.buildings["home"])
    }

    @Test fun `speedup preserves historic paid orders and allows warehouse expansion without dropping overflow`() {
        val job = construction().copy(targetId = "warehouse", catalogVersion = 1)
        val before = EconomyRules.initial().copy(wallet = EconomyWallet(0, 12), inventory = mapOf("wood" to 90L), jobs = listOf(job))
        val result = EconomyRules.apply(before, command("speedup_construction", job.id).copy(totalPrice = 12), now).first
        EconomyRules.assertStorageTransition(before, result)
        assertEquals(before.inventory, result.inventory)
        assertEquals(EconomyStorage(100, 90, 0, 10, 0), EconomyRules.storage(result))
        assertEquals(0L, result.wallet.pearls)
    }

    @Test fun `home and station unlocks are authoritative and insufficient costs leave input state intact`() {
        assertEquals("ECONOMY_HOME_REQUIRED", assertFailsWith<AuthFailure> { apply(stocked(), "start_exploration", "cave") }.code)
        assertEquals("ECONOMY_BUILDING_REQUIRED", assertFailsWith<AuthFailure> { apply(stocked(), "start_production", "make_planks") }.code)
        val upgrade = EconomyRules.catalog.buildings.single { it.id == "home" }.levels.single { it.level == 2 }
        val poor = requirements(EconomyRules.initial().copy(wallet = EconomyWallet(), inventory = emptyMap()), upgrade.requiredHomeLevel, upgrade.requiredBuildings)
        assertEquals("ECONOMY_RESOURCES", assertFailsWith<AuthFailure> { apply(poor, "start_construction", "home") }.code)
        assertTrue(poor.jobs.isEmpty())
        assertEquals(0L, poor.wallet.coins)
    }

    @Test fun `offline return waits indefinitely uses locked rewards and records exploration`() {
        val started = apply(EconomyRules.initial(), "start_exploration", "forest")
        val job = started.jobs.single()
        val completed = apply(started, "claim_job", job.id, at = now.plusSeconds(365 * 24 * 3600L))
        assertEquals(EconomyRules.addItems(started.inventory, job.rewards), completed.inventory)
        assertEquals(1L, completed.completedExplorations)
        assertEquals(started.wallet.pearls, completed.wallet.pearls)
    }

    @Test fun `inventory and wallet caps fail without losing job or resources`() {
        val initial = EconomyRules.initial()
        val started = apply(initial, "start_production", "grow_berries").copy(inventory = mapOf("berries" to ECONOMY_MAX_ITEMS))
        assertEquals("ECONOMY_CAPACITY", assertFailsWith<AuthFailure> { apply(started, "start_collection", started.jobs.single().id, at = Instant.parse(started.jobs.single().finishesAt)) }.code)
        assertEquals(1, started.jobs.size)
        val fullWallet = stocked().copy(wallet = EconomyWallet(ECONOMY_MAX_BALANCE))
        assertEquals("ECONOMY_CAPACITY", assertFailsWith<AuthFailure> { apply(fullWallet, "sell", "berries") }.code)
        assertEquals(100L, fullWallet.inventory["berries"])
    }

    @Test fun `command parsing rejects forged fields quoted numbers and oversized amounts`() {
        val good = command("start_production", "grow_berries")
        val json = economyJson.encodeToJsonElement(good).jsonObject
        assertEquals(good, decodeEconomyCommand(json))
        for (field in listOf("wallet", "rewards", "finishesAt"))
            assertFailsWith<AuthFailure> { decodeEconomyCommand(JsonObject(json + (field to JsonPrimitive(999)))) }
        assertFailsWith<AuthFailure> { decodeEconomyCommand(JsonObject(json + ("quantity" to JsonPrimitive("1")))) }
        assertFailsWith<AuthFailure> { decodeEconomyCommand(JsonObject(json + ("quantity" to JsonPrimitive(1.5)))) }
        assertFailsWith<AuthFailure> { validateEconomyCommand(good.copy(quantity = Long.MAX_VALUE)) }
        assertFailsWith<AuthFailure> { EconomyRules.apply(stocked(), good.copy(totalPrice = 5), now) }
        assertFailsWith<AuthFailure> { EconomyRules.apply(stocked(), command("start_construction", "home", 2), now) }
    }

    /** Rotating NPC bait offers are reachable once a repeatable source can earn coins;
     * this does not assume a player-market listing supplies a missing material. */
    private fun fishingMerchantItems(): Set<String> {
        val fishing = EconomyRules.catalog.fishing ?: return emptySet()
        val items = EconomyRules.catalog.items.associateBy { it.id }
        assertTrue(fishing.routeIds.isNotEmpty())
        assertTrue(fishing.routeIds.all { id -> EconomyRules.catalog.explorations.any { it.id == id && (it.rewards["fish"] ?: 0) > 0 } },
            "Fishing must refer to real shore routes with fish rewards")
        assertTrue(fishing.rods.any { it.id == "reed_rod" && it.price == 0L }, "Starter tackle must remain free")
        assertEquals(fishing.rods.size, fishing.rods.map { it.id }.toSet().size)
        assertTrue(fishing.rods.all { it.price >= 0 && it.rareBonus >= 0 })
        assertEquals(fishing.fish.size, fishing.fish.map { it.itemId }.toSet().size)
        assertEquals(fishing.baits.size, fishing.baits.map { it.itemId }.toSet().size)
        for (fish in fishing.fish) {
            val item = assertNotNull(items[fish.itemId], "Unknown fish item: ${fish.itemId}")
            assertTrue(fish.buyPrice > item.baseSellPrice, "${fish.itemId}: fish buy-sell arbitrage")
            assertNull(fish.weight)
            assertNull(fish.affinity)
            assertNull(fish.requiredHookId)
        }
        for (bait in fishing.baits) {
            val item = assertNotNull(items[bait.itemId], "Unknown bait item: ${bait.itemId}")
            assertTrue(bait.price > item.baseSellPrice, "${bait.itemId}: bait buy-sell arbitrage")
            assertTrue(bait.rareBonus >= 0)
        }
        val rarities = setOf("common", "uncommon", "rare", "epic", "legendary")
        for (rod in fishing.rods) {
            val probabilities = assertNotNull(rod.classOddsBps)
            assertEquals(rarities, probabilities.keys)
            assertTrue(probabilities.values.all { it in 0..10000 })
            assertEquals(10000, probabilities.values.sum())
        }
        val weights = fishing.hooks.map { it.rarityWeights } + fishing.baits.map { it.rarityWeights }
        for (entry in weights) {
            val specialization = assertNotNull(entry, "Current fishing gear must define its rarity specialization")
            assertEquals(rarities, specialization.keys)
            assertTrue(specialization.values.all { it in 1..1000 }, "Specialization factors must be finite and positive")
        }
        assertEquals(fishing.rods.size, fishing.rods.map { it.classOddsBps }.toSet().size)
        assertEquals(fishing.hooks.size, fishing.hooks.map { it.rarityWeights }.toSet().size)
        for (hook in fishing.hooks) {
            val factors = assertNotNull(hook.rarityWeights)
            assertTrue(factors.values.all { it >= 100 }, "Hooks boost their target without hidden penalties")
            assertEquals(if (hook.id == "bare_hook") 0 else 1, factors.values.count { it > 100 })
        }
        return fishing.baits.map { it.itemId }.toSet()
    }

    @Test fun `catalog dependency graph has obtainable inputs and meaningful processing margins`() {
        val itemIds = EconomyRules.catalog.items.map { it.id }.toSet()
        val buildingIds = EconomyRules.catalog.buildings.map { it.id }.toSet()
        val itemPrices = EconomyRules.catalog.items.associate { it.id to it.baseSellPrice }
        val specialistFish = EconomyRules.catalog.fishing?.classes?.map { it.itemId }?.toSet().orEmpty()
        fun cashValue(items: Map<String, Long>) = items.entries.sumOf { (id, quantity) ->
            if (id in specialistFish) itemPrices.getValue(id) * quantity else EconomyRules.localSellPrice(itemPrices.getValue(id), quantity, itemId = id) }
        for (recipe in EconomyRules.catalog.recipes) {
            assertTrue(recipe.buildingId in buildingIds)
            assertTrue(recipe.seconds > 0)
            assertTrue(recipe.cost.items.keys.all { it in itemIds })
            assertTrue(recipe.rewards.keys.all { it in itemIds })
            val cost = recipe.cost.coins + recipe.cost.items.entries.sumOf { itemPrices.getValue(it.key) * it.value }
            val value = recipe.rewards.entries.sumOf { itemPrices.getValue(it.key) * it.value }
            assertTrue(value > cost, "${recipe.id} should add value for its station time")
            assertTrue(cashValue(recipe.rewards) > cashValue(recipe.cost.items) + recipe.cost.coins,
                "${recipe.id} should preserve a positive margin after local-sale discount and specialist fish offers")
        }
        val merchantItems = fishingMerchantItems()
        var available = setOf<String>()
        repeat(10) {
            for (expedition in EconomyRules.catalog.explorations) {
                if (!available.containsAll(expedition.cost.items.keys)) continue
                available = available + expedition.rewards.keys
                // This source-only graph ignores levels, but requires a repeatable, affordable journey.
                // Rare materials are eventual outcomes of completed work, not guaranteed route rewards.
                EconomyRules.catalog.rareDrops?.let { available = available + it.itemIds }
                EconomyRules.catalog.fishing?.takeIf { expedition.id in it.routeIds }?.let { fishing ->
                    available = available + fishing.fish.map { it.itemId } + fishing.classes.map { it.itemId }
                }
            }
            for (recipe in EconomyRules.catalog.recipes)
                if (recipe.cost.items.keys.all { it in available }) available = available + recipe.rewards.keys
            if (EconomyRules.catalog.items.any { it.tradable && it.id in available }) available = available + merchantItems
        }
        assertEquals(itemIds, available)
        assertEquals(500, EconomyRules.catalog.market.feeBps)
    }
    @Test fun `warehouse counts all goods and market escrow without destroying imported overflow`() {
        val state = EconomyRules.initial().copy(inventory = mapOf("wood" to 25L, "stone" to 15L))
        assertEquals(EconomyStorage(50, 40, 5, 5, 0), EconomyRules.storage(state, mapOf("berries" to 5L)))
        val legacy = state.copy(inventory = mapOf("wood" to 70L))
        assertEquals(EconomyStorage(50, 70, 20, 0, 40), EconomyRules.storage(legacy, mapOf("berries" to 20L)))
        EconomyRules.assertStorageTransition(legacy, legacy.copy(inventory = mapOf("wood" to 60L)))
        EconomyRules.assertStorageTransition(legacy, legacy.copy(inventory = mapOf("wood" to 70L, "berries" to 20L)),
            mapOf("berries" to 20L), emptyMap())
        assertEquals("ECONOMY_STORAGE_FULL", assertFailsWith<AuthFailure> {
            EconomyRules.assertStorageTransition(legacy, legacy.copy(inventory = mapOf("wood" to 71L)))
        }.code)
    }

    @Test fun `ready harvest remains claimable after freeing warehouse space`() {
        val started = apply(EconomyRules.initial().copy(inventory = mapOf("wood" to 50L)), "start_production", "grow_berries")
        val job = started.jobs.single()
        val readyAt = Instant.parse(job.finishesAt)
        assertEquals("ECONOMY_STORAGE_FULL", assertFailsWith<AuthFailure> { apply(started, "start_collection", job.id, at = readyAt) }.code)
        assertEquals(job, started.jobs.single())
        val sold = apply(started, "sell", "wood", job.rewards.values.sum())
        val collecting = apply(sold, "start_collection", job.id, at = readyAt)
        val claimed = apply(collecting, "claim_job", job.id, at = Instant.parse(checkNotNull(collecting.jobs.single().collection?.finishesAt)))
        assertTrue(claimed.jobs.isEmpty())
        assertEquals(job.rewards.getValue("berries"), claimed.inventory["berries"])
        assertEquals(0L, EconomyRules.storage(claimed).available)
    }

    @Test fun `retired overnight gathering rejects new starts and preserves its paid thirty two berry snapshot`() {
        val state = EconomyRules.initial().let { it.copy(buildings = it.buildings + mapOf("home" to 3, "warehouse" to 2)) }
        assertTrue(EconomyRules.catalog.recipes.none { it.id == "grow_berries_overnight" })
        assertEquals("ECONOMY_RECIPE", assertFailsWith<AuthFailure> { apply(state, "start_production", "grow_berries_overnight") }.code)
        assertEquals("INVALID_ECONOMY_COMMAND", assertFailsWith<AuthFailure> { apply(state, "start_production", "grow_berries", 2) }.code)
        assertTrue(state.jobs.isEmpty())
        assertEquals(EconomyRules.initial().wallet, state.wallet)
        val job = EconomyJob(UUID.randomUUID().toString(), "production", "garden", "grow_berries_overnight",
            startedAt = now.minusSeconds(28800).toString(), finishesAt = now.toString(), rewards = mapOf("berries" to 32L),
            collection = EconomyCollection("berry_harvest", 8, null, null), catalogVersion = 7)
        val paid = state.copy(inventory = emptyMap(), jobs = listOf(job))
        val collecting = apply(paid, "start_collection", job.id)
        val claimed = apply(collecting, "claim_job", job.id, at = now.plusSeconds(8))
        assertEquals(mapOf("berries" to 32L), claimed.inventory)
        assertTrue(claimed.jobs.isEmpty())
    }

    @Test fun `claiming warehouse construction frees space and accepts old catalog snapshots`() {
        val state = EconomyRules.initial().copy(inventory = mapOf("wood" to 90L), jobs = listOf(
            EconomyJob(UUID.randomUUID().toString(), "construction", "warehouse", targetLevel = 2,
                startedAt = now.minusSeconds(60).toString(), finishesAt = now.toString(), catalogVersion = 1)))
        val expanded = apply(state, "claim_job", state.jobs.single().id)
        assertEquals(2, expanded.buildings["warehouse"])
        assertEquals(state.inventory, expanded.inventory)
        assertEquals(100L, EconomyRules.storage(expanded).capacity)
        assertEquals(10L, EconomyRules.storage(expanded).available)
        val legacyJob = EconomyJob(UUID.randomUUID().toString(), "production", "garden", "grow_berries",
            startedAt = now.minusSeconds(60).toString(), finishesAt = now.toString(), rewards = mapOf("berries" to 7L), catalogVersion = 1)
        assertEquals(7L, apply(expanded.copy(jobs = listOf(legacyJob)), "claim_job", legacyJob.id).inventory["berries"])
    }

    @Test fun `building dependency unlock requires claiming its completed construction`() {
        val target = EconomyRules.catalog.buildings.flatMap { building -> building.levels.map { building to it } }
            .first { (_, upgrade) -> upgrade.requiredBuildings.any { it.key != "home" && it.value > 0 } }
        val (building, upgrade) = target
        val dependency = upgrade.requiredBuildings.entries.first { it.key != "home" && it.value > 0 }
        val supplied = requirements(stocked(), upgrade.requiredHomeLevel, upgrade.requiredBuildings)
        val locked = supplied.copy(buildings = supplied.buildings + (building.id to upgrade.level - 1) + (dependency.key to dependency.value - 1),
            jobs = listOf(EconomyJob(UUID.randomUUID().toString(), "construction", dependency.key, targetLevel = dependency.value,
                startedAt = now.minusSeconds(60).toString(), finishesAt = now.toString())))
        assertEquals("ECONOMY_BUILDING_REQUIRED", assertFailsWith<AuthFailure> { apply(locked, "start_construction", building.id) }.code)
        val claimed = apply(locked, "claim_job", locked.jobs.single().id)
        assertEquals(upgrade.level, apply(claimed, "start_construction", building.id).jobs.single().targetLevel)
    }

    @Test fun `recipes and explorations enforce auxiliary building dependencies`() {
        val recipe = EconomyRules.catalog.recipes.first { it.requiredBuildings.isNotEmpty() }
        val recipeState = requirements(stocked(), recipe.requiredHomeLevel,
            recipe.requiredBuildings + (recipe.buildingId to recipe.buildingLevel))
        val recipeDependency = recipe.requiredBuildings.entries.first()
        val lockedRecipe = recipeState.copy(buildings = recipeState.buildings + (recipeDependency.key to recipeDependency.value - 1))
        assertEquals("ECONOMY_BUILDING_REQUIRED", assertFailsWith<AuthFailure> { apply(lockedRecipe, "start_production", recipe.id) }.code)
        assertEquals(recipe.id, apply(recipeState, "start_production", recipe.id).jobs.single().recipeId)

        val exploration = EconomyRules.catalog.explorations.first { it.requiredBuildings.isNotEmpty() }
        val explorationState = requirements(stocked(), exploration.requiredHomeLevel, exploration.requiredBuildings)
        val explorationDependency = exploration.requiredBuildings.entries.first()
        val lockedExploration = explorationState.copy(buildings = explorationState.buildings + (explorationDependency.key to explorationDependency.value - 1))
        assertEquals("ECONOMY_BUILDING_REQUIRED", assertFailsWith<AuthFailure> { apply(lockedExploration, "start_exploration", exploration.id) }.code)
        assertEquals(exploration.id, apply(explorationState, "start_exploration", exploration.id).jobs.single().targetId)
    }

    @Test fun `catalog progression can unlock every item and building without a dependency cycle`() {
        val buildings = EconomyRules.initial().buildings.toMutableMap()
        val merchantItems = fishingMerchantItems()
        val fishing = EconomyRules.catalog.fishing
        val items = mutableSetOf<String>()
        val completedRecipes = mutableSetOf<String>()
        fun unlocked(home: Int, required: Map<String, Int>) = (buildings["home"] ?: 1) >= home && required.all { (id, level) -> (buildings[id] ?: 0) >= level }
        repeat(100) {
            val reachableExplorations = mutableSetOf<String>()
            for (exploration in EconomyRules.catalog.explorations) {
                if (unlocked(exploration.requiredHomeLevel, exploration.requiredBuildings) && items.containsAll(exploration.cost.items.keys)) {
                    reachableExplorations.add(exploration.id)
                    items.addAll(exploration.rewards.keys)
                }
            }
            for (recipe in EconomyRules.catalog.recipes) {
                if ((buildings[recipe.buildingId] ?: 0) >= recipe.buildingLevel && unlocked(recipe.requiredHomeLevel, recipe.requiredBuildings) &&
                    items.containsAll(recipe.cost.items.keys) && completedRecipes.containsAll(recipe.requiredRecipes.keys)) {
                    items.addAll(recipe.rewards.keys)
                    completedRecipes.add(recipe.id)
                }
            }
            EconomyRules.catalog.rareDrops?.takeIf {
                unlocked(it.requiredHomeLevel, emptyMap()) && reachableExplorations.isNotEmpty()
            }?.let { items.addAll(it.itemIds) }
            val canEarnCoins = EconomyRules.catalog.items.any { it.tradable && it.id in items }
            if (canEarnCoins && fishing != null) {
                items.addAll(merchantItems.filter { id ->
                    unlocked(fishing.baits.single { it.itemId == id }.requiredHomeLevel, emptyMap())
                })
            }
            if (fishing != null && fishing.routeIds.any { it in reachableExplorations }) {
                for (fish in fishing.fish) {
                    val rodAvailable = fishing.rods.any { rod -> unlocked(rod.requiredHomeLevel, emptyMap()) &&
                        (rod.price == 0L || canEarnCoins) && EconomyRules.fishingClassWeights(rod.id, null)
                            .any { it.first.rarity == fish.rarity && it.second > 0 } }
                    if (rodAvailable)
                        items.addAll(listOf(fish.itemId, EconomyFishInventory.itemId(fish.itemId)))
                }
            }
            for (building in EconomyRules.catalog.buildings) {
                val upgrade = building.levels.find { it.level == (buildings[building.id] ?: 0) + 1 } ?: continue
                if (unlocked(upgrade.requiredHomeLevel, upgrade.requiredBuildings) && items.containsAll(upgrade.cost.items.keys))
                    buildings[building.id] = upgrade.level
            }
        }
        assertEquals(EconomyRules.catalog.items.map { it.id }.toSet(), items)
        for (building in EconomyRules.catalog.buildings) assertEquals(building.levels.maxOf { it.level }, buildings[building.id], building.id)
    }
}
