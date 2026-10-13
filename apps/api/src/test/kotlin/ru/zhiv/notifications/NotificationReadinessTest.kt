package ru.zhiv.notifications

import org.junit.jupiter.api.Test
import ru.zhiv.economy.EconomyCollection
import ru.zhiv.economy.EconomyJob
import java.time.Instant
import kotlin.test.*

class NotificationReadinessTest {
    private val now = Instant.parse("2026-10-13T12:00:00Z")
    private fun job(id: String, kind: String = "production", target: String = "garden", finish: Instant = now.minusSeconds(1)) =
        EconomyJob(id, kind, target, startedAt = now.minusSeconds(600).toString(), finishesAt = finish.toString())
    private fun berries(id: String = "berries") = job(id).copy(rewards = mapOf("berries" to 20),
        collection = EconomyCollection("berry_harvest", 8, null, null))

    @Test fun `plain garden fiber and legacy berries do not require the actor or a harvest phase`() {
        listOf(job("fiber"), job("legacy").copy(rewards = mapOf("berries" to 2))).forEach {
            val status = notificationJobReadiness(it, listOf(it, job("trip", "exploration", "forest", now.plusSeconds(3600))), true, now)
            assertEquals(now.minusSeconds(1), status.dueAt)
            assertNull(status.phase); assertNull(status.blockedUntil)
        }
    }
    @Test fun `ripe berries wait for active travel or legacy mining but not their unclaimed return`() {
        val crop = berries()
        listOf(job("trip", "exploration", "forest", now.plusSeconds(600)),
            job("mine", target = "quarry", finish = now.plusSeconds(600))).forEach { busy ->
            assertEquals(now.plusSeconds(600), notificationJobReadiness(crop, listOf(crop, busy), false, now).dueAt)
            val returned = notificationJobReadiness(crop, listOf(crop, busy.copy(finishesAt = now.toString())), false, now)
            assertEquals(now, returned.dueAt); assertNull(returned.blockedUntil); assertEquals("harvest", returned.phase)
        }
    }
    @Test fun `another started collection owns actor until claim even after its timer`() {
        val crop = berries()
        val collecting = berries("other").copy(collection = EconomyCollection("berry_harvest", 8,
            now.minusSeconds(30).toString(), now.minusSeconds(22).toString()))
        assertEquals(now.plusSeconds(300), notificationJobReadiness(crop, listOf(crop, collecting), false, now).blockedUntil)
        assertNull(notificationJobReadiness(crop, listOf(crop), false, now).blockedUntil)
        assertEquals(now.plusSeconds(300), notificationJobReadiness(crop, listOf(crop), true, now).blockedUntil)
    }
    @Test fun `started harvest waits for its actual finish independently of other actor records`() {
        val crop = berries().copy(collection = EconomyCollection("berry_harvest", 8, now.toString(), now.plusSeconds(8).toString()))
        val status = notificationJobReadiness(crop, listOf(crop, job("trip", "exploration", "forest", now.plusSeconds(600))), true, now)
        assertEquals(now.plusSeconds(8), status.dueAt); assertEquals("collected", status.phase); assertNull(status.blockedUntil)
    }
    @Test fun `long trip readiness uses return time so waiting ripe berries do not become stale in transit`() {
        val crop = berries().copy(finishesAt = now.minusSeconds(172800).toString())
        val trip = job("trip", "exploration", "forest", now.plusSeconds(3600))
        assertEquals(now.plusSeconds(3600), notificationJobReadiness(crop, listOf(crop, trip), false, now).dueAt)
    }
}
