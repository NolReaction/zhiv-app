package ru.zhiv.economy

import kotlinx.serialization.encodeToString
import org.junit.jupiter.api.Test
import ru.zhiv.auth.AuthFailure
import java.time.Instant
import java.util.UUID
import kotlin.test.*

class EconomyFirstHarvestTest {
    private val now = Instant.parse("2026-10-18T12:00:00Z")
    private fun command(action: String = "start_production", target: String = "grow_berries", quantity: Long = 1, price: Long = 0) =
        EconomyCommand(UUID.randomUUID().toString(), "ABCD-EFGH-JKMP", 0, action, target, quantity, price)
    private fun apply(state: EconomyState, action: String, target: String, at: Instant = now) =
        EconomyRules.apply(state, command(action, target), at).first
    private fun fails(code: String, block: () -> Unit) = assertEquals(code, assertFailsWith<AuthFailure>(block = block).code)

    @Test fun `first raspberry is ripe without visible delay but needs ordinary collection and delivery`() {
        val before = EconomyRules.initial()
        val started = apply(before, "start_production", "grow_berries")
        val job = started.jobs.single()
        assertEquals(now.plusMillis(1), Instant.parse(job.finishesAt)); assertEquals(now, Instant.parse(job.startedAt))
        assertTrue(started.tutorialOrder.firstHarvestPrepared); assertFalse(before.tutorialOrder.firstHarvestPrepared)
        assertEquals(before.wallet, started.wallet); assertEquals(before.inventory, started.inventory)
        fails("ECONOMY_COLLECTION_REQUIRED") { apply(started, "claim_job", job.id, now.plusMillis(1)) }
        val collecting = apply(started, "start_collection", job.id, now.plusMillis(1))
        assertEquals(now.plusMillis(8001), Instant.parse(collecting.jobs.single().collection!!.finishesAt))
        fails("ECONOMY_COLLECTION_NOT_READY") { apply(collecting, "claim_job", job.id, now.plusMillis(8000)) }
        val delivered = apply(collecting, "claim_job", job.id, now.plusMillis(8001))
        assertEquals(1L, delivered.inventory["berries"]); assertEquals(1L, delivered.progression.recipes["grow_berries"])
        val next = apply(delivered, "start_production", "grow_berries", now.plusSeconds(9)).jobs.single()
        assertEquals(now.plusSeconds(69), Instant.parse(next.finishesAt))
    }

    @Test fun `reload removal cancellation and a new request cannot renew consumed help`() {
        val started = apply(EconomyRules.initial(), "start_production", "grow_berries")
        val restored = economyJson.decodeFromString<EconomyState>(economyJson.encodeToString(started))
        assertTrue(restored.tutorialOrder.firstHarvestPrepared)
        fails("ECONOMY_CANCEL_READY") { apply(restored, "cancel_production", restored.jobs.single().id, now.plusMillis(1)) }
        assertFalse(EconomyTutorialOrders.canPrepareFirstHarvest(restored, "grow_berries", 1))
        // Even a frozen clock inside the first millisecond cannot cancel and
        // reacquire the teaching benefit under a different request UUID.
        val cancelled = apply(restored, "cancel_production", restored.jobs.single().id)
        assertTrue(cancelled.jobs.isEmpty()); assertTrue(cancelled.tutorialOrder.firstHarvestPrepared)
        assertEquals(restored.wallet, cancelled.wallet); assertEquals(restored.inventory, cancelled.inventory)
        val next = apply(cancelled, "start_production", "grow_berries", now.plusSeconds(1))
        assertEquals(now.plusSeconds(61), Instant.parse(next.jobs.single().finishesAt))
        assertTrue(next.tutorialOrder.firstHarvestPrepared)
    }

    @Test fun `existing completed legacy and progressed accounts keep their ordinary jobs`() {
        val fresh = EconomyRules.initial()
        val states = listOf(fresh.copy(tutorialOrder = fresh.tutorialOrder.copy(completed = true, step = 1)),
            fresh.copy(tutorialOrder = fresh.tutorialOrder.copy(version = 1)),
            fresh.copy(tutorialOrder = fresh.tutorialOrder.copy(terms = fresh.tutorialOrder.terms!!.copy(items = mapOf("berries" to 3L)))),
            fresh.copy(tutorialOrder = fresh.tutorialOrder.copy(firstHarvestPrepared = true)),
            fresh.copy(inventory = fresh.inventory + ("berries" to 1L)),
            fresh.copy(buildings = fresh.buildings + ("home" to 2)),
            fresh.copy(progression = fresh.progression.copy(recipes = mapOf("grow_berries" to 1L))))
        for (state in states) {
            val started = apply(state, "start_production", "grow_berries")
            assertEquals(now.plusSeconds(60), Instant.parse(started.jobs.single().finishesAt))
        }
        val oldJob = apply(fresh.copy(tutorialOrder = fresh.tutorialOrder.copy(firstHarvestPrepared = true)), "start_production", "grow_berries").jobs.single()
        assertFalse(EconomyTutorialOrders.canPrepareFirstHarvest(fresh.copy(jobs = listOf(oldJob)), "grow_berries", 1))
        val high = fresh.copy(buildings = fresh.buildings + mapOf("home" to 3, "garden" to 2))
        val ordinary = apply(high, "start_production", "grow_berries_large")
        assertEquals(now.plusSeconds(45), Instant.parse(ordinary.jobs.single().finishesAt))
        assertFalse(ordinary.tutorialOrder.firstHarvestPrepared)
    }

    @Test fun `rejected starts cannot consume aid and nonmatching recipes are ineligible`() {
        val fresh = EconomyRules.initial()
        for (cmd in listOf(command(quantity = 2), command(price = 1), command(target = "grow_berries@trout"), command(target = "unknown"))) {
            assertFailsWith<AuthFailure> { EconomyRules.apply(fresh, cmd, now) }
            assertFalse(fresh.tutorialOrder.firstHarvestPrepared)
            assertTrue(EconomyTutorialOrders.canPrepareFirstHarvest(fresh, "grow_berries", 1))
        }
        assertFalse(EconomyTutorialOrders.canPrepareFirstHarvest(fresh, "grow_berries", 2))
        assertFalse(EconomyTutorialOrders.canPrepareFirstHarvest(fresh, "grow_strawberries", 1))
        val full = fresh.copy(jobs = List(18) { EconomyJob(UUID.randomUUID().toString(), "production", "woodlot", "make_wood",
            startedAt = now.toString(), finishesAt = now.plusSeconds(60).toString(), rewards = mapOf("wood" to 1L),
            cost = EconomyCost(), catalogVersion = EconomyRules.catalog.version) })
        fails("ECONOMY_JOBS_CAPACITY") { apply(full, "start_production", "grow_berries") }
        assertFalse(full.tutorialOrder.firstHarvestPrepared)
    }

    @Test fun `merging retains consumed help regardless of which tutorial terms win`() {
        val fresh = EconomyRules.initial().tutorialOrder
        val consumed = fresh.copy(firstHarvestPrepared = true)
        val completed = fresh.copy(completed = true, step = 1)
        val legacy = EconomyTutorialOrder(ingredientsClaimed = true, completed = true, terms = fresh.terms)
        for (other in listOf(fresh, completed, legacy)) {
            for ((a, b) in listOf(consumed to other, other to consumed)) {
                val merged = EconomyTutorialOrders.merge(a, b)
                assertTrue(merged.firstHarvestPrepared)
                assertEquals(other.completed, merged.completed)
            }
        }
    }
}
