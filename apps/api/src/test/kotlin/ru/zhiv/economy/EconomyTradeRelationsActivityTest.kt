package ru.zhiv.economy

import org.junit.jupiter.api.Test
import java.time.Instant
import kotlin.test.*

class EconomyTradeRelationsActivityTest {
    private val now = Instant.parse("2026-10-26T12:00:00Z")
    private val catalog = EconomyRules.catalog
    private fun at(days: Double) = now.plusSeconds((days * 86400).toLong())

    @Test fun `earned ranks and their full bonuses remain permanent after long absences`() {
        var state = EconomyRules.initial().copy(tradeRelations = EconomyTradeRelationsState(reputation = mapOf("builder" to 1600)))
        assertEquals(state, EconomyTradeRelations.awardOrder(state, "builder", -1, now))
        assertEquals(1000, EconomyTradeRelations.bonusBps(state, "builder", now = now))
        repeat(4) {
            state = EconomyTradeRelations.awardOrder(state, "builder", 10, now)
            assertEquals(10000, EconomyTradeRelations.activityBps(state.tradeRelations, "builder", now))
        }
        val saved = state.tradeRelations
        listOf(0.0 to 10000, 3.0 to 10000, 6.5 to 10000, 10.0 to 10000, 365.0 to 10000).forEach { (days, bps) ->
            assertEquals(bps, EconomyTradeRelations.activityBps(state.tradeRelations, "builder", at(days)))
            assertEquals(bps / 10, EconomyTradeRelations.bonusBps(state, "builder", now = at(days)))
            assertEquals(1640L, state.tradeRelations.reputation["builder"])
        }
        assertEquals(saved, state.tradeRelations)
    }

    @Test fun `capped deliveries and purchases do not rewrite legacy support records`() {
        val instant = at(10.0)
        var state = EconomyRules.initial().copy(tradeRelations = EconomyTradeRelationsState(reputation = mapOf("builder" to 1600),
            activity = mapOf("builder" to EconomyTradeActivity(10000, now.toString())),
            dailyCycle = Math.floorDiv(instant.epochSecond, 86400), dailyOrderXp = mapOf("builder" to 180)))
        state = EconomyTradeRelations.awardOrder(state, "builder", 20, instant)
        assertEquals(1600L, state.tradeRelations.reputation["builder"])
        assertEquals(10000, EconomyTradeRelations.activityBps(state.tradeRelations, "builder", instant))
        val saved = state.tradeRelations.activity
        state = EconomyTradeRelations.awardPurchase(state, "plesk", 100, instant)
        assertEquals(saved, state.tradeRelations.activity)
        state = EconomyTradeRelations.awardOrder(state, "builder", 20, instant.minusSeconds(86400))
        assertEquals(saved, state.tradeRelations.activity)
        repeat(3) { state = EconomyTradeRelations.awardOrder(state, "builder", 20, instant) }
        assertEquals(10000, EconomyTradeRelations.activityBps(state.tradeRelations, "builder", instant))
    }

    @Test fun `merges preserve reputation while legacy support timestamps no longer weaken bonuses`() {
        val earlier = EconomyTradeRelationsState(reputation = mapOf("builder" to 800),
            activity = mapOf("builder" to EconomyTradeActivity(10000, now.toString())))
        val later = EconomyTradeRelationsState(reputation = mapOf("builder" to 350),
            activity = mapOf("builder" to EconomyTradeActivity(2500, at(6.0).toString())))
        val merged = EconomyTradeRelations.merge(earlier, later, at(6.5))
        assertEquals(800L, merged.reputation["builder"])
        assertEquals(10000, EconomyTradeRelations.activityBps(merged, "builder", at(6.5)))
        assertEquals(at(6.0).toString(), merged.activity["builder"]!!.updatedAt)
        assertEquals(merged.activity, EconomyTradeRelations.merge(merged, later, at(6.5)).activity)
        assertEquals(10000, EconomyTradeRelations.activityBps(merged, "builder", at(30.0)))
        assertEquals(700, EconomyTradeRelations.bonusBps(EconomyRules.initial().copy(tradeRelations = merged), "builder", now = at(30.0)))
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

    @Test fun `historical explicit activity configuration still preserves original grace anchors`() {
        val legacyCatalog = catalog.copy(tradeRelations = catalog.tradeRelations!!.copy(activity = EconomyTradeActivityConfig(259200, 604800, 2500)))
        assertNull(catalog.tradeRelations!!.activity)
        val older = EconomyTradeRelationsState(reputation = mapOf("builder" to 1600),
            activity = mapOf("builder" to EconomyTradeActivity(10000, now.toString())))
        val newer = older.copy(activity = mapOf("builder" to EconomyTradeActivity(10000, at(2.0).toString())))
        assertEquals(10000, EconomyTradeRelations.activityBps(older, "builder", at(3.0), legacyCatalog))
        assertEquals(10000, EconomyTradeRelations.activityBps(newer, "builder", at(3.0), legacyCatalog))
        for ((a, b) in listOf(older to newer, newer to older)) {
            val merged = EconomyTradeRelations.merge(a, b, at(3.0), legacyCatalog)
            assertEquals(at(2.0).toString(), merged.activity["builder"]!!.updatedAt)
            assertEquals(10000, EconomyTradeRelations.activityBps(merged, "builder", at(4.0), legacyCatalog))
            assertEquals(newer.activity, EconomyTradeRelations.merge(merged, older, at(4.0), legacyCatalog).activity)
            assertEquals(0, EconomyTradeRelations.activityBps(merged, "builder", at(12.0), legacyCatalog))
        }
        val freshPartial = older.copy(activity = mapOf("builder" to EconomyTradeActivity(5000, at(6.0).toString())))
        val mergedPartial = EconomyTradeRelations.merge(older, freshPartial, at(6.5), legacyCatalog)
        assertEquals(5000, EconomyTradeRelations.activityBps(older, "builder", at(6.5), legacyCatalog))
        assertEquals(freshPartial.activity, mergedPartial.activity)
        assertEquals(5000, EconomyTradeRelations.activityBps(mergedPartial, "builder", at(9.0), legacyCatalog))
    }
}
