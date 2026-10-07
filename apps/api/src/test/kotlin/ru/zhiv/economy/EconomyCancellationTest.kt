package ru.zhiv.economy

import kotlinx.serialization.json.*
import org.junit.jupiter.api.Test
import ru.zhiv.auth.AuthFailure
import java.time.Instant
import java.util.UUID
import kotlin.test.*

class EconomyCancellationTest {
    private val now = Instant.parse("2026-10-04T20:00:00Z")
    private fun command(action: String, target: String) = EconomyCommand(
        UUID.randomUUID().toString(), "ABCD-EFGH-JKMP", 0, action, target)
    private fun apply(state: EconomyState, action: String, target: String, at: Instant = now) =
        EconomyRules.apply(state, command(action, target), at).first

    @Test fun `active and ready fishing trips forfeit all rewards and never count as completed`() {
        for (route in listOf("shore", "shore_camp")) for (ready in listOf(false, true)) {
            val started = apply(EconomyRules.initial(), "start_exploration", route)
            val job = started.jobs.single()
            val at = if (ready) Instant.parse(job.finishesAt).plusSeconds(60) else now.plusSeconds(10)
            val cancelled = apply(started, "cancel_exploration", job.id, at)
            // A long trip can cross the independent twelve-hour order refresh.
            assertEquals(started.copy(jobs = emptyList(), residentOrders = EconomyFood.normalizedOrders(started, at)), cancelled)
            assertEquals("ECONOMY_JOB_GONE", assertFailsWith<AuthFailure> {
                apply(cancelled, "claim_job", job.id, at = Instant.parse(job.finishesAt))
            }.code)
            assertEquals("ECONOMY_JOB_GONE", assertFailsWith<AuthFailure> {
                apply(cancelled, "cancel_exploration", job.id, at)
            }.code)
            assertEquals(1, apply(cancelled, "start_exploration", "forest", at).jobs.size)
            assertEquals(1, started.jobs.size, "the domain transition leaves its input intact")
        }
    }

    @Test fun `already spent supplies and historic coin costs are never refunded`() {
        val route = EconomyRules.catalog.explorations.single { it.id == "deep_cave" }
        val initial = EconomyRules.initial().copy(wallet = EconomyWallet(73, 2),
            inventory = route.cost.items + ("fish" to 3L),
            buildings = EconomyRules.initial().buildings + route.requiredBuildings + ("home" to route.requiredHomeLevel))
        val started = apply(initial, "start_exploration", route.id)
        assertNotEquals(initial.inventory, started.inventory)
        val historic = started.copy(jobs = started.jobs.map { it.copy(cost = it.cost.copy(coins = 25)) })
        val result = apply(historic, "cancel_exploration", historic.jobs.single().id)
        assertEquals(started.inventory, result.inventory)
        assertEquals(started.wallet, result.wallet)
        assertEquals(0L, result.completedExplorations)
    }

    @Test fun `cancellation preserves other jobs and rejects nonexploration missing and already claimed targets`() {
        val growing = apply(EconomyRules.initial(), "start_production", "grow_berries")
        val production = growing.jobs.single()
        val started = apply(growing, "start_exploration", "shore")
        val job = started.jobs.single { it.kind == "exploration" }
        assertEquals(growing.copy(fishingCastSeed = started.fishingCastSeed), apply(started, "cancel_exploration", job.id))
        for (target in listOf("shore", UUID.randomUUID().toString())) assertEquals("ECONOMY_JOB_GONE", assertFailsWith<AuthFailure> {
            apply(started, "cancel_exploration", target)
        }.code)
        val construction = job.copy(id = UUID.randomUUID().toString(), kind = "construction", targetId = "home", targetLevel = 2, rewards = emptyMap())
        for (nonExploration in listOf(production, construction)) assertEquals("ECONOMY_CANCEL_KIND", assertFailsWith<AuthFailure> {
            apply(started.copy(jobs = listOf(nonExploration)), "cancel_exploration", nonExploration.id)
        }.code)
        val claimed = apply(started, "claim_job", job.id, Instant.parse(job.finishesAt))
        assertEquals("ECONOMY_JOB_GONE", assertFailsWith<AuthFailure> {
            apply(claimed, "cancel_exploration", job.id, Instant.parse(job.finishesAt))
        }.code)
        assertEquals(job.rewards, claimed.inventory)
        assertEquals(1L, claimed.completedExplorations)
    }

    @Test fun `full storage cannot block cancellation and quantity price and forged rewards are rejected`() {
        val started = apply(EconomyRules.initial(), "start_exploration", "shore").copy(inventory = mapOf("wood" to 200L))
        val cancel = command("cancel_exploration", started.jobs.single().id)
        for (invalid in listOf(cancel.copy(quantity = 2), cancel.copy(totalPrice = 1))) assertEquals("INVALID_ECONOMY_COMMAND", assertFailsWith<AuthFailure> {
            EconomyRules.apply(started, invalid, now)
        }.code)
        val json = economyJson.encodeToJsonElement(cancel).jsonObject
        assertEquals(cancel, decodeEconomyCommand(json))
        for (field in listOf("refund", "rewards", "completedExplorations")) assertEquals("INVALID_ECONOMY_COMMAND", assertFailsWith<AuthFailure> {
            decodeEconomyCommand(JsonObject(json + (field to JsonPrimitive(100))))
        }.code)
        val cancelled = EconomyRules.apply(started, cancel, now, mapOf("stone" to 10L)).first
        assertEquals(started.copy(jobs = emptyList()), cancelled)
        EconomyRules.assertStorageTransition(started, cancelled, mapOf("stone" to 10L))
    }
}
