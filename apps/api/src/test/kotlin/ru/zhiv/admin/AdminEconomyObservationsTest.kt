package ru.zhiv.admin

import org.junit.jupiter.api.Test
import ru.zhiv.economy.EconomyCollection
import ru.zhiv.economy.EconomyJob
import ru.zhiv.economy.EconomyStorage
import java.time.Instant
import kotlin.test.*

class AdminEconomyObservationsTest {
    private val deadline = Instant.parse("2026-10-05T12:00:00Z")
    private val storage = EconomyStorage(200,190,5,5,0)
    private fun job(collection: EconomyCollection? = null) = EconomyJob(
        "9a272b65-8ada-4b0d-aad8-6a6ef845f41b","production","garden","grow_berries",startedAt=deadline.minusSeconds(900).toString(),
        finishesAt=deadline.toString(),rewards=mapOf("berries" to 6L),collection=collection)

    @Test fun `claim readiness uses exact server deadline and escrow-aware capacity`() {
        assertEquals("running",AdminEconomyObservations.jobStatus(job(),storage,deadline.minusNanos(1)).status)
        val ready = AdminEconomyObservations.jobStatus(job(),storage,deadline)
        assertEquals("ready",ready.status); assertTrue(ready.storageBlocked)
        assertFalse(AdminEconomyObservations.jobStatus(job(),storage.copy(available=6),deadline).storageBlocked)
    }

    @Test fun `berry harvest is not falsely counted as a ready claim before collection`() {
        val waiting = job(EconomyCollection("berry_harvest",8,null,null))
        assertEquals("awaiting_collection",AdminEconomyObservations.jobStatus(waiting,storage,deadline).status)
        assertFalse(AdminEconomyObservations.jobStatus(waiting,storage,deadline).storageBlocked)
        val collecting = job(EconomyCollection("berry_harvest",8,deadline.toString(),deadline.plusSeconds(8).toString()))
        assertEquals("collecting",AdminEconomyObservations.jobStatus(collecting,storage,deadline.plusSeconds(7)).status)
        assertEquals("ready",AdminEconomyObservations.jobStatus(collecting,storage,deadline.plusSeconds(8)).status)
    }
}
