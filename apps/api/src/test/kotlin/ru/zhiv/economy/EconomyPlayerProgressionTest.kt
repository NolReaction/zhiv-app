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
        assertEquals(1, EconomyPlayerProgression.level(0)); assertEquals(1, EconomyPlayerProgression.level(29))
        assertEquals(2, EconomyPlayerProgression.level(30)); assertEquals(10, EconomyPlayerProgression.level(2430))
        assertEquals(100, EconomyPlayerProgression.level(294030)); assertEquals(100, EconomyPlayerProgression.level(Long.MAX_VALUE))
        (2..100).forEach { level ->
            val threshold = 30L * (level - 1) * (level - 1)
            assertEquals(level, EconomyPlayerProgression.level(threshold))
            assertEquals(level - 1, EconomyPlayerProgression.level(threshold - 1))
        }
    }

    @Test fun `old work is not recalculated and paid milestones do not receive a top up`() {
        val initial = EconomyRules.initial()
        val saved = initial.copy(progression = initial.progression.copy(recipes = mapOf("make_planks" to 1L),
            player = EconomyPlayerProgress(xp = 100, workSeconds = 3600,
                season = EconomyCooperationSeason("2026-11", 100, listOf(100)))))
        val inspected = EconomyPlayerProgression.award(saved, saved, request("equip_fishing_rod", "reed_rod"), now)
        assertEquals(100L, inspected.progression.player!!.xp)
        assertEquals(saved.wallet.pearls, inspected.wallet.pearls)
        val claimed = production(inspected, 1)
        val seconds = EconomyRules.catalog.recipes.first { it.id == "make_planks" }.seconds
        assertEquals(100L + (3600L + seconds) / 45 - 3600L / 45, claimed.progression.player!!.xp)
    }

    @Test fun `all twelve months add the same catalog bonuses as TypeScript without multiplying XP`() {
        val expected = listOf(listOf(5, 0, 0, 0), listOf(0, 10, 0, 0), listOf(3, 5, 0, 0), listOf(3, 0, 2, 0),
            listOf(5, 5, 0, 0), listOf(0, 0, 5, 0), listOf(0, 0, 0, 15), listOf(3, 0, 0, 10),
            listOf(0, 0, 3, 10), listOf(3, 10, 0, 0), listOf(0, 5, 5, 0), listOf(2, 0, 0, 10))
        expected.forEachIndexed { month, bonus ->
            val at = Instant.parse("2026-${(month + 1).toString().padStart(2, '0')}-01T00:00:00Z")
            var state = order(EconomyRules.initial(), at)
            assertEquals(15L + bonus[0], state.progression.player!!.season.points)
            state = EconomyPlayerProgression.award(state, state, request("complete_resident_order", "weekly1_test"), at)
            assertEquals(40L + bonus[0] + bonus[1], state.progression.player!!.season.points)
            val id = UUID.randomUUID().toString()
            val voyage = EconomyShipVoyage(id, 1, at.toString(), (0..2).map {
                EconomyShipOrder("$id:$it", "cargo$it", "Груз", mapOf("wood" to 1), 1)
            }, 0)
            val before = state.copy(ship = state.ship.copy(voyage = voyage))
            state = EconomyPlayerProgression.award(before, state.copy(ship = state.ship.copy(completedVoyages = 1)), request("claim_ship_voyage", "port"), at)
            assertEquals(100L + bonus[0] + bonus[1] + 3 * bonus[2] + bonus[3], state.progression.player!!.season.points)
            assertEquals(280L, state.progression.player.xp)
        }
    }

    @Test fun `full season pays once and December rolls into January while preserving the career`() {
        val december = Instant.parse("2026-12-31T23:59:59Z")
        val initial = EconomyRules.initial()
        var state = initial.copy(progression = initial.progression.copy(player = EconomyPlayerProgress(xp = 100, workSeconds = 4500,
            season = EconomyCooperationSeason("2026-12", 1500))))
        repeat(2) { state = EconomyPlayerProgression.award(state, state, request("equip_fishing_rod", "reed_rod"), december) }
        assertEquals(200L, state.wallet.pearls - initial.wallet.pearls)
        assertEquals(listOf(100L, 300L, 700L, 1500L), state.progression.player!!.season.awardedMilestones)
        val badges = state.progression.player!!.badges
        state = order(state, Instant.parse("2027-01-01T00:00:00Z"))
        assertEquals("2027-01", state.progression.player!!.season.id)
        assertEquals(20L, state.progression.player!!.season.points)
        assertEquals(125L, state.progression.player!!.xp)
        assertEquals(4500L, state.progression.player!!.workSeconds)
        assertEquals(badges, state.progression.player!!.badges)
        assertEquals(200L, state.wallet.pearls - initial.wallet.pearls)
    }

    @Test fun `permanent badge receipts block rewards from an older monthly snapshot`() {
        val initial = EconomyRules.initial()
        val saved = initial.copy(progression = initial.progression.copy(player = EconomyPlayerProgress(
            badges = listOf("2026-11:helper"), season = EconomyCooperationSeason("2026-11", 100))))
        val result = EconomyPlayerProgression.award(saved, saved, request("equip_fishing_rod", "reed_rod"), now)
        assertEquals(saved.wallet.pearls, result.wallet.pearls)
        assertEquals(listOf(100L), result.progression.player!!.season.awardedMilestones)
        assertEquals(listOf("2026-11:helper"), result.progression.player.badges)
    }

    @Test fun `batching does not change XP or duplicate the first recipe bonus`() {
        val batch = production(EconomyRules.initial(), 10)
        val units = (0 until 10).fold(EconomyRules.initial()) { state, _ -> production(state, 1) }
        assertEquals(batch.progression.player!!.xp, units.progression.player!!.xp)
        assertEquals(batch.progression.player.workSeconds, units.progression.player.workSeconds)
        assertEquals(batch.progression.player.workSeconds / 45 + 25, batch.progression.player.xp)
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
        assertEquals(20L, state.wallet.pearls - initial.wallet.pearls)
        assertEquals(listOf(100L), state.progression.player.season.awardedMilestones)
        assertEquals(listOf("2026-11:helper"), state.progression.player.badges)
        val next = order(state, Instant.parse("2026-12-01T00:00:00Z"))
        assertEquals(200L, next.progression.player!!.xp); assertEquals(17L, next.progression.player.season.points)
        assertEquals("2026-12", next.progression.player.season.id)
        assertEquals(listOf("2026-11:helper"), next.progression.player.badges)
    }

    @Test fun `wallet overflow is deferred without losing rewards or awarding twice`() {
        val initial = EconomyRules.initial().copy(wallet = EconomyWallet(0, ECONOMY_MAX_PEARLS))
        val full = (0 until 7).fold(initial) { current, _ -> order(current) }
        assertEquals(20L, full.progression.player!!.pendingPearls)
        val freed = full.copy(wallet = full.wallet.copy(pearls = full.wallet.pearls - 20))
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
