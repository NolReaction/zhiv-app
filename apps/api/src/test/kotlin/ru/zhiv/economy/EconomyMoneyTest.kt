package ru.zhiv.economy

import org.junit.jupiter.api.Test
import java.time.Instant
import java.util.UUID
import kotlin.test.*

class EconomyMoneyTest {
    @Test fun `saved balances and paid job costs convert once without changing goods time or progress`() {
        val job = EconomyJob(UUID.randomUUID().toString(), "construction", "home", targetLevel = 2,
            startedAt = "2026-10-01T00:00:00Z", finishesAt = "2026-10-03T00:00:00Z",
            cost = EconomyCost(150, mapOf("wood" to 20L)), catalogVersion = 2)
        val old = EconomyState(buildings = EconomyRules.initial().buildings, wallet = EconomyWallet(123, 4), inventory = mapOf("wood" to 17L),
            jobs = listOf(job), migration = EconomyMigration(coinsGranted = 7, woodGranted = 0, stoneGranted = 0), completedExplorations = 19,
            progression = EconomyProgression(routes = mapOf("forest" to 3L), recipes = mapOf("make_rope" to 2L)))
        val current = EconomyMoney.redenominate(old)
        assertEquals(EconomyWallet(1230, 40), current.wallet)
        assertEquals(70L, current.migration.coinsGranted)
        assertEquals(job.copy(cost = job.cost.copy(coins = 1500)), current.jobs.single())
        assertEquals(old.inventory, current.inventory)
        assertEquals(old.progression, current.progression)
        assertEquals(old.completedExplorations, current.completedExplorations)
        assertEquals(10, current.currencyScale)
        assertSame(current, EconomyMoney.redenominate(current))
        assertEquals(EconomyWallet(123, 4), old.wallet)
        assertEquals(-40L, EconomyMoney.nominal(-4))
        assertEquals(-40L, EconomyMoney.nominal(-40, 10))
        assertFailsWith<IllegalArgumentException> { EconomyMoney.nominal(1, 2) }
    }

    @Test fun `NPC packet rounding preserves old quantization rather than adding fractional old coins`() {
        val policy = EconomyLocalBuyer(payoutBps = 6000)
        for (oldBase in listOf(1L, 2L, 3L, 4L, 8L, 12L, 64L))
            for (quantity in listOf(1L, 2L, 3L, 9L, 10L, 99L, 10_000L)) {
                val oldProceeds = oldBase * quantity * policy.payoutBps / 10_000
                assertEquals(oldProceeds * 10, EconomyRules.localSellPrice(oldBase * 10, quantity, policy))
            }
        assertEquals(10L, EconomyRules.localSellPrice(30, 1, policy))
        assertEquals(10_000_000_000L, ECONOMY_MAX_BALANCE)
        assertEquals(1_000_000_000L, ECONOMY_MAX_ITEMS)
    }

    @Test fun `construction charges ten nominal pearls per the same started five minute interval`() {
        val now = Instant.parse("2026-10-05T00:00:00Z")
        val job = EconomyJob(UUID.randomUUID().toString(), "construction", "home", targetLevel = 2,
            startedAt = now.toString(), finishesAt = now.toString())
        for ((milliseconds, retiredPearls) in listOf(-1L to 0L, 0L to 0L, 1L to 1L,
            299_999L to 1L, 300_000L to 1L, 300_001L to 2L, 900_000L to 3L))
            assertEquals(retiredPearls * 10, EconomyRules.constructionSpeedupPrice(
                job.copy(finishesAt = now.plusMillis(milliseconds).toString()), now))
    }
}
