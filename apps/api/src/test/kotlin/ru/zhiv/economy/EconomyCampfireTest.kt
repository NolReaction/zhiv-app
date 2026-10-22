package ru.zhiv.economy

import org.junit.jupiter.api.Test
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.*
import ru.zhiv.auth.AuthFailure
import java.time.Instant
import java.util.UUID
import kotlin.test.*

class EconomyCampfireTest {
    private val now = Instant.parse("2026-10-18T16:00:00Z")
    private val recipe get() = EconomyRules.catalog.recipes.single { it.id == "cook_grilled_fish" }
    private val upgrade get() = EconomyRules.catalog.buildings.single { it.id == "dryer" }.levels.first()
    private fun apply(state: EconomyState, action: String, target: String, at: Instant = now, quantity: Long = 1) =
        EconomyRules.apply(state, EconomyCommand(UUID.randomUUID().toString(), "ABCD-EFGH-JKMP", 0, action, target, quantity), at).first
    private fun failure(code: String, block: () -> Unit) { assertEquals(code, assertFailsWith<AuthFailure>(block = block).code) }

    @Test fun `the existing level zero campfire cooks one paid fish without giving a building level`() {
        val original = EconomyRules.initial().copy(inventory = mapOf("fish_common" to 2L, "wood" to 3L))
        assertEquals(0, original.buildings["dryer"])
        assertEquals(0, recipe.effectiveBuildingLevel)
        val cooking = apply(original, "start_production", recipe.id)
        val job = cooking.jobs.single()
        assertEquals(0, cooking.buildings["dryer"])
        assertEquals(1, EconomyRules.productionSlotCount(cooking, "dryer"))
        assertEquals(original.wallet, cooking.wallet)
        assertEquals(mapOf("fish_common" to 1L, "wood" to 3L), cooking.inventory)
        assertEquals(recipe.cost, job.cost)
        assertEquals(recipe.rewards, job.rewards)
        assertEquals(now.plusSeconds(recipe.seconds), Instant.parse(job.finishesAt))
        val ready = Instant.parse(job.finishesAt)
        failure("ECONOMY_BUILDING_BUSY") { apply(cooking, "start_construction", "dryer") }
        failure("ECONOMY_BUILDING_BUSY") { apply(cooking, "start_construction", "dryer", ready) }
        failure("ECONOMY_BUILDING_BUSY") { apply(cooking, "start_production", recipe.id, ready) }
        val claimed = apply(cooking, "claim_job", job.id, ready)
        assertEquals(mapOf("fish_common" to 1L, "wood" to 3L, "grilled_fish" to 1L), claimed.inventory)
        assertEquals(1L, claimed.progression.recipes[recipe.id])
        assertEquals(0, claimed.buildings["dryer"])
    }

    @Test fun `food reachability respects the recipe level and leaves other kitchen sources locked`() {
        val state = EconomyRules.initial()
        val reachable = EconomyFood.obtainableOrderItems(state)
        assertTrue("grilled_fish" in reachable)
        for (id in listOf("fish_soup", "berry_compote", "berry_fish")) assertFalse(id in reachable)
        assertTrue("berry_compote" in EconomyFood.obtainableOrderItems(state.copy(buildings = state.buildings + ("dryer" to 1))))
    }

    @Test fun `all other campfire recipes and slot purchases remain locked at zero`() {
        val state = EconomyRules.initial().copy(buildings = EconomyRules.initial().buildings + ("home" to 5),
            inventory = EconomyRules.catalog.items.associate { it.id to 1L },
            progression = EconomyProgression(recipes = EconomyRules.catalog.recipes.associate { it.id to 100L }))
        for (other in EconomyRules.catalog.recipes.filter { it.buildingId == "dryer" && it.id != recipe.id }) {
            assertTrue(other.buildingLevel >= 1)
            failure("ECONOMY_BUILDING_REQUIRED") { apply(state, "start_production", other.id) }
        }
        failure("ECONOMY_BUILDING_REQUIRED") { apply(state, "start_production", "make_planks") }
        failure("ECONOMY_BUILDING_REQUIRED") { apply(state, "buy_production_slot", "dryer") }
        assertTrue(state.jobs.isEmpty())
    }

