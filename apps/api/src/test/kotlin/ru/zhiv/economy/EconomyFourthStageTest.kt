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

class EconomyFourthStageTest {
    private val now = Instant.parse("2026-10-14T13:00:00Z")
    private val course get() = EconomyRules.catalog.stageOrders.single { it.homeLevel == 4 }
    private fun command(action: String, target: String) =
        EconomyCommand(UUID.randomUUID().toString(), "ABCD-EFGH-JKMP", 0, action, target)
    private fun apply(state: EconomyState, action: String, target: String, at: Instant = now) =
        EconomyRules.apply(state, command(action, target), at).first
    private fun player(home: Int = 4) = EconomyRules.initial().let { initial -> initial.copy(
        wallet = EconomyWallet(100_000, 0), inventory = emptyMap(),
        buildings = initial.buildings + mapOf("home" to home, "woodlot" to 4, "workshop" to 4,
            "quarry" to 4, "kiln" to 4, "dryer" to 3, "bridge" to 1, "lighthouse" to 1),
        tutorialOrder = EconomyTutorialOrder()) }
    private fun fails(code: String, block: () -> Unit) = assertEquals(code, assertFailsWith<AuthFailure>(block = block).code)
    private fun atStep(state: EconomyState, index: Int, terms: EconomyResidentOrderTemplate = course.orders[index]) =
        state.copy(stageOrders = EconomyStageOrderState(stages = mapOf("4" to EconomyStageOrderProgress(
            step = index, terms = terms, availableAt = now.toString(), intervalSeconds = course.intervalSeconds,
            completionRewards = course.completionRewards))))

    @Test fun `twelve daily requests require claimed ruins and award both guaranteed relics only once`() {
        assertEquals(12, course.orders.size)
        assertEquals(86400L, course.intervalSeconds)
        assertEquals(mapOf("ancient_core" to 1L, "moon_crystal" to 1L), course.completionRewards)
        assertEquals(mapOf("ancient_ruins" to 1L), course.orders.last().requiredExplorations)
        assertEquals(1, course.orders.last().requiredBuildings["lighthouse"])
        var state = player().copy(progression = EconomyProgression(routes = mapOf("ancient_ruins" to 1L)))
        val initialCoins = state.wallet.coins
        var at = now
        for ((index, terms) in course.orders.withIndex()) {
            assertEquals(terms, EconomyStageOrders.offer(state))
            state = state.copy(inventory = terms.items)
            if (index > 0) {
                val saved = economyJson.encodeToString(state)
                fails("ECONOMY_STAGE_WAIT") { apply(state, "complete_resident_order", terms.id, at.minusNanos(1)) }
                assertEquals(saved, economyJson.encodeToString(state))
            }
            state = apply(state, "complete_resident_order", terms.id, at)
            assertEquals(index + 1, EconomyStageOrders.progress(state).step)
            assertEquals(if (index == course.orders.lastIndex) course.completionRewards else emptyMap(), state.inventory)
            if (index != course.orders.lastIndex) at = at.plusSeconds(course.intervalSeconds)
        }
        assertEquals(now.plusSeconds(11 * 86400L), at)
        assertEquals(initialCoins + course.orders.sumOf { it.coins }, state.wallet.coins)
        assertTrue(EconomyStageOrders.progress(state).completed)
        assertTrue(state.unlockedItems.containsAll(course.completionRewards.keys))
        assertNull(EconomyStageOrders.offer(state))
        fails("ECONOMY_STAGE_ORDER_UNAVAILABLE") { apply(state, "complete_resident_order", course.orders.last().id, at) }
        assertEquals(state, economyJson.decodeFromString<EconomyState>(economyJson.encodeToString(state)))
    }

