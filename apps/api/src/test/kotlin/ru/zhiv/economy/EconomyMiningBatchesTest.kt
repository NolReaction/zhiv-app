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
        val started = act(player(), "start_exploration", "quarry_stone", 8)
        val job = started.jobs.single()
        assertEquals(now.plusSeconds(1440).toString(), job.finishesAt)
        val partial = act(started, "claim_job", job.id, seconds = 600)
        assertEquals(3L, partial.inventory["stone"])
        assertEquals(3, partial.jobs.single().miningBatch?.claimed)
        assertEquals(3L, partial.progression.routes["quarry_stone"])
        assertEquals(540L, partial.progression.collections.quarrySeconds)
        assertEquals(job.finishesAt, partial.jobs.single().finishesAt)
        assertEquals("ECONOMY_JOB_NOT_READY", assertFailsWith<AuthFailure> { act(partial, "claim_job", job.id, seconds = 600) }.code)
        val completed = act(partial, "claim_job", job.id, seconds = 1440)
        assertEquals(8L, completed.inventory["stone"])
        assertTrue(completed.jobs.isEmpty())
    }

    @Test fun `full storage preserves ready work when stopping the rest`() {
        val started = act(player().copy(inventory = mapOf("wood" to 50L)), "start_exploration", "quarry_stone", 8)
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
            Triple("quarry_stone", 101L, "INVALID_ECONOMY_COMMAND"), Triple("quarry_stone", 9L, "INVALID_ECONOMY_COMMAND"))) {
            assertEquals(code, assertFailsWith<AuthFailure> { act(player(), "start_exploration", target, quantity) }.code)
        }
    }

    @Test fun `new orders respect quarry level and an hour of base work`() {
        assertEquals(listOf(5, 8, 10, 12, 15), (1..5).map { EconomyMiningBatches.limit(it, 180) })
        assertEquals(listOf(12, 6, 4, 3), listOf(300L, 600L, 900L, 1200L).map { EconomyMiningBatches.limit(5, it) })
        for ((route, cap) in listOf("quarry_ore" to 6L, "quarry_quartz" to 4L, "quarry_limestone" to 3L)) {
            val state = player().let { it.copy(buildings = it.buildings + mapOf("home" to 5, "quarry" to 5)) }
            assertEquals("INVALID_ECONOMY_COMMAND", assertFailsWith<AuthFailure> { act(state, "start_exploration", route, cap + 1) }.code)
            assertEquals(cap.toInt(), act(state, "start_exploration", route, cap).jobs.single().miningBatch?.quantity)
        }
    }

    @Test fun `saved hundred unit queues drain through storage limits without the new launch cap`() {
        val started = act(player(), "start_exploration", "quarry_stone", 5)
        val job = started.jobs.single().let { it.copy(miningBatch = it.miningBatch!!.copy(quantity = 100), finishesAt = now.plusSeconds(18000).toString()) }
        val partial = act(started.copy(jobs = listOf(job)), "claim_job", job.id, seconds = 18000)
        assertEquals(50L, partial.inventory["stone"])
        assertEquals(50, partial.jobs.single().miningBatch?.claimed)
        val rest = act(partial.copy(inventory = emptyMap()), "claim_job", job.id, seconds = 18000)
        assertEquals(50L, rest.inventory["stone"])
        assertTrue(rest.jobs.isEmpty())
        assertEquals(100L, rest.progression.routes["quarry_stone"])
    }

    @Test fun `explicit one unit collection preserves the queue deadline and awards only its work`() {
        val started = act(player(), "start_exploration", "quarry_stone", 8)
        val job = started.jobs.single()
        val first = act(started, "claim_mining_batch", job.id, seconds = 1440)
        assertEquals(1L, first.inventory["stone"])
        assertEquals(1, first.jobs.single().miningBatch!!.claimed)
        assertEquals(job.startedAt, first.jobs.single().startedAt)
        assertEquals(job.finishesAt, first.jobs.single().finishesAt)
        assertEquals(44L, first.progression.player!!.xp)
        assertEquals(180L, first.progression.player.workSeconds)
        val second = act(first, "claim_mining_batch", job.id, seconds = 1440)
        assertEquals(2L, second.inventory["stone"])
        assertEquals(48L, second.progression.player!!.xp)
        val rest = act(second, "claim_job", job.id, seconds = 1440)
        assertEquals(8L, rest.inventory["stone"])
        assertEquals(72L, rest.progression.player!!.xp)
        assertTrue(rest.jobs.isEmpty())
    }

    @Test fun `selected collection after cancellation respects readiness and available capacity`() {
        val started = act(player(), "start_exploration", "quarry_stone", 8)
        val id = started.jobs.single().id
        assertEquals("ECONOMY_JOB_NOT_READY", assertFailsWith<AuthFailure> { act(started, "claim_mining_batch", id, seconds = 179) }.code)
        val first = act(started, "claim_mining_batch", id, seconds = 600)
        val stopped = act(first, "cancel_exploration", id, seconds = 600)
        assertEquals(3, stopped.jobs.single().miningBatch!!.quantity)
        assertEquals(1, stopped.jobs.single().miningBatch!!.claimed)
        val partial = act(stopped.copy(inventory = stopped.inventory + ("wood" to 48L)), "claim_mining_batch", id, 100, 600)
        assertEquals(2L, partial.inventory["stone"])
        assertEquals(2, partial.jobs.single().miningBatch!!.claimed)
        assertEquals("ECONOMY_STORAGE_FULL", assertFailsWith<AuthFailure> { act(partial, "claim_mining_batch", id, seconds = 600) }.code)
        val rest = act(partial.copy(inventory = partial.inventory - "wood"), "claim_mining_batch", id, 100, 600)
        assertEquals(3L, rest.inventory["stone"])
        assertTrue(rest.jobs.isEmpty())
    }

    @Test fun `selected collection rejects unrelated job kinds and invalid quantities`() {
        val started = act(player(), "start_exploration", "quarry_stone", 3)
        val job = started.jobs.single()
        for (quantity in listOf(0L, -1L, 101L))
            assertEquals("INVALID_ECONOMY_COMMAND", assertFailsWith<AuthFailure> { act(started, "claim_mining_batch", job.id, quantity, 600) }.code)
        val construction = EconomyJob(job.id, "construction", "home", targetLevel = 3,
            startedAt = job.startedAt, finishesAt = job.finishesAt)
        for (other in listOf(job.copy(actorId = "mochlik", miningBatch = null), job.copy(miningBatch = null), construction))
            assertEquals("INVALID_ECONOMY_COMMAND", assertFailsWith<AuthFailure> { act(started.copy(jobs = listOf(other)), "claim_mining_batch", other.id, seconds = 600) }.code)
    }
}