    @Test fun `base cooking retains resource batch and construction locks and level one opens existing recipes`() {
        val original = EconomyRules.initial()
        failure("ECONOMY_RESOURCES") { apply(original, "start_production", recipe.id) }
        val stocked = original.copy(inventory = original.inventory + ("fish_common" to 2L))
        failure("INVALID_ECONOMY_COMMAND") { apply(stocked, "start_production", recipe.id, quantity = 2) }
        val building = apply(stocked, "start_construction", "dryer")
        val job = building.jobs.single()
        assertEquals(0, building.buildings["dryer"])
        assertEquals(1, job.targetLevel)
        assertEquals(upgrade.cost, job.cost)
        assertEquals(now.plusSeconds(upgrade.seconds), Instant.parse(job.finishesAt))
        failure("ECONOMY_BUILDING_BUSY") { apply(building, "start_production", recipe.id) }
        val ready = Instant.parse(job.finishesAt)
        val claimed = apply(building, "claim_job", job.id, ready)
        assertEquals(1, claimed.buildings["dryer"])
        val compote = apply(claimed.copy(inventory = claimed.inventory + ("berries" to 3L)), "start_production", "cook_compote", ready)
        assertEquals("cook_compote", compote.jobs.single().recipeId)
    }

    @Test fun `legacy paid results retain snapshots and upgraded campfires retain paid capacity`() {
        val cooking = apply(EconomyRules.initial().copy(inventory = mapOf("fish_common" to 1L)), "start_production", recipe.id)
        val job = cooking.jobs.single().copy(catalogVersion = 10)
        val claimed = apply(cooking.copy(jobs = listOf(job)), "claim_job", job.id, Instant.parse(job.finishesAt))
        assertEquals(cooking.wallet, claimed.wallet)
        assertEquals(0, claimed.buildings["dryer"])
        assertEquals(mapOf("grilled_fish" to 1L), claimed.inventory)
        val upgraded = claimed.copy(buildings = claimed.buildings + ("dryer" to 3),
            inventory = claimed.inventory + ("fish_common" to 2L), productionSlots = mapOf("dryer" to 2))
        val parallel = apply(apply(upgraded, "start_production", recipe.id), "start_production", recipe.id)
        assertEquals(3, parallel.buildings["dryer"])
        assertEquals(2, parallel.jobs.size)
    }

    @Test fun `serialized catalog keeps positive wire levels and only the explicit grilled fish flag opens the base fire`() {
        val httpJson = Json { ignoreUnknownKeys = false; explicitNulls = true; encodeDefaults = true }
        val wire = httpJson.parseToJsonElement(httpJson.encodeToString(EconomyRules.catalog)).jsonObject
        val recipes = wire.getValue("recipes").jsonArray.map { it.jsonObject }
        assertTrue(recipes.all { it.getValue("buildingLevel").jsonPrimitive.int > 0 })
        val grilled = recipes.single { it.getValue("id").jsonPrimitive.content == "cook_grilled_fish" }
        assertEquals(1, grilled.getValue("buildingLevel").jsonPrimitive.int)
        assertEquals(true, grilled.getValue("baseCampfire").jsonPrimitive.boolean)
        assertTrue(recipes.filter { it.getValue("id").jsonPrimitive.content != "cook_grilled_fish" }
            .all { "baseCampfire" !in it }, "already loaded clients require ordinary recipes to omit the nullable flag")
        assertEquals(EconomyRules.catalog, httpJson.decodeFromString<EconomyCatalog>(wire.toString()))
        assertFalse("effectiveBuildingLevel" in grilled, "the computed policy is not serialized over the legacy level")
        assertEquals(0, recipe.copy().effectiveBuildingLevel)
        assertFailsWith<IllegalArgumentException> { recipe.copy(buildingLevel = 0) }
        assertFailsWith<IllegalArgumentException> { recipe.copy(buildingLevel = -1) }
        assertFailsWith<IllegalArgumentException> { recipe.copy(buildingLevel = 2) }
        assertFailsWith<IllegalArgumentException> { recipe.copy(id = "cook_compote") }
        assertFailsWith<IllegalArgumentException> { recipe.copy(buildingId = "workshop") }
        assertFailsWith<IllegalArgumentException> { recipe.copy(baseCampfire = false) }
        assertEquals(1, recipe.copy(baseCampfire = null).effectiveBuildingLevel)
    }
}