    @Test fun `saved building and exploration prerequisites reject a delivery before any debit or progress`() {
        val last = course.orders.last()
        val supplied = atStep(player().copy(inventory = last.items), course.orders.lastIndex)
        val missingLight = supplied.copy(buildings = supplied.buildings + ("lighthouse" to 0),
            progression = EconomyProgression(routes = mapOf("ancient_ruins" to 1L)))
        val missingTrip = supplied
        for ((state, code) in listOf(missingLight to "ECONOMY_BUILDING_REQUIRED", missingTrip to "ECONOMY_EXPLORATION_REQUIRED")) {
            val before = economyJson.encodeToString(state)
            fails(code) { apply(state, "complete_resident_order", last.id) }
            assertEquals(before, economyJson.encodeToString(state), "Rejected delivery preserves goods, wallet and saved terms")
        }
        val pinned = EconomyStageOrders.pin(supplied, now = now)
        val changed = EconomyRules.catalog.copy(stageOrders = EconomyRules.catalog.stageOrders.map { stage ->
            if (stage.homeLevel == 4) stage.copy(orders = stage.orders.map { it.copy(requiredBuildings = emptyMap(), requiredExplorations = emptyMap()) }) else stage
        })
        assertEquals(pinned, EconomyStageOrders.pin(pinned, changed, now.plusSeconds(100)))
        assertEquals(last.requiredExplorations, EconomyStageOrders.offer(pinned, changed)!!.requiredExplorations)
    }

    @Test fun `starting cancelling and reading a ruin job do not satisfy the final expedition requirement`() {
        val route = EconomyRules.catalog.explorations.single { it.id == "ancient_ruins" }
        assertEquals(36000L, route.seconds)
        assertTrue(route.requiredBuildings["bridge"] == 1 && route.requiredBuildings["lighthouse"] == 1)
        val start = atStep(player().copy(inventory = route.cost.items), course.orders.lastIndex)
        val travelling = apply(start, "start_exploration", route.id)
        assertEquals(0L, travelling.progression.routes[route.id] ?: 0L)
        assertEquals(0L, EconomyStageOrders.pin(travelling, now = now).progression.routes[route.id] ?: 0L)
        val job = travelling.jobs.single()
        val cancelled = apply(travelling, "cancel_exploration", job.id)
        assertEquals(0L, cancelled.progression.routes[route.id] ?: 0L)
        val end = Instant.parse(job.finishesAt)
        fails("ECONOMY_JOB_NOT_READY") { apply(travelling, "claim_job", job.id, end.minusNanos(1)) }
        val claimed = apply(travelling, "claim_job", job.id, end)
        assertEquals(1L, claimed.progression.routes[route.id])
        assertTrue(claimed.inventory.values.sum() <= 50L, "One complete route fits the free warehouse")
        fails("ECONOMY_JOB_GONE") { apply(claimed, "claim_job", job.id, end) }
        val delivered = apply(claimed.copy(inventory = course.orders.last().items), "complete_resident_order", course.orders.last().id, end)
        assertTrue(EconomyStageOrders.progress(delivered).completed)
    }

    @Test fun `bridge and lighthouse are generic single upgrades with absent historical keys treated as zero`() {
        assertEquals(0, EconomyRules.initial().buildings["bridge"])
        assertEquals(0, EconomyRules.initial().buildings["lighthouse"])
        for (id in listOf("bridge", "lighthouse")) {
            val building = EconomyRules.catalog.buildings.single { it.id == id }
            val upgrade = building.levels.single()
            assertEquals(1, upgrade.level)
            assertEquals(4, upgrade.requiredHomeLevel)
            assertTrue(upgrade.seconds in 1L..86400L, "Restoration finishes within a day")
            assertTrue(upgrade.cost.items.values.sum() <= 50L)
            val supplied = player().copy(wallet = EconomyWallet(upgrade.cost.coins), inventory = upgrade.cost.items,
                buildings = (player().buildings + upgrade.requiredBuildings) - id)
            val early = supplied.copy(buildings = supplied.buildings + ("home" to 3))
            fails("ECONOMY_HOME_REQUIRED") { apply(early, "start_construction", id) }
            val started = apply(supplied, "start_construction", id)
            assertEquals(upgrade.cost, started.jobs.single().cost)
            assertEquals(9, started.jobs.single().catalogVersion)
            assertEquals(EconomyWallet(), started.wallet)
            assertTrue(started.inventory.isEmpty())
            assertEquals(0, started.buildings[id] ?: 0)
            val finished = apply(started, "claim_job", started.jobs.single().id, Instant.parse(started.jobs.single().finishesAt))
            assertEquals(1, finished.buildings[id])
            assertTrue(finished.jobs.isEmpty())
            fails("ECONOMY_MAX_LEVEL") { apply(finished, "start_construction", id) }
        }
    }

