package ru.zhiv.economy

import kotlinx.serialization.encodeToString
import org.junit.jupiter.api.Test
import ru.zhiv.auth.AuthFailure
import java.time.Duration
import java.time.Instant
import java.util.UUID
import kotlin.test.*

class EconomyTutorialHarvestTest {
    private val now = Instant.parse("2026-10-21T12:00:00Z")
    private val recipe get() = EconomyRules.catalog.recipes.single { it.id == "grow_berries" }
    private fun command(action: String, target: String = "grow_berries", quantity: Long = 1) =
        EconomyCommand(UUID.randomUUID().toString(), "ABCD-EFGH-JKMP", 0, action, target, quantity)
    private fun apply(state: EconomyState, action: String, target: String = "grow_berries", at: Instant = now) =
        EconomyRules.apply(state, command(action, target), at).first
    private fun reload(state: EconomyState) = economyJson.decodeFromString<EconomyState>(economyJson.encodeToString(state))
    private fun duration(job: EconomyJob) = Duration.between(Instant.parse(job.startedAt), Instant.parse(job.finishesAt))
    private fun fails(code: String, block: () -> Unit) = assertEquals(code, assertFailsWith<AuthFailure>(block = block).code)

    @Test fun `ordinary production always uses the catalog timer and does not silently claim teaching aid`() {
        val fresh = EconomyRules.initial()
        assertTrue(EconomyTutorialOrders.canPrepareFirstHarvest(fresh, recipe.id, 1))
        val started = apply(fresh, "start_production")
        assertEquals(Duration.ofSeconds(recipe.seconds), duration(started.jobs.single()))
        assertFalse(started.tutorialOrder.firstHarvestPrepared)
        val cancelled = reload(apply(started, "cancel_production", started.jobs.single().id, now.plusSeconds(1)))
        assertTrue(EconomyTutorialOrders.canPrepareFirstHarvest(cancelled, recipe.id, 1))
        assertEquals(Duration.ofSeconds(recipe.seconds), duration(apply(cancelled, "start_production").jobs.single()))
        assertEquals(fresh.wallet, cancelled.wallet); assertEquals(fresh.inventory, cancelled.inventory)
    }

    @Test fun `explicit first harvest persists its fence and still requires the saved eight second collection`() {
        val fresh = EconomyRules.initial()
        val started = reload(apply(fresh, "start_tutorial_harvest"))
        val job = started.jobs.single()
        assertEquals(Duration.ofMillis(1), duration(job)); assertTrue(started.tutorialOrder.firstHarvestPrepared)
        assertEquals(fresh.wallet, started.wallet); assertEquals(fresh.inventory, started.inventory)
        assertEquals(fresh.progression, started.progression)
        fails("ECONOMY_TUTORIAL_HARVEST_UNAVAILABLE") { apply(started, "start_tutorial_harvest") }
        val request = command("start_garden_collection", job.id)
        val collecting = reload(EconomyRules.apply(started, request, now.plusMillis(1)).first)
        val collection = checkNotNull(collecting.jobs.single().collection)
        assertEquals(Duration.ofSeconds(8), Duration.between(Instant.parse(collection.startedAt), Instant.parse(collection.finishesAt)))
        fails("ECONOMY_COLLECTION_NOT_READY") { apply(collecting, "claim_garden_collection", request.requestId, now.plusMillis(8000)) }
        val delivered = reload(apply(collecting, "claim_garden_collection", request.requestId, now.plusMillis(8001)))
        assertEquals(1L, delivered.inventory["berries"]); assertEquals(1L, delivered.progression.recipes[recipe.id])
        assertTrue(delivered.jobs.isEmpty()); assertTrue(delivered.tutorialOrder.firstHarvestPrepared)
        fails("ECONOMY_JOB_GONE") { apply(delivered, "claim_garden_collection", request.requestId, now.plusSeconds(9)) }
        val sold = apply(delivered, "sell", "berries", now.plusSeconds(9))
        fails("ECONOMY_TUTORIAL_HARVEST_UNAVAILABLE") { apply(sold, "start_tutorial_harvest") }
        assertEquals(Duration.ofSeconds(recipe.seconds), duration(apply(sold, "start_production").jobs.single()))
    }

    @Test fun `cancelling an accepted teaching crop does not restore its consumed aid`() {
        val started = apply(EconomyRules.initial(), "start_tutorial_harvest")
        val cancelled = reload(apply(started, "cancel_production", started.jobs.single().id))
        assertTrue(cancelled.jobs.isEmpty()); assertTrue(cancelled.tutorialOrder.firstHarvestPrepared)
        fails("ECONOMY_TUTORIAL_HARVEST_UNAVAILABLE") { apply(cancelled, "start_tutorial_harvest") }
        assertEquals(Duration.ofSeconds(recipe.seconds), duration(apply(cancelled, "start_production").jobs.single()))
    }

    @Test fun `invalid aid and capacity failures neither consume the fence nor mutate existing resources`() {
        val initial = EconomyRules.initial()
        for (request in listOf(command("start_tutorial_harvest", "grow_blueberries"),
            command("start_tutorial_harvest", "grow_berries@fish_common"), command("start_tutorial_harvest", quantity = 2),
            command("start_tutorial_harvest").copy(totalPrice = 1), command("start_tutorial_harvest").copy(fishSelection = mapOf("fish_common" to 1L)))) {
            fails("INVALID_ECONOMY_COMMAND") { EconomyRules.apply(initial, request, now) }
            assertFalse(initial.tutorialOrder.firstHarvestPrepared); assertTrue(initial.jobs.isEmpty())
        }
        val ordinary = apply(initial, "start_production").jobs.single()
        val full = initial.copy(jobs = List(18) { ordinary.copy(id = UUID.randomUUID().toString(), targetId = "workshop", collection = null) })
        val saved = economyJson.encodeToString(full)
        fails("ECONOMY_JOBS_CAPACITY") { apply(full, "start_tutorial_harvest") }
        assertEquals(saved, economyJson.encodeToString(full)); assertFalse(full.tutorialOrder.firstHarvestPrepared)
    }

    @Test fun `legacy completed or already harvested profiles keep normal work and their once-only merge fence`() {
        val fresh = EconomyRules.initial()
        val saved = listOf(EconomyRules.initial(includeStartingPack = false),
            fresh.copy(tutorialOrder = fresh.tutorialOrder.copy(completed = true)),
            fresh.copy(tutorialOrder = fresh.tutorialOrder.copy(firstHarvestPrepared = true)),
            fresh.copy(inventory = fresh.inventory + ("berries" to 1L)),
            fresh.copy(progression = fresh.progression.copy(recipes = mapOf("grow_berries" to 1L))))
        for (state in saved) {
            val before = economyJson.encodeToString(state)
            fails("ECONOMY_TUTORIAL_HARVEST_UNAVAILABLE") { apply(state, "start_tutorial_harvest") }
            assertEquals(before, economyJson.encodeToString(state))
            assertEquals(Duration.ofSeconds(recipe.seconds), duration(apply(state, "start_production").jobs.single()))
        }
        val spent = fresh.tutorialOrder.copy(firstHarvestPrepared = true)
        assertTrue(EconomyTutorialOrders.merge(spent, fresh.tutorialOrder).firstHarvestPrepared)
        assertTrue(EconomyTutorialOrders.merge(fresh.tutorialOrder, spent).firstHarvestPrepared)
    }
}
