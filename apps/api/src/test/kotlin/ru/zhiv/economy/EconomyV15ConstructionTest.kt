package ru.zhiv.economy

import org.junit.jupiter.api.Test
import ru.zhiv.auth.AuthFailure
import java.time.Instant
import java.util.UUID
import kotlin.test.*

class EconomyV15ConstructionTest {
    private val now = Instant.parse("2026-10-26T12:00:00Z")
    private val target = EconomyRules.catalog.buildings.single { it.id == "workshop" }.levels.single { it.level == 4 }
    private fun fixture(coins: Long) = EconomyRules.initial().copy(
        wallet = EconomyWallet(coins), inventory = target.cost.items,
        buildings = EconomyRules.catalog.buildings.associate { it.id to it.levels.last().level } + ("workshop" to 3))
    private fun apply(state: EconomyState, action: String, id: String, at: Instant = now) = EconomyRules.apply(state,
        EconomyCommand(UUID.randomUUID().toString(), "ABCD-EFGH-JKMP", 0, action, id), at).first

    @Test fun `late construction needs the complete permanent investment before taking materials`() {
        val poor = fixture(2400)
        assertEquals("ECONOMY_RESOURCES", assertFailsWith<AuthFailure> { apply(poor, "start_construction", "workshop") }.code)
        assertEquals(target.cost.items, poor.inventory)
        assertEquals(2400L, poor.wallet.coins)
        assertTrue(poor.jobs.isEmpty())
        val started = apply(fixture(target.cost.coins), "start_construction", "workshop")
        assertEquals(0L, started.wallet.coins)
        assertEquals(target.cost, started.jobs.single().cost)
        assertEquals(3, started.buildings["workshop"])
        assertTrue(started.inventory.isEmpty())
    }

    @Test fun `a saved paid v14 job can finish without paying the increased fee again`() {
        val started = apply(fixture(target.cost.coins), "start_construction", "workshop")
        val job = started.jobs.single().let { it.copy(catalogVersion = 14, cost = it.cost.copy(coins = 2400)) }
        val saved = started.copy(jobs = listOf(job))
        val finished = apply(saved, "claim_job", job.id, Instant.parse(job.finishesAt))
        assertEquals(4, finished.buildings["workshop"])
        assertEquals(0L, finished.wallet.coins)
        assertTrue(finished.jobs.isEmpty())
        assertEquals(2400L, saved.jobs.single().cost.coins)
    }
}
