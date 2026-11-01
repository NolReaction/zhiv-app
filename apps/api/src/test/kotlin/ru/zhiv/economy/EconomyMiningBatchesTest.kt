package ru.zhiv.economy

import org.junit.jupiter.api.Test
import ru.zhiv.auth.AuthFailure
import java.time.Instant
import java.util.UUID
import kotlin.test.*

class EconomyMiningBatchesTest {
    private val now = Instant.parse("2026-11-01T10:00:00Z")
    private fun player() = EconomyRules.initial().let { it.copy(inventory = emptyMap(),
        buildings = it.buildings + mapOf("home" to 2, "quarry" to 2), tutorialOrder = it.tutorialOrder.copy(completed = true)) }
    private fun act(state: EconomyState, action: String, target: String, quantity: Long = 1, seconds: Long = 0) =
        EconomyRules.apply(state, EconomyCommand(UUID.randomUUID().toString(), "ABCD-EFGH-JKMP", 0, action, target, quantity), now.plusSeconds(seconds)).first

    @Test fun `offline queue supports partial claims without restarting the saved clock`() {
        val started = act(player(), "start_exploration", "quarry_stone", 10)
        val job = started.jobs.single()
        assertEquals(now.plusSeconds(1800).toString(), job.finishesAt)
        val partial = act(started, "claim_job", job.id, seconds = 600)
        assertEquals(3L, partial.inventory["stone"])
        assertEquals(3, partial.jobs.single().miningBatch?.claimed)
        assertEquals(3L, partial.progression.routes["quarry_stone"])
        assertEquals(540L, partial.progression.collections.quarrySeconds)
        assertEquals(job.finishesAt, partial.jobs.single().finishesAt)
        assertEquals("ECONOMY_JOB_NOT_READY", assertFailsWith<AuthFailure> { act(partial, "claim_job", job.id, seconds = 600) }.code)
        val completed = act(partial, "claim_job", job.id, seconds = 1800)
        assertEquals(10L, completed.inventory["stone"])
        assertTrue(completed.jobs.isEmpty())
    }

    @Test fun `full storage preserves ready work when stopping the rest`() {
        val started = act(player().copy(inventory = mapOf("wood" to 50L)), "start_exploration", "quarry_stone", 10)
        val id = started.jobs.single().id
        val stopped = act(started, "cancel_exploration", id, seconds = 600)
        assertEquals(3, stopped.jobs.single().miningBatch?.quantity)
        assertEquals(0, stopped.jobs.single().miningBatch?.claimed)
        val claimed = act(stopped.copy(inventory = emptyMap()), "claim_job", id, seconds = 600)
        assertEquals(3L, claimed.inventory["stone"])
        assertTrue(claimed.jobs.isEmpty())
    }

    @Test fun `claim takes only the prefix that fits and does not lose the remaining units`() {
        val started = act(player().copy(inventory = mapOf("wood" to 49L)), "start_exploration", "quarry_stone", 5)
        val id = started.jobs.single().id
        val partial = act(started, "claim_job", id, seconds = 540)
        assertEquals(1L, partial.inventory["stone"])
        assertEquals(1, partial.jobs.single().miningBatch?.claimed)
        assertEquals("ECONOMY_STORAGE_FULL", assertFailsWith<AuthFailure> { act(partial, "claim_job", id, seconds = 540) }.code)
        val rest = act(partial.copy(inventory = partial.inventory - "wood"), "claim_job", id, seconds = 540)
        assertEquals(3L, rest.inventory["stone"])
        assertEquals(3, rest.jobs.single().miningBatch?.claimed)
    }

    @Test fun `ordinary expeditions remain single and the mining queue has finite bounds`() {
        for ((target, quantity, code) in listOf(Triple("forest", 2L, "INVALID_ECONOMY_COMMAND"),
            Triple("quarry_stone", 101L, "INVALID_ECONOMY_COMMAND"), Triple("quarry_stone", 51L, "ECONOMY_STORAGE_FULL"))) {
            assertEquals(code, assertFailsWith<AuthFailure> { act(player(), "start_exploration", target, quantity) }.code)
        }
    }
}
