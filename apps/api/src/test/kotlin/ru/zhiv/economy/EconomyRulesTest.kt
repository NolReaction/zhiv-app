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
    private fun stocked(): EconomyState = EconomyRules.initial().copy(wallet = EconomyWallet(10_000),
        inventory = EconomyRules.catalog.items.associate { it.id to 100L },
        buildings = EconomyRules.initial().buildings + ("warehouse" to 5))
    private fun requirements(state: EconomyState, home: Int, buildings: Map<String, Int>) = state.copy(
        buildings = state.buildings + buildings.mapValues { (id, level) -> maxOf(state.buildings[id] ?: 0, level) } +
            ("home" to maxOf(state.buildings["home"] ?: 1, home)))

    @Test fun `new players have a renewable recovery path without a cash gift or spending`() {
        val start = EconomyRules.initial()
        assertEquals(0L, start.wallet.coins)
        assertTrue(start.inventory.isEmpty())
        val garden = apply(start, "start_production", "grow_berries")
        val travelling = apply(garden, "start_exploration", "forest")
        assertEquals(2, travelling.jobs.size)
        val gardenJob = travelling.jobs.first { it.kind == "production" }
        val harvest = apply(travelling, "claim_job", gardenJob.id, at = Instant.parse(gardenJob.finishesAt))
        val berryCount = gardenJob.rewards.getValue("berries")
        val sold = apply(harvest, "sell", "berries", berryCount)
        assertEquals(berryCount * EconomyRules.catalog.items.single { it.id == "berries" }.baseSellPrice, sold.wallet.coins)
        assertEquals(0L, sold.inventory["berries"] ?: 0)
        assertEquals(1, sold.jobs.size)
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

    @Test fun `a fresh account reaches home two before quarry and then builds quarry and kiln`() {
        var state = EconomyRules.initial()
        var at = now
        fun complete(action: String, target: String, quantity: Long = 1) {
            val started = apply(state, action, target, quantity, at)
            val job = started.jobs.single()
            at = Instant.parse(job.finishesAt)
            state = apply(started, "claim_job", job.id, at = at)
        }

        complete("start_production", "grow_berries_overnight")
        state = apply(state, "sell", "berries", state.inventory.getValue("berries"), at)
        complete("start_exploration", "forest_camp")
        complete("start_construction", "woodlot")
        complete("start_construction", "workshop")
        complete("start_exploration", "forest")
        complete("start_production", "gather_wood")
        complete("start_production", "make_planks", 6)
        complete("start_production", "make_rope", 2)
        assertEquals(0, state.buildings["quarry"])
        assertEquals(0, state.buildings["kiln"])
        complete("start_construction", "home")
        assertEquals(2, state.buildings["home"])
        assertEquals(0, state.buildings["quarry"])
        assertEquals(0, state.buildings["kiln"])

        complete("start_exploration", "forest_camp")
        complete("start_construction", "quarry")
        complete("start_construction", "kiln")
        assertEquals(1, state.buildings["quarry"])
        assertEquals(1, state.buildings["kiln"])
        assertTrue(state.jobs.isEmpty())
        assertEquals(0L, state.wallet.pearls)
        assertTrue(EconomyRules.storage(state).overflow == 0L)
    }

    @Test fun `kiln construction needs claimed quarry and workshop levels after home two`() {
        val before = stocked().copy(buildings = stocked().buildings + ("home" to 2))
        for (missing in listOf("quarry", "workshop")) {
            val locked = before.copy(buildings = before.buildings + mapOf("quarry" to 1, "workshop" to 1) + (missing to 0),
                jobs = listOf(EconomyJob(UUID.randomUUID().toString(), "construction", missing, targetLevel = 1,
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
            val before = EconomyRules.initial().copy(wallet = EconomyWallet(17),
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

    @Test fun `existing home one quarry and kiln keep producing and claiming their locked rewards`() {
        val existing = EconomyRules.initial().copy(buildings = EconomyRules.initial().buildings + mapOf("quarry" to 1, "kiln" to 1),
            inventory = mapOf("wood" to 4L))
        for (recipe in listOf("quarry_stone", "quarry_stone_overnight", "make_charcoal")) {
            val started = apply(existing, "start_production", recipe)
            val job = started.jobs.single()
            val claimed = apply(started, "claim_job", job.id, at = Instant.parse(job.finishesAt))
            assertEquals(existing.buildings, claimed.buildings)
            for ((item, quantity) in job.rewards)
                assertEquals((started.inventory[item] ?: 0L) + quantity, claimed.inventory[item], recipe)
        }

        val lockedJob = EconomyJob(UUID.randomUUID().toString(), "production", "kiln", "make_charcoal",
            startedAt = now.minusSeconds(1800).toString(), finishesAt = now.toString(),
            rewards = mapOf("charcoal" to 7L), cost = EconomyCost(items = mapOf("wood" to 2L)), catalogVersion = 2)
        val claimed = apply(existing.copy(jobs = listOf(lockedJob)), "claim_job", lockedJob.id)
        assertEquals(7L, claimed.inventory["charcoal"])
        assertEquals(existing.inventory["wood"], claimed.inventory["wood"])
        assertEquals(existing.buildings, claimed.buildings)
    }

    @Test fun `conversion is bounded monotonic preserves buildings and never grants premium currency`() {
        assertEquals(EconomyMigration(coinsGranted = 0, woodGranted = 0, stoneGranted = 0), EconomyRules.legacyConversion(0, 0, 0))
        val small = EconomyRules.initial(100, 81, 49, 4, 2)
        assertEquals(36L, small.wallet.coins)
        assertEquals(mapOf("wood" to 9L, "stone" to 7L), small.inventory)
        assertEquals(4, small.buildings["home"])
        assertEquals(2, small.buildings["workshop"])
        assertEquals(0L, small.wallet.pearls)
        val rich = EconomyRules.initial(ECONOMY_MAX_REVISION, ECONOMY_MAX_REVISION, ECONOMY_MAX_REVISION)
        assertEquals(500L, rich.wallet.coins)
        assertEquals(mapOf("wood" to 30L, "stone" to 30L), rich.inventory)
        assertFailsWith<IllegalArgumentException> { EconomyRules.legacyConversion(-1, 0, 0) }
    }

    @Test fun `production pays inputs at start and snapshots an entire finite batch`() {
        val recipe = EconomyRules.catalog.recipes.single { it.id == "make_planks" }
        val before = requirements(stocked(), recipe.requiredHomeLevel, recipe.requiredBuildings + (recipe.buildingId to recipe.buildingLevel))
        val started = apply(before, "start_production", "make_planks", 3)
        assertEquals(100L - recipe.cost.items.getValue("wood") * 3, started.inventory["wood"])
        assertEquals(100L, started.inventory["planks"])
        val job = started.jobs.single()
        assertEquals(recipe.cost.items.mapValues { it.value * 3 }, job.cost.items)
        assertEquals(recipe.rewards.mapValues { it.value * 3 }, job.rewards)
        assertEquals(2, job.catalogVersion)
        assertEquals(Duration.ofSeconds(recipe.seconds * 3), Duration.between(Instant.parse(job.startedAt), Instant.parse(job.finishesAt)))
        assertEquals("ECONOMY_JOB_NOT_READY", assertFailsWith<AuthFailure> { apply(started, "claim_job", job.id, at = Instant.parse(job.finishesAt).minusMillis(1)) }.code)
        val completed = apply(started, "claim_job", job.id, at = Instant.parse(job.finishesAt))
        assertEquals(100L + job.rewards.getValue("planks"), completed.inventory["planks"])
        assertEquals(started.inventory["wood"], completed.inventory["wood"])
        assertEquals("ECONOMY_JOB_GONE", assertFailsWith<AuthFailure> { apply(completed, "claim_job", job.id, at = now.plusSeconds(3600)) }.code)
        assertFailsWith<AuthFailure> { apply(before, "start_production", "make_planks", 11) }
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

    private fun construction(remainingMillis: Long = 900_000) = EconomyJob(UUID.randomUUID().toString(), "construction", "home",
        targetLevel = 2, startedAt = now.minusSeconds(900).toString(), finishesAt = now.plusMillis(remainingMillis).toString(),
        cost = EconomyCost(150, mapOf("wood" to 20L)), catalogVersion = 2)

    @Test fun `construction pearl quote bills started intervals with exact subsecond readiness`() {
        assertEquals(300L, EconomyRules.catalog.constructionSpeedup.secondsPerPearl)
        for ((milliseconds, price) in listOf(-1L to 0L, 0L to 0L, 1L to 1L, 299_999L to 1L, 300_000L to 1L, 300_001L to 2L, 900_000L to 3L))
            assertEquals(price, EconomyRules.constructionSpeedupPrice(construction(milliseconds), now))
        assertEquals(2L, EconomyRules.constructionSpeedupPrice(construction(300_000), now.minusNanos(1)))
        assertEquals(1L, EconomyRules.constructionSpeedupPrice(construction(0), now.minusNanos(1)))
        for (kind in listOf("production", "exploration"))
            assertEquals(0L, EconomyRules.constructionSpeedupPrice(construction().copy(kind = kind), now))
    }

    @Test fun `speedup spends current pearls below the accepted quote and completes the locked construction atomically`() {
        val job = construction()
        val before = EconomyRules.initial().copy(wallet = EconomyWallet(71, 20), inventory = mapOf("berries" to 8L), jobs = listOf(job))
        val request = command("speedup_construction", job.id).copy(totalPrice = 10)
        val result = EconomyRules.apply(before, request, now).first
        assertEquals(EconomyWallet(71, 17), result.wallet)
        assertEquals(before.inventory, result.inventory)
        assertEquals(2, result.buildings["home"])
        assertTrue(result.jobs.isEmpty())
        assertEquals(0L, result.completedExplorations)
        assertEquals(18L, EconomyRules.apply(before, request, now.plusSeconds(300)).first.wallet.pearls)
        // Waiting for readiness never costs pearls, even when a former nonzero quote is submitted.
        val ready = EconomyRules.apply(before.copy(wallet = EconomyWallet()), request, Instant.parse(job.finishesAt)).first
        assertEquals(0L, ready.wallet.pearls)
        assertEquals(2, ready.buildings["home"])
    }

    @Test fun `speedup rejects inadequate quote insufficient currency and other job kinds without mutation`() {
        val job = construction()
        val before = EconomyRules.initial().copy(wallet = EconomyWallet(71, 2), jobs = listOf(job))
        val request = command("speedup_construction", job.id).copy(totalPrice = 3)
        assertEquals("ECONOMY_PEARLS", assertFailsWith<AuthFailure> { EconomyRules.apply(before, request, now) }.code)
        assertEquals("ECONOMY_SPEEDUP_PRICE_CHANGED", assertFailsWith<AuthFailure> { EconomyRules.apply(before, request.copy(totalPrice = 2), now) }.code)
        assertEquals("ECONOMY_JOB_GONE", assertFailsWith<AuthFailure> { EconomyRules.apply(before, request.copy(targetId = UUID.randomUUID().toString()), now) }.code)
        assertEquals("INVALID_ECONOMY_COMMAND", assertFailsWith<AuthFailure> { EconomyRules.apply(before, request.copy(quantity = 2), now) }.code)
        for (kind in listOf("production", "exploration")) assertEquals("ECONOMY_SPEEDUP_KIND", assertFailsWith<AuthFailure> {
            EconomyRules.apply(before.copy(jobs = listOf(job.copy(kind = kind))), request, now)
        }.code)
        assertEquals(EconomyWallet(71, 2), before.wallet)
        assertEquals(listOf(job), before.jobs)
        assertEquals(1, before.buildings["home"])
    }

    @Test fun `speedup preserves historic paid orders and allows warehouse expansion without dropping overflow`() {
        val job = construction().copy(targetId = "warehouse", catalogVersion = 1)
        val before = EconomyRules.initial().copy(wallet = EconomyWallet(0, 3), inventory = mapOf("wood" to 450L), jobs = listOf(job))
        val result = EconomyRules.apply(before, command("speedup_construction", job.id).copy(totalPrice = 3), now).first
        EconomyRules.assertStorageTransition(before, result)
        assertEquals(before.inventory, result.inventory)
        assertEquals(EconomyStorage(500, 450, 0, 50, 0), EconomyRules.storage(result))
        assertEquals(0L, result.wallet.pearls)
    }

    @Test fun `home and station unlocks are authoritative and insufficient costs leave input state intact`() {
        assertEquals("ECONOMY_HOME_REQUIRED", assertFailsWith<AuthFailure> { apply(stocked(), "start_exploration", "cave") }.code)
        assertEquals("ECONOMY_BUILDING_REQUIRED", assertFailsWith<AuthFailure> { apply(stocked(), "start_production", "make_planks") }.code)
        val upgrade = EconomyRules.catalog.buildings.single { it.id == "home" }.levels.single { it.level == 2 }
        val poor = requirements(EconomyRules.initial(), upgrade.requiredHomeLevel, upgrade.requiredBuildings)
        assertEquals("ECONOMY_RESOURCES", assertFailsWith<AuthFailure> { apply(poor, "start_construction", "home") }.code)
        assertTrue(poor.jobs.isEmpty())
        assertEquals(0L, poor.wallet.coins)
    }

    @Test fun `offline return waits indefinitely uses locked rewards and records exploration`() {
        val started = apply(EconomyRules.initial(), "start_exploration", "forest")
        val job = started.jobs.single()
        val completed = apply(started, "claim_job", job.id, at = now.plusSeconds(365 * 24 * 3600L))
        assertEquals(job.rewards, completed.inventory)
        assertEquals(1L, completed.completedExplorations)
        assertEquals(0L, completed.wallet.pearls)
    }

    @Test fun `inventory and wallet caps fail without losing job or resources`() {
        val initial = EconomyRules.initial()
        val started = apply(initial, "start_production", "grow_berries").copy(inventory = mapOf("berries" to ECONOMY_MAX_BALANCE))
        assertEquals("ECONOMY_CAPACITY", assertFailsWith<AuthFailure> { apply(started, "claim_job", started.jobs.single().id, at = Instant.parse(started.jobs.single().finishesAt)) }.code)
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

    @Test fun `catalog dependency graph has obtainable inputs and meaningful processing margins`() {
        val itemIds = EconomyRules.catalog.items.map { it.id }.toSet()
        val buildingIds = EconomyRules.catalog.buildings.map { it.id }.toSet()
        val itemPrices = EconomyRules.catalog.items.associate { it.id to it.baseSellPrice }
        for (recipe in EconomyRules.catalog.recipes) {
            assertTrue(recipe.buildingId in buildingIds)
            assertTrue(recipe.seconds > 0)
            assertTrue(recipe.cost.items.keys.all { it in itemIds })
            assertTrue(recipe.rewards.keys.all { it in itemIds })
            val cost = recipe.cost.coins + recipe.cost.items.entries.sumOf { itemPrices.getValue(it.key) * it.value }
            val value = recipe.rewards.entries.sumOf { itemPrices.getValue(it.key) * it.value }
            assertTrue(value > cost, "${recipe.id} should add value for its station time")
        }
        var available = setOf<String>()
        repeat(10) {
            for (expedition in EconomyRules.catalog.explorations)
                if (expedition.cost.items.keys.all { it in available }) available = available + expedition.rewards.keys
            for (recipe in EconomyRules.catalog.recipes)
                if (recipe.cost.items.keys.all { it in available }) available = available + recipe.rewards.keys
        }
        assertEquals(itemIds, available)
        assertEquals(0, EconomyRules.catalog.market.feeBps)
    }
    @Test fun `warehouse counts all goods and market escrow without destroying imported overflow`() {
        val state = EconomyRules.initial().copy(inventory = mapOf("wood" to 150L, "stone" to 30L))
        assertEquals(EconomyStorage(200, 180, 15, 5, 0), EconomyRules.storage(state, mapOf("berries" to 15L)))
        val legacy = state.copy(inventory = mapOf("wood" to 400L))
        assertEquals(EconomyStorage(200, 400, 20, 0, 220), EconomyRules.storage(legacy, mapOf("berries" to 20L)))
        EconomyRules.assertStorageTransition(legacy, legacy.copy(inventory = mapOf("wood" to 390L)))
        EconomyRules.assertStorageTransition(legacy, legacy.copy(inventory = mapOf("wood" to 400L, "berries" to 20L)),
            mapOf("berries" to 20L), emptyMap())
        assertEquals("ECONOMY_STORAGE_FULL", assertFailsWith<AuthFailure> {
            EconomyRules.assertStorageTransition(legacy, legacy.copy(inventory = mapOf("wood" to 401L)))
        }.code)
    }

    @Test fun `ready harvest remains claimable after freeing warehouse space`() {
        val started = apply(EconomyRules.initial().copy(inventory = mapOf("wood" to 200L)), "start_production", "grow_berries")
        val job = started.jobs.single()
        val readyAt = Instant.parse(job.finishesAt)
        assertEquals("ECONOMY_STORAGE_FULL", assertFailsWith<AuthFailure> { apply(started, "claim_job", job.id, at = readyAt) }.code)
        assertEquals(job, started.jobs.single())
        val sold = apply(started, "sell", "wood", job.rewards.values.sum())
        val claimed = apply(sold, "claim_job", job.id, at = readyAt)
        assertTrue(claimed.jobs.isEmpty())
        assertEquals(job.rewards.getValue("berries"), claimed.inventory["berries"])
        assertEquals(0L, EconomyRules.storage(claimed).available)
    }

    @Test fun `production cannot start a batch larger than the entire warehouse`() {
        val state = EconomyRules.initial()
        val recipe = EconomyRules.catalog.recipes.single { it.id == "grow_berries_overnight" }
        assertTrue(recipe.rewards.values.sum() <= EconomyRules.storage(state).capacity)
        assertTrue(recipe.rewards.values.sum() * 2 > EconomyRules.storage(state).capacity)
        assertEquals("ECONOMY_STORAGE_FULL", assertFailsWith<AuthFailure> { apply(state, "start_production", recipe.id, 2) }.code)
        assertTrue(state.jobs.isEmpty())
        assertEquals(0L, state.wallet.coins)
        // Occupied slots do not prevent starting a feasible order: the player can free them before collection.
        val started = apply(state.copy(inventory = mapOf("wood" to 200L)), "start_production", recipe.id)
        assertEquals(recipe.rewards, started.jobs.single().rewards)
    }

    @Test fun `claiming warehouse construction frees space and accepts old catalog snapshots`() {
        val state = EconomyRules.initial().copy(inventory = mapOf("wood" to 450L), jobs = listOf(
            EconomyJob(UUID.randomUUID().toString(), "construction", "warehouse", targetLevel = 2,
                startedAt = now.minusSeconds(60).toString(), finishesAt = now.toString(), catalogVersion = 1)))
        val expanded = apply(state, "claim_job", state.jobs.single().id)
        assertEquals(2, expanded.buildings["warehouse"])
        assertEquals(state.inventory, expanded.inventory)
        assertEquals(500L, EconomyRules.storage(expanded).capacity)
        assertEquals(50L, EconomyRules.storage(expanded).available)
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
        val items = mutableSetOf<String>()
        fun unlocked(home: Int, required: Map<String, Int>) = (buildings["home"] ?: 1) >= home && required.all { (id, level) -> (buildings[id] ?: 0) >= level }
        repeat(100) {
            for (exploration in EconomyRules.catalog.explorations) {
                if (unlocked(exploration.requiredHomeLevel, exploration.requiredBuildings) && items.containsAll(exploration.cost.items.keys))
                    items.addAll(exploration.rewards.keys)
            }
            for (recipe in EconomyRules.catalog.recipes) {
                if ((buildings[recipe.buildingId] ?: 0) >= recipe.buildingLevel && unlocked(recipe.requiredHomeLevel, recipe.requiredBuildings) && items.containsAll(recipe.cost.items.keys))
                    items.addAll(recipe.rewards.keys)
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
