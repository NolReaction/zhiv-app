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
        val readyAt = travelling.jobs.maxOf { Instant.parse(it.finishesAt) }
        val collecting = apply(travelling, "start_collection", gardenJob.id, at = readyAt)
        val harvest = apply(collecting, "claim_job", gardenJob.id, at = readyAt.plusSeconds(checkNotNull(gardenJob.collection).seconds))
        val berryCount = gardenJob.rewards.getValue("berries")
        val sold = apply(harvest, "sell", "berries", berryCount)
        assertEquals(EconomyRules.localSellPrice(EconomyRules.catalog.items.single { it.id == "berries" }.baseSellPrice, berryCount), sold.wallet.coins)
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

    @Test fun `berry recipes snapshot a separate server timed collection and deliver locked rewards only after it finishes`() {
        val berryRecipes = EconomyRules.catalog.recipes.filter { it.buildingId == "garden" && (it.rewards["berries"] ?: 0L) > 0L }
        assertEquals(6, berryRecipes.size)
        for (recipe in berryRecipes) assertEquals(EconomyCollectionSpec("berry_harvest", 8), recipe.collection)
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
        assertEquals(job.rewards, claimed.inventory)
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
        val nearlyFull = started.copy(inventory = mapOf("wood" to 190L))
        val request = command("start_collection", job.id)
        assertEquals("ECONOMY_STORAGE_FULL", assertFailsWith<AuthFailure> {
            EconomyRules.apply(nearlyFull, request, readyAt, mapOf("stone" to 10L))
        }.code)
        assertEquals("ECONOMY_CAPACITY", assertFailsWith<AuthFailure> {
            EconomyRules.apply(started, request, readyAt, mapOf("berries" to ECONOMY_MAX_ITEMS))
        }.code)
        assertNull(started.jobs.single().collection?.startedAt)
        val collecting = EconomyRules.apply(started, request, readyAt).first
        val filled = collecting.copy(inventory = mapOf("wood" to 200L))
        assertEquals("ECONOMY_STORAGE_FULL", assertFailsWith<AuthFailure> {
            apply(filled, "claim_job", job.id, at = readyAt.plusSeconds(8))
        }.code)
        assertEquals(collecting.jobs, filled.jobs)
        val freed = apply(filled, "sell", "wood", job.rewards.values.sum(), readyAt.plusSeconds(8))
        val claimed = apply(freed, "claim_job", job.id, at = readyAt.plusSeconds(8))
        assertEquals(200L, EconomyRules.storage(claimed).used)
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

    @Test fun `a fresh account reaches home two before quarry and then builds quarry and kiln`() {
        var state = EconomyRules.initial()
        var at = now
        fun complete(action: String, target: String, quantity: Long = 1) {
            var started = apply(state, action, target, quantity, at)
            val job = started.jobs.single()
            at = Instant.parse(job.finishesAt)
            job.collection?.let {
                started = apply(started, "start_collection", job.id, at = at)
                at = at.plusSeconds(it.seconds)
            }
            state = apply(started, "claim_job", job.id, at = at)
        }

        repeat(8) {
            complete("start_production", "grow_berries_overnight")
            state = apply(state, "sell", "berries", state.inventory.getValue("berries"), at)
        }
        repeat(8) { complete("start_exploration", "forest") }
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
        complete("start_production", "quarry_stone")
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
        assertEquals(360L, small.wallet.coins)
        assertEquals(mapOf("wood" to 9L, "stone" to 7L), small.inventory)
        assertEquals(4, small.buildings["home"])
        assertEquals(2, small.buildings["workshop"])
        assertEquals(0L, small.wallet.pearls)
        val rich = EconomyRules.initial(ECONOMY_MAX_REVISION, ECONOMY_MAX_REVISION, ECONOMY_MAX_REVISION)
        assertEquals(5000L, rich.wallet.coins)
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
        assertEquals(3, job.catalogVersion)
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
        cost = EconomyCost(1500, mapOf("wood" to 20L)), catalogVersion = 2)

    @Test fun `construction pearl quote bills started intervals with exact subsecond readiness`() {
        assertEquals(300L, EconomyRules.catalog.constructionSpeedup.secondsPerPearl)
        for ((milliseconds, price) in listOf(-1L to 0L, 0L to 0L, 1L to 1L, 299_999L to 1L, 300_000L to 1L, 300_001L to 2L, 900_000L to 3L))
            assertEquals(price * 50, EconomyRules.constructionSpeedupPrice(construction(milliseconds), now))
        assertEquals(100L, EconomyRules.constructionSpeedupPrice(construction(300_000), now.minusNanos(1)))
        assertEquals(50L, EconomyRules.constructionSpeedupPrice(construction(0), now.minusNanos(1)))
        for (kind in listOf("production", "exploration"))
            assertEquals(0L, EconomyRules.constructionSpeedupPrice(construction().copy(kind = kind), now))
    }

    @Test fun `speedup spends current pearls below the accepted quote and completes the locked construction atomically`() {
        val job = construction()
        val before = EconomyRules.initial().copy(wallet = EconomyWallet(710, 1000), inventory = mapOf("berries" to 8L), jobs = listOf(job))
        val request = command("speedup_construction", job.id).copy(totalPrice = 500)
        val result = EconomyRules.apply(before, request, now).first
        assertEquals(EconomyWallet(710, 850), result.wallet)
        assertEquals(before.inventory, result.inventory)
        assertEquals(2, result.buildings["home"])
        assertTrue(result.jobs.isEmpty())
        assertEquals(0L, result.completedExplorations)
        assertEquals(900L, EconomyRules.apply(before, request, now.plusSeconds(300)).first.wallet.pearls)
        // Waiting for readiness never costs pearls, even when a former nonzero quote is submitted.
        val ready = EconomyRules.apply(before.copy(wallet = EconomyWallet()), request, Instant.parse(job.finishesAt)).first
        assertEquals(0L, ready.wallet.pearls)
        assertEquals(2, ready.buildings["home"])
    }

    @Test fun `speedup rejects inadequate quote insufficient currency and other job kinds without mutation`() {
        val job = construction()
        val before = EconomyRules.initial().copy(wallet = EconomyWallet(710, 100), jobs = listOf(job))
        val request = command("speedup_construction", job.id).copy(totalPrice = 150)
        assertEquals("ECONOMY_PEARLS", assertFailsWith<AuthFailure> { EconomyRules.apply(before, request, now) }.code)
        assertEquals("ECONOMY_SPEEDUP_PRICE_CHANGED", assertFailsWith<AuthFailure> { EconomyRules.apply(before, request.copy(totalPrice = 100), now) }.code)
        assertEquals("ECONOMY_JOB_GONE", assertFailsWith<AuthFailure> { EconomyRules.apply(before, request.copy(targetId = UUID.randomUUID().toString()), now) }.code)
        assertEquals("INVALID_ECONOMY_COMMAND", assertFailsWith<AuthFailure> { EconomyRules.apply(before, request.copy(quantity = 2), now) }.code)
        for (kind in listOf("production", "exploration")) assertEquals("ECONOMY_SPEEDUP_KIND", assertFailsWith<AuthFailure> {
            EconomyRules.apply(before.copy(jobs = listOf(job.copy(kind = kind))), request, now)
        }.code)
        assertEquals(EconomyWallet(710, 100), before.wallet)
        assertEquals(listOf(job), before.jobs)
        assertEquals(1, before.buildings["home"])
    }

    @Test fun `speedup preserves historic paid orders and allows warehouse expansion without dropping overflow`() {
        val job = construction().copy(targetId = "warehouse", catalogVersion = 1)
        val before = EconomyRules.initial().copy(wallet = EconomyWallet(0, 150), inventory = mapOf("wood" to 450L), jobs = listOf(job))
        val result = EconomyRules.apply(before, command("speedup_construction", job.id).copy(totalPrice = 150), now).first
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

    /** Fixed-price NPC goods are reachable once a repeatable source can earn coins;
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
            assertTrue(fish.weight > 0 && fish.affinity >= 0)
        }
        for (bait in fishing.baits) {
            val item = assertNotNull(items[bait.itemId], "Unknown bait item: ${bait.itemId}")
            assertTrue(bait.price > item.baseSellPrice, "${bait.itemId}: bait buy-sell arbitrage")
            assertTrue(bait.rareBonus >= 0)
        }
        for ((previous, fish) in fishing.fish.zipWithNext())
            assertTrue(fish.affinity * previous.weight >= previous.affinity * fish.weight,
                "Stronger tackle must not favour cheaper fish over rarer fish")
        return (fishing.fish.map { it.itemId } + fishing.baits.map { it.itemId }).toSet()
    }

    @Test fun `catalog dependency graph has obtainable inputs and meaningful processing margins`() {
        val itemIds = EconomyRules.catalog.items.map { it.id }.toSet()
        val buildingIds = EconomyRules.catalog.buildings.map { it.id }.toSet()
        val itemPrices = EconomyRules.catalog.items.associate { it.id to it.baseSellPrice }
        val specialistFish = EconomyRules.catalog.fishing?.fish?.map { it.itemId }?.toSet().orEmpty()
        fun cashValue(items: Map<String, Long>) = items.entries.sumOf { (id, quantity) ->
            if (id in specialistFish) itemPrices.getValue(id) * quantity else EconomyRules.localSellPrice(itemPrices.getValue(id), quantity) }
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
            for (expedition in EconomyRules.catalog.explorations)
                if (expedition.cost.items.keys.all { it in available }) available = available + expedition.rewards.keys
            for (recipe in EconomyRules.catalog.recipes)
                if (recipe.cost.items.keys.all { it in available }) available = available + recipe.rewards.keys
            if (EconomyRules.catalog.items.any { it.tradable && it.id in available }) available = available + merchantItems
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
        assertEquals("ECONOMY_STORAGE_FULL", assertFailsWith<AuthFailure> { apply(started, "start_collection", job.id, at = readyAt) }.code)
        assertEquals(job, started.jobs.single())
        val sold = apply(started, "sell", "wood", job.rewards.values.sum())
        val collecting = apply(sold, "start_collection", job.id, at = readyAt)
        val claimed = apply(collecting, "claim_job", job.id, at = Instant.parse(checkNotNull(collecting.jobs.single().collection?.finishesAt)))
        assertTrue(claimed.jobs.isEmpty())
        assertEquals(job.rewards.getValue("berries"), claimed.inventory["berries"])
        assertEquals(0L, EconomyRules.storage(claimed).available)
    }

    @Test fun `overnight gathering rejects bulk queues even when its reward would fit`() {
        val state = EconomyRules.initial()
        val recipe = EconomyRules.catalog.recipes.single { it.id == "grow_berries_overnight" }
        assertTrue(recipe.rewards.values.sum() <= EconomyRules.storage(state).capacity)
        assertTrue(recipe.rewards.values.sum() * 2 < EconomyRules.storage(state).capacity)
        assertEquals("INVALID_ECONOMY_COMMAND", assertFailsWith<AuthFailure> { apply(state, "start_production", recipe.id, 2) }.code)
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
        val merchantItems = fishingMerchantItems()
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
            if (EconomyRules.catalog.items.any { it.tradable && it.id in items }) items.addAll(merchantItems)
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
