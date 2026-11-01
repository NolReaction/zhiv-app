package ru.zhiv.economy

import kotlinx.serialization.encodeToString
import org.junit.jupiter.api.Test
import java.time.Instant
import java.util.UUID
import kotlin.test.*

class EconomyPlayerProgressionTest {
    private val now = Instant.parse("2026-11-01T12:00:00Z")
    private fun request(action: String, target: String) = EconomyCommand(UUID.randomUUID().toString(), "ABCD-EFGH-JKMP", 0, action, target)
    private fun order(state: EconomyState, at: Instant = now) = EconomyPlayerProgression.award(state, state, request("complete_resident_order", "resident_request"), at)
    private fun production(state: EconomyState, quantity: Int): EconomyState {
        val recipe = EconomyRules.catalog.recipes.first { it.id == "make_planks" }
        val job = EconomyJob(UUID.randomUUID().toString(), "production", recipe.buildingId, recipeId = recipe.id,
            startedAt = now.minusSeconds(recipe.seconds * quantity).toString(), finishesAt = now.toString(),
            rewards = recipe.rewards.mapValues { (_, count) -> count * quantity }, catalogVersion = 15)
        return EconomyRules.apply(state.copy(jobs = state.jobs + job), request("claim_job", job.id), now).first
    }

    @Test fun `levels are based on XP with the same quadratic thresholds as TypeScript`() {
        assertEquals(1, EconomyPlayerProgression.level(0)); assertEquals(1, EconomyPlayerProgression.level(49))
        assertEquals(2, EconomyPlayerProgression.level(50)); assertEquals(10, EconomyPlayerProgression.level(4050))
        assertEquals(100, EconomyPlayerProgression.level(490050)); assertEquals(100, EconomyPlayerProgression.level(Long.MAX_VALUE))
    }

    @Test fun `batching does not change XP or duplicate the first recipe bonus`() {
        val batch = production(EconomyRules.initial(), 10)
        val units = (0 until 10).fold(EconomyRules.initial()) { state, _ -> production(state, 1) }
        assertEquals(batch.progression.player!!.xp, units.progression.player!!.xp)
        assertEquals(batch.progression.player.workSeconds, units.progression.player.workSeconds)
        assertEquals(batch.progression.player.workSeconds / 60 + 25, batch.progression.player.xp)
        assertEquals("production", batch.progression.player.lastAward!!.source)
    }

    @Test fun `construction awards once after successful claim`() {
        val initial = EconomyRules.initial()
        val job = EconomyJob(UUID.randomUUID().toString(), "construction", "workshop", targetLevel = 1,
            startedAt = now.minusSeconds(60).toString(), finishesAt = now.toString(), catalogVersion = 15)
        val state = EconomyRules.apply(initial.copy(jobs = listOf(job)), request("claim_job", job.id), now).first
        assertEquals(100L, state.progression.player!!.xp)
        assertFails { EconomyRules.apply(state, request("claim_job", job.id), now) }
        assertEquals(100L, state.progression.player.xp)
    }

    @Test fun `season has one-time two-unit pearl rewards and permanent earned badges`() {
        val initial = EconomyRules.initial()
        val state = (0 until 7).fold(initial) { current, _ -> order(current) }
        assertEquals(175L, state.progression.player!!.xp)
        assertEquals(105L, state.progression.player.season.points)
        assertEquals(4L, state.wallet.pearls - initial.wallet.pearls)
        assertEquals(listOf(100L), state.progression.player.season.awardedMilestones)
        assertEquals(listOf("2026-11:helper"), state.progression.player.badges)
        val next = order(state, Instant.parse("2026-12-01T00:00:00Z"))
        assertEquals(200L, next.progression.player!!.xp); assertEquals(15L, next.progression.player.season.points)
        assertEquals("2026-12", next.progression.player.season.id)
        assertEquals(listOf("2026-11:helper"), next.progression.player.badges)
    }

    @Test fun `wallet overflow is deferred without losing rewards or awarding twice`() {
        val initial = EconomyRules.initial().copy(wallet = EconomyWallet(0, ECONOMY_MAX_PEARLS))
        val full = (0 until 7).fold(initial) { current, _ -> order(current) }
        assertEquals(4L, full.progression.player!!.pendingPearls)
        val freed = full.copy(wallet = full.wallet.copy(pearls = full.wallet.pearls - 4))
        val result = EconomyPlayerProgression.award(freed, freed, request("equip_fishing_rod", "reed_rod"), now)
        assertEquals(ECONOMY_MAX_PEARLS, result.wallet.pearls); assertEquals(0L, result.progression.player!!.pendingPearls)
        assertEquals(listOf(100L), result.progression.player.season.awardedMilestones)
    }

    @Test fun `merge keeps strongest career and unions paid milestones`() {
        val first = (0 until 7).fold(EconomyRules.initial()) { current, _ -> order(current) }.progression.player
        val second = order(EconomyRules.initial()).progression.player
        val merged = EconomyPlayerProgression.merge(first, second)
        assertEquals(175L, merged!!.xp); assertEquals(105L, merged.season.points)
        assertEquals(listOf(100L), merged.season.awardedMilestones)
        assertEquals(merged, EconomyPlayerProgression.merge(merged, second))
    }

    @Test fun `public state omits optional nulls and a populated career round trips`() {
        assertFalse(economyJson.encodeToString(EconomyProgression()).contains("\"player\""))
        val state = order(EconomyRules.initial())
        assertEquals(state, economyJson.decodeFromString<EconomyState>(economyJson.encodeToString(state)))
        assertFalse(economyJson.encodeToString(EconomyPlayerProgress()).contains("\"lastAward\""))
    }

    @Test fun `rank bonus stays after a long absence`() {
        val state = EconomyRules.initial().copy(tradeRelations = EconomyTradeRelationsState(reputation = mapOf("kamneshmyg" to 1600L)))
        assertEquals(1000, EconomyTradeRelations.bonusBps(state, "kamneshmyg", now = now))
        assertEquals(1000, EconomyTradeRelations.bonusBps(state, "kamneshmyg", now = now.plusSeconds(365 * 86400L)))
    }
}
