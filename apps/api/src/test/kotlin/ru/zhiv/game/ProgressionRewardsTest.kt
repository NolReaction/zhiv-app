package ru.zhiv.game

import kotlinx.serialization.json.Json
import org.junit.jupiter.api.Test
import ru.zhiv.auth.AuthFailure
import ru.zhiv.economy.*
import java.time.Instant
import kotlin.test.*

class ProgressionRewardsTest {
    private fun at(value: String)=Instant.parse(value)
    @Test fun `catalog pays forty three finite achievement pearls and ordinary cycle only`() {
        assertEquals(43L,ProgressionRewardRules.achievementPearls.values.flatten().sum())
        assertEquals(21,ProgressionRewardRules.achievementPearls.values.sumOf { it.size })
        assertEquals(50L,ProgressionRewardRules.daily.sumOf { it.coins })
        assertEquals(3L,ProgressionRewardRules.daily.sumOf { it.pearls })
        assertEquals(6L,ProgressionRewardRules.daily.sumOf { it.items.values.sum() })
        assertEquals(setOf("wood","stone","fiber"),ProgressionRewardRules.daily.flatMap { it.items.keys }.toSet())
        assertEquals(listOf(0L),ProgressionRewardRules.achievementPearls.getValue("full_collection"))
    }
    @Test fun `next UTC date and twenty hours are independent fences`() {
        val late=DailyRewardsState(2,at("2026-10-05T23:59:00Z"))
        assertFalse(ProgressionRewardRules.dailyView(late,at("2026-10-06T00:00:00Z")).claimable)
        assertFalse(ProgressionRewardRules.dailyView(late,at("2026-10-06T19:58:59Z")).claimable)
        assertTrue(ProgressionRewardRules.dailyView(late,at("2026-10-06T19:59:00Z")).claimable)
        val early=DailyRewardsState(2,at("2026-10-05T01:00:00Z"))
        assertFalse(ProgressionRewardRules.dailyView(early,at("2026-10-05T23:59:59Z")).claimable)
        assertTrue(ProgressionRewardRules.dailyView(early,at("2026-10-06T00:00:00Z")).claimable)
        assertFalse(ProgressionRewardRules.dailyView(late,at("2026-10-05T20:00:00Z")).claimable)
    }
    @Test fun `skips preserve next step and seven wraps to one`() {
        val state=DailyRewardsState(7,at("2026-09-01T12:00:00Z"))
        val opened=ProgressionRewardRules.dailyView(state,at("2026-10-05T12:00:00Z"))
        assertEquals(7,opened.step); assertTrue(opened.claimable)
        assertEquals(1,ProgressionRewardRules.afterClaim(state,at("2026-10-05T12:00:00Z")).step)
    }
    @Test fun `merge keeps latest actual claim with its next step and target wins timestamp tie`() {
        val left=DailyRewardsState(5,at("2026-10-05T23:00:00Z")); val right=DailyRewardsState(2,at("2026-10-06T10:00:00Z"))
        assertEquals(right,ProgressionRewardRules.mergeDaily(left,right))
        assertEquals(right,ProgressionRewardRules.mergeDaily(right,right.copy(step=7)))
        assertFalse(ProgressionRewardRules.dailyView(ProgressionRewardRules.mergeDaily(left,right),at("2026-10-06T23:59:00Z")).claimable)
        assertEquals(right,ProgressionRewardRules.mergeDaily(DailyRewardsState(),right))
    }
    @Test fun `credit respects wallet limit and never changes completed counters`() {
        val initial=EconomyRules.initial(0,0,0)
        val credited=ProgressionRewardRules.credit(initial,ProgressionReward(20,1,mapOf("wood" to 2)))
        assertEquals(initial.wallet.coins+20,credited.wallet.coins); assertEquals(initial.wallet.pearls+1,credited.wallet.pearls)
        assertEquals(2L,credited.inventory["wood"]); assertEquals(initial.progression,credited.progression)
        assertEquals(initial.completedExplorations,credited.completedExplorations)
        assertEquals("ECONOMY_CAPACITY",assertFailsWith<AuthFailure> { ProgressionRewardRules.credit(initial.copy(
            wallet=EconomyWallet(ECONOMY_MAX_BALANCE,0)),ProgressionReward(coins=1)) }.code)
    }
    @Test fun `claim decoder rejects forged clocks rewards unknown levels and wrong UUID versions`() {
        val base="\"requestId\":\"00000000-0000-4000-8000-000000000001\",\"ownerPublicId\":\"1234-5678-ABCD\""
        assertEquals("daily",decodeRewardClaim(Json.parseToJsonElement("{$base,\"kind\":\"daily\"}")).kind)
        for (extra in listOf(",\"step\":7",",\"now\":1",",\"reward\":{\"pearls\":100}")) assertFailsWith<AuthFailure> {
            decodeRewardClaim(Json.parseToJsonElement("{$base,\"kind\":\"daily\"$extra}")) }
        assertFailsWith<AuthFailure> { decodeRewardClaim(Json.parseToJsonElement("{$base,\"kind\":\"achievement\",\"achievementId\":\"first_path\",\"level\":2}")) }
        for(level in listOf("\"1\"","1.0")) assertFailsWith<AuthFailure> {
            decodeRewardClaim(Json.parseToJsonElement("{$base,\"kind\":\"achievement\",\"achievementId\":\"first_path\",\"level\":$level}")) }
        assertFailsWith<AuthFailure> { validateRewardClaim(ProgressionRewardClaim("00000000-0000-1000-8000-000000000001","1234-5678-ABCD","daily")) }
    }
}
