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
        inventory = EconomyRules.catalog.items.associate { it.id to 100L })

    @Test fun `new players have a renewable recovery path without a cash gift or spending`() {
        val start = EconomyRules.initial()
        assertEquals(0L, start.wallet.coins)
        assertTrue(start.inventory.isEmpty())
        val garden = apply(start, "start_production", "grow_berries")
        val travelling = apply(garden, "start_exploration", "forest")
        assertEquals(2, travelling.jobs.size)
        val gardenJob = travelling.jobs.first { it.kind == "production" }
        val harvest = apply(travelling, "claim_job", gardenJob.id, at = Instant.parse(gardenJob.finishesAt))
        val sold = apply(harvest, "sell", "berries", 6)
        assertEquals(18L, sold.wallet.coins)
        assertEquals(0L, sold.inventory["berries"] ?: 0)
        assertEquals(1, sold.jobs.size)
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
        val before = stocked().copy(buildings = stocked().buildings + ("workshop" to 1))
        val started = apply(before, "start_production", "make_planks", 3)
        assertEquals(94L, started.inventory["wood"])
        assertEquals(100L, started.inventory["planks"])
        val job = started.jobs.single()
        assertEquals(mapOf("wood" to 6L), job.cost.items)
        assertEquals(mapOf("planks" to 3L), job.rewards)
        assertEquals(Duration.ofSeconds(2700), Duration.between(Instant.parse(job.startedAt), Instant.parse(job.finishesAt)))
        assertEquals("ECONOMY_JOB_NOT_READY", assertFailsWith<AuthFailure> { apply(started, "claim_job", job.id, at = Instant.parse(job.finishesAt).minusMillis(1)) }.code)
        val completed = apply(started, "claim_job", job.id, at = now.plusSeconds(3600))
        assertEquals(103L, completed.inventory["planks"])
        assertEquals(94L, completed.inventory["wood"])
        assertEquals("ECONOMY_JOB_GONE", assertFailsWith<AuthFailure> { apply(completed, "claim_job", job.id, at = now.plusSeconds(3600)) }.code)
        assertFailsWith<AuthFailure> { apply(before, "start_production", "make_planks", 11) }
    }

    @Test fun `construction costs coins and materials and switches level only after completion`() {
        val before = stocked()
        val started = apply(before, "start_construction", "home")
        assertEquals(9900L, started.wallet.coins)
        assertEquals(88L, started.inventory["wood"])
        assertEquals(92L, started.inventory["stone"])
        assertEquals(1, started.buildings["home"])
        assertEquals("ECONOMY_CONSTRUCTION_BUSY", assertFailsWith<AuthFailure> { apply(started, "start_construction", "woodlot") }.code)
        val job = started.jobs.single()
        assertEquals(2, job.targetLevel)
        val ready = apply(started, "claim_job", job.id, at = now.plusSeconds(1800))
        assertEquals(2, ready.buildings["home"])
        assertTrue(ready.jobs.isEmpty())
        assertEquals("ECONOMY_MAX_LEVEL", assertFailsWith<AuthFailure> { apply(before.copy(buildings = before.buildings + ("home" to 5)), "start_construction", "home") }.code)
    }

    @Test fun `same station cannot produce during construction and queues cannot duplicate the hero`() {
        val before = stocked().copy(buildings = stocked().buildings + ("home" to 2))
        val producing = apply(before, "start_production", "grow_berries")
        assertEquals("ECONOMY_BUILDING_BUSY", assertFailsWith<AuthFailure> { apply(producing, "start_construction", "garden") }.code)
        val building = apply(before, "start_construction", "garden")
        assertEquals("ECONOMY_BUILDING_BUSY", assertFailsWith<AuthFailure> { apply(building, "start_production", "grow_berries") }.code)
        val exploring = apply(building, "start_exploration", "forest")
        assertEquals("ECONOMY_EXPLORER_BUSY", assertFailsWith<AuthFailure> { apply(exploring, "start_exploration", "shore") }.code)
        assertEquals(2, exploring.jobs.size)
    }

    @Test fun `home and station unlocks are authoritative and insufficient costs leave input state intact`() {
        assertEquals("ECONOMY_HOME_REQUIRED", assertFailsWith<AuthFailure> { apply(stocked(), "start_exploration", "cave") }.code)
        assertEquals("ECONOMY_BUILDING_REQUIRED", assertFailsWith<AuthFailure> { apply(stocked(), "start_production", "make_planks") }.code)
        val poor = EconomyRules.initial()
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
        assertEquals("ECONOMY_CAPACITY", assertFailsWith<AuthFailure> { apply(started, "claim_job", started.jobs.single().id, at = now.plusSeconds(600)) }.code)
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
    @Test fun `zero balance can earn every material and construct all sites through home level five`() {
        class Farm {
            var state = EconomyRules.initial()
            var clock = now
            var actions = 0
            fun perform(action: String, target: String, quantity: Long = 1) {
                check(++actions < 2000) { "Economy dependency cycle or unreachable goal" }
                state = EconomyRules.apply(state, command(action, target, quantity), clock).first
                if (action.startsWith("start_")) {
                    val job = state.jobs.single()
                    clock = Instant.parse(job.finishesAt)
                    state = EconomyRules.apply(state, command("claim_job", job.id), clock).first
                }
            }
            fun coins(amount: Long) {
                while (state.wallet.coins < amount) {
                    perform("start_production", "grow_berries", 10)
                    perform("sell", "berries", 60)
                }
            }
            fun materials(id: String, quantity: Long) {
                val recipes = mapOf("planks" to "make_planks", "rope" to "make_rope", "metal_parts" to "make_metal_parts",
                    "dried_berries" to "dry_berries", "smoked_fish" to "smoke_fish", "berries" to "grow_berries")
                while ((state.inventory[id] ?: 0) < quantity) {
                    when (id) {
                        "wood", "stone", "fiber" -> perform("start_exploration", "forest")
                        "fish" -> perform("start_exploration", "shore")
                        "ore" -> { building("home", 2); perform("start_exploration", "cave") }
                        else -> {
                            val recipe = EconomyRules.catalog.recipes.single { it.id == recipes.getValue(id) }
                            building("home", recipe.requiredHomeLevel)
                            building(recipe.buildingId, recipe.buildingLevel)
                            recipe.cost.items.forEach { (item, count) -> materials(item, count) }
                            coins(recipe.cost.coins)
                            perform("start_production", recipe.id)
                        }
                    }
                }
            }
            fun building(id: String, level: Int) {
                while ((state.buildings[id] ?: 0) < level) {
                    val next = (state.buildings[id] ?: 0) + 1
                    val upgrade = EconomyRules.catalog.buildings.single { it.id == id }.levels.single { it.level == next }
                    if (id != "home") building("home", upgrade.requiredHomeLevel)
                    while (upgrade.cost.items.any { (item, count) -> (state.inventory[item] ?: 0) < count })
                        upgrade.cost.items.forEach { (item, count) -> materials(item, count) }
                    coins(upgrade.cost.coins)
                    perform("start_construction", id)
                }
            }
        }
        val farm = Farm()
        for (building in EconomyRules.catalog.buildings) farm.building(building.id, building.levels.maxOf { it.level })
        assertEquals(5, farm.state.buildings["home"])
        assertTrue(EconomyRules.catalog.buildings.all { farm.state.buildings[it.id] == it.levels.maxOf { level -> level.level } })
        assertTrue(farm.state.completedExplorations > 0)
        assertEquals(0L, farm.state.wallet.pearls)
        assertTrue(farm.state.jobs.isEmpty())
        assertTrue(farm.actions < 2000)
    }

}
