package ru.zhiv.economy

import org.junit.jupiter.api.Test
import ru.zhiv.auth.AuthFailure
import java.time.Instant
import java.util.UUID
import kotlin.test.*

class EconomyTapBoostTest {
    private val now = Instant.parse("2026-11-01T12:00:00Z")
    private fun job(id: String = "11111111-1111-4111-8111-111111111111", seconds: Long = 600) =
        EconomyJob(id, "production", "woodlot", recipeId = "gather_wood", startedAt = now.toString(), finishesAt = now.plusSeconds(seconds).toString(), rewards = mapOf("wood" to 1L))
    private fun state() = EconomyRules.initial().copy(jobs = listOf(job()))

    @Test fun `shared curve anchors and simultaneous batches agree`() {
        assertEquals(listOf(100, 900, 1700, 2000, 2000), listOf(1, 100, 500, 1000, 9000).map(EconomyTapBoost::powerBps))
        val once = EconomyTapBoost.credit(state(), 1000, now)
        val many = (1..1000).fold(state()) { current, _ -> EconomyTapBoost.credit(current, 1, now) }
        assertEquals(once, many)
        assertEquals(now.plusSeconds(60), Instant.parse(once.tapBoost.expiresAt))
        assertEquals(now.plusSeconds(600), Instant.parse(once.jobs.single().finishesAt))
    }

    @Test fun `offline settlement is limited and idempotent`() {
        val charged = EconomyTapBoost.credit(state(), 1000, now)
        val settled = EconomyTapBoost.settle(charged, now.plusSeconds(3600))
        assertEquals(now.plusSeconds(588), Instant.parse(settled.jobs.single().finishesAt))
        assertEquals(now.minusSeconds(12), Instant.parse(settled.jobs.single().startedAt))
        assertEquals(settled, EconomyTapBoost.settle(settled, now.plusSeconds(7200)))
        val restarted = EconomyTapBoost.credit(settled.copy(jobs = listOf(job(seconds = 8000))), 1, now.plusSeconds(3601))
        assertEquals(1, restarted.tapBoost.charge); assertEquals(100, restarted.tapBoost.powerBps)
    }

    @Test fun `completion is exact and construction is excluded`() {
        val short = state().copy(jobs = listOf(job(seconds = 3)))
        val settled = EconomyTapBoost.settle(EconomyTapBoost.credit(short, 1000, now), now.plusSeconds(10))
        assertEquals(now.plusMillis(2500), Instant.parse(settled.jobs.single().finishesAt))
        val building = state().copy(jobs = listOf(job().copy(kind = "construction", targetId = "home")))
        assertEquals(building, EconomyTapBoost.credit(building, 1000, now))
    }

    @Test fun `authoritative claim settles only elapsed work`() {
        val charged = EconomyTapBoost.credit(state().copy(jobs = listOf(job(seconds = 3))), 1000, now)
        val command = EconomyCommand(UUID.randomUUID().toString(), "ABCD-EFGH-JKMP", 0, "claim_job", charged.jobs.single().id)
        assertEquals("ECONOMY_JOB_NOT_READY", assertFailsWith<AuthFailure> {
            EconomyRules.apply(charged, command, now.plusMillis(2499))
        }.code)
        val claimed = EconomyRules.apply(charged, command, now.plusMillis(2500)).first
        assertTrue(claimed.jobs.isEmpty())
        assertEquals((charged.inventory["wood"] ?: 0) + 1, claimed.inventory["wood"])
        assertEquals("ECONOMY_JOB_GONE", assertFailsWith<AuthFailure> {
            EconomyRules.apply(claimed, command, now.plusMillis(2500))
        }.code)
    }

    @Test fun `ordinary tapping reaches cap without accelerating every slot`() {
        val initial = state().copy(jobs = listOf(job(), job("22222222-2222-4222-8222-222222222222", 700)))
        val maintained = (0 until 1000).fold(initial) { current, index -> EconomyTapBoost.credit(current, 1, now.plusMillis(index * 200L)) }
        assertEquals(1000, maintained.tapBoost.charge); assertEquals(2000, maintained.tapBoost.powerBps)
        assertEquals(initial.jobs[1], maintained.jobs[1])
    }
}
