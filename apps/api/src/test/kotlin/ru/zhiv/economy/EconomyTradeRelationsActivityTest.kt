package ru.zhiv.economy

import org.junit.jupiter.api.Test
import java.time.Instant
import kotlin.test.*

class EconomyTradeRelationsActivityTest {
    private val now = Instant.parse("2026-10-26T12:00:00Z")
    private val catalog = EconomyRules.catalog
    private fun at(days: Double) = now.plusSeconds((days * 86400).toLong())

    @Test fun `earned ranks are permanent but support requires real deliveries and decays after grace`() {
        var state = EconomyRules.initial().copy(tradeRelations = EconomyTradeRelationsState(reputation = mapOf("builder" to 1600)))
        assertEquals(state, EconomyTradeRelations.awardOrder(state, "builder", -1, now))
        assertEquals(0, EconomyTradeRelations.bonusBps(state, "builder", now = now))
        repeat(4) { index ->
            state = EconomyTradeRelations.awardOrder(state, "builder", 10, now)
            assertEquals((index + 1) * 2500, EconomyTradeRelations.activityBps(state.tradeRelations, "builder", now))
        }
        val saved = state.tradeRelations
        listOf(0.0 to 10000, 3.0 to 10000, 6.5 to 5000, 10.0 to 0, 365.0 to 0).forEach { (days, bps) ->
            assertEquals(bps, EconomyTradeRelations.activityBps(state.tradeRelations, "builder", at(days)))
            assertEquals(bps / 10, EconomyTradeRelations.bonusBps(state, "builder", now = at(days)))
            assertEquals(1640L, state.tradeRelations.reputation["builder"])
        }
        assertEquals(saved, state.tradeRelations)
    }

    @Test fun `capped deliveries recover support but purchases and a backwards clock cannot`() {
        val instant = at(10.0)
        var state = EconomyRules.initial().copy(tradeRelations = EconomyTradeRelationsState(reputation = mapOf("builder" to 1600),
            activity = mapOf("builder" to EconomyTradeActivity(10000, now.toString())),
            dailyCycle = Math.floorDiv(instant.epochSecond, 86400), dailyOrderXp = mapOf("builder" to 180)))
        state = EconomyTradeRelations.awardOrder(state, "builder", 20, instant)
        assertEquals(1600L, state.tradeRelations.reputation["builder"])
        assertEquals(2500, EconomyTradeRelations.activityBps(state.tradeRelations, "builder", instant))
        val saved = state.tradeRelations.activity
        state = EconomyTradeRelations.awardPurchase(state, "plesk", 100, instant)
        assertEquals(saved, state.tradeRelations.activity)
        state = EconomyTradeRelations.awardOrder(state, "builder", 20, instant.minusSeconds(86400))
        assertEquals(saved, state.tradeRelations.activity)
        repeat(3) { state = EconomyTradeRelations.awardOrder(state, "builder", 20, instant) }
        assertEquals(10000, EconomyTradeRelations.activityBps(state.tradeRelations, "builder", instant))
    }

    @Test fun `merges retain existing support clocks without adding points or restarting grace`() {
        val earlier = EconomyTradeRelationsState(reputation = mapOf("builder" to 800),
            activity = mapOf("builder" to EconomyTradeActivity(10000, now.toString())))
        val later = EconomyTradeRelationsState(reputation = mapOf("builder" to 350),
            activity = mapOf("builder" to EconomyTradeActivity(2500, at(6.0).toString())))
        val merged = EconomyTradeRelations.merge(earlier, later, at(6.5))
        assertEquals(800L, merged.reputation["builder"])
        assertEquals(5000, EconomyTradeRelations.activityBps(merged, "builder", at(6.5)))
        assertEquals(now.toString(), merged.activity["builder"]!!.updatedAt)
        assertEquals(merged.activity, EconomyTradeRelations.merge(merged, later, at(6.5)).activity)
        assertEquals(0, EconomyTradeRelations.activityBps(merged, "builder", at(30.0)))
    }

    @Test fun `difficulty boundaries and weekly final rewards agree with their occupied work`() {
        assertTrue(catalog.food!!.orders.templates.any { (it.reputationXp ?: 0) > 30 })
        EconomyFood.validateCatalog(catalog)
        assertEquals(listOf("ordinary", "challenging", "challenging", "masterful"),
            listOf(1799L, 1800L, 7199L, 7200L).map { EconomyTradeRelations.orderDifficulty(it) })
        assertEquals(listOf("ordinary", "challenging", "challenging", "masterful"),
            listOf(10799L, 10800L, 35999L, 36000L).map { EconomyTradeRelations.orderDifficulty(it, true) })
        catalog.tradeRelations!!.weekly.templates.forEach { template ->
            val difficulty = EconomyTradeRelations.orderDifficulty(template.stages.sumOf { it.effortSeconds }, true)
            val pearls = mapOf("ordinary" to 40L, "challenging" to 80L, "masterful" to 140L).getValue(difficulty)
            assertEquals(listOf(0L, 0L, pearls), template.stages.map { it.pearls }, template.id)
        }
    }
}