    @Test fun `home five needs completed project and restored structures without a warehouse requirement`() {
        val upgrade = EconomyRules.catalog.buildings.single { it.id == "home" }.levels.single { it.level == 5 }
        assertTrue(upgrade.seconds in 1L..172800L, "The house itself takes at most two days")
        assertTrue(upgrade.cost.items.values.sum() <= 50L)
        assertEquals(1, upgrade.requiredBuildings["bridge"])
        assertEquals(1, upgrade.requiredBuildings["lighthouse"])
        assertFalse("warehouse" in upgrade.requiredBuildings)
        val supplied = player().copy(wallet = EconomyWallet(upgrade.cost.coins), inventory = upgrade.cost.items)
        fails("ECONOMY_STAGE_REQUIRED") { apply(supplied, "start_construction", "home") }
        val done = supplied.copy(stageOrders = EconomyStageOrderState(stages = mapOf("4" to EconomyStageOrderProgress(12, true))))
        for (missing in listOf("bridge", "lighthouse")) {
            fails("ECONOMY_BUILDING_REQUIRED") { apply(done.copy(buildings = done.buildings - missing), "start_construction", "home") }
        }
        val started = apply(done, "start_construction", "home")
        assertEquals(5, started.jobs.single().targetLevel)
        assertEquals(1, started.buildings["warehouse"])
        val finished = apply(started, "claim_job", started.jobs.single().id, Instant.parse(started.jobs.single().finishesAt))
        assertEquals(5, finished.buildings["home"])
        assertNull(EconomyStageOrders.offer(finished))
    }

    @Test fun `existing home five and all older paid jobs remain valid without new restoration gates`() {
        val advanced = player(5).copy(buildings = player(5).buildings - setOf("bridge", "lighthouse"))
        assertNull(EconomyStageOrders.offer(advanced))
        assertFalse(EconomyStageOrders.required(advanced, 5))
        assertEquals(5, EconomyStageOrders.pin(advanced, now = now).buildings["home"])
        for (version in 1..8) {
            val paid = EconomyJob(UUID.randomUUID().toString(), "construction", "home", targetLevel = 5,
                startedAt = now.minusSeconds(864000).toString(), finishesAt = now.toString(),
                cost = EconomyCost(220000, mapOf("beams" to 100L, "moon_crystal" to 1L)), catalogVersion = version)
            val original = player().copy(wallet = EconomyWallet(321, 0), inventory = emptyMap(),
                buildings = player().buildings - setOf("bridge", "lighthouse"), jobs = listOf(paid))
            val restored = economyJson.decodeFromString<EconomyState>(economyJson.encodeToString(original))
            assertEquals(paid, restored.jobs.single())
            val finished = apply(restored, "claim_job", paid.id)
            assertEquals(5, finished.buildings["home"])
            assertEquals(original.wallet, finished.wallet)
            assertEquals(original.inventory, finished.inventory)
            assertNull(EconomyStageOrders.offer(finished))
        }
    }

    @Test fun `legacy saved terms default empty expedition gates and omit the new field on serialization`() {
        val first = course.orders.first().copy(requiredExplorations = emptyMap())
        val encoded = economyJson.encodeToJsonElement(first).jsonObject
        assertFalse("requiredExplorations" in encoded)
        val legacy = economyJson.decodeFromString<EconomyResidentOrderTemplate>(
            JsonObject(encoded - setOf("requiredBuildings", "requiredExplorations")).toString())
        assertTrue(legacy.requiredBuildings.isEmpty())
        assertTrue(legacy.requiredExplorations.isEmpty())
        val state = atStep(player().copy(inventory = legacy.items), 0, legacy)
        val delivered = apply(state, "complete_resident_order", legacy.id)
        assertEquals(1, EconomyStageOrders.progress(delivered).step)
    }
}
