package ru.zhiv.game

import kotlinx.serialization.json.Json
import org.junit.jupiter.api.Test
import ru.zhiv.auth.AuthFailure
import ru.zhiv.economy.*
import java.time.Instant
import kotlin.test.*

class ProgressionRewardsTest {
    private fun at(value: String)=Instant.parse(value)
    @Test fun `onboarding qualification requires the server order and preserves legacy paid steps`() {
        val initial=EconomyRules.initial(0,0,0)
        for (version in 1..3) {
            for ((completed,step,expected) in listOf(Triple(false,0,false),Triple(true,0,true),Triple(false,1,true))) {
                assertEquals(expected,ProgressionRewardRules.onboardingEligible(initial.copy(
                    tutorialOrder=EconomyTutorialOrder(ingredientsClaimed=true,completed=completed,version=version,step=step))))
            }
        }
        assertFalse(ProgressionRewardRules.onboardingEligible(initial.copy(buildings=initial.buildings+("home" to 5))))
    }
    @Test fun `catalog pays finite achievement pearls and seven valuable bundles`() {
        assertEquals(3000L,ProgressionRewardRules.achievementPearls.values.flatten().sum())
        assertEquals(21,ProgressionRewardRules.achievementPearls.values.sumOf { it.size })
        assertEquals(320L,ProgressionRewardRules.daily.sumOf { it.coins })
        assertEquals(1000L,ProgressionRewardRules.daily.sumOf { it.pearls })
        assertEquals(listOf(80L,100L,120L,140L,160L,180L,220L),ProgressionRewardRules.daily.map { it.pearls })
        assertEquals(20L,ProgressionRewardRules.daily.sumOf { it.items.values.sum() })
        assertEquals(setOf("wood","stone","fiber","berries","fish","planks","ancient_core"),ProgressionRewardRules.daily.flatMap { it.items.keys }.toSet())
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
    @Test fun `home tiers scale useful supplies but never free pearls or relic counts`() {
        val coins=listOf(320L,640L,960L,1280L,1600L)
        for(home in 1..5) {
            val cycle=ProgressionRewardRules.dailyCycle(home)
            assertEquals(coins[home-1],cycle.sumOf { it.coins })
            assertEquals(1000L,cycle.sumOf { it.pearls })
            assertTrue(cycle.all { it.items.values.sum() in 2L..4L })
            assertEquals(1L,cycle.sumOf { it.items["ancient_core"] ?: 0L })
            assertTrue(cycle.all { it.items.size>=2 })
            val view=ProgressionRewardRules.dailyView(DailyRewardsState(3),at("2026-10-05T12:00:00Z"),home)
            assertEquals(home,view.homeLevel); assertEquals(cycle[2],view.reward)
            assertEquals(cycle,view.cycle.map { it.reward })
        }
        assertEquals(ProgressionRewardRules.dailyCycle(1),ProgressionRewardRules.dailyCycle(-1))
        assertEquals(ProgressionRewardRules.dailyCycle(5),ProgressionRewardRules.dailyCycle(99))
    }
    @Test fun `skips preserve the gift and the seventh permanently completes the chain`() {
        val state=DailyRewardsState(7,at("2026-09-01T12:00:00Z"))
        val opened=ProgressionRewardRules.dailyView(state,at("2026-10-05T12:00:00Z"))
        assertEquals(7,opened.step); assertTrue(opened.claimable)
        val finished=ProgressionRewardRules.afterClaim(state,at("2026-10-05T12:00:00Z"))
        assertEquals(7,finished.step); assertTrue(finished.completed)
        for(now in listOf("2026-10-05T12:00:00Z","2026-10-06T12:00:00Z","2030-10-05T12:00:00Z")) {
            val view=ProgressionRewardRules.dailyView(finished,at(now))
            assertTrue(view.completed); assertFalse(view.claimable); assertNull(view.nextClaimAt)
            assertEquals(7,view.step); assertEquals(ProgressionRewardRules.daily[6],view.reward)
        }
        assertEquals("DAILY_REWARD_COMPLETED",assertFailsWith<AuthFailure> {
            ProgressionRewardRules.afterClaim(finished,at("2030-10-05T12:00:00Z")) }.code)
    }
    @Test fun `merge retains furthest gift and latest cooldown independently`() {
        val left=DailyRewardsState(5,at("2026-10-05T23:00:00Z")); val right=DailyRewardsState(2,at("2026-10-06T10:00:00Z"))
        assertEquals(DailyRewardsState(5,right.lastClaimAt),ProgressionRewardRules.mergeDaily(left,right))
        assertEquals(right.copy(step=7),ProgressionRewardRules.mergeDaily(right,right.copy(step=7)))
        assertFalse(ProgressionRewardRules.dailyView(ProgressionRewardRules.mergeDaily(left,right),at("2026-10-06T23:59:00Z")).claimable)
        assertEquals(right,ProgressionRewardRules.mergeDaily(DailyRewardsState(),right))
        val complete=DailyRewardsState(7,left.lastClaimAt,true)
        assertEquals(complete.copy(lastClaimAt=right.lastClaimAt),ProgressionRewardRules.mergeDaily(complete,right))
        assertEquals(ProgressionRewardRules.mergeDaily(complete,right),ProgressionRewardRules.mergeDaily(right,complete))
    }
    @Test fun `seven gifts have one finite pearl and relic payout`() {
        var state=DailyRewardsState()
        var wallet=EconomyRules.initial(0,0,0)
        val before=wallet.wallet
        for(step in 1..7) {
            val now=at("2026-10-01T12:00:00Z").plusSeconds((step-1)*86_400L)
            val view=ProgressionRewardRules.dailyView(state,now)
            assertEquals(step,view.step); assertTrue(view.claimable); assertFalse(view.completed)
            wallet=ProgressionRewardRules.credit(wallet,view.reward)
            state=ProgressionRewardRules.afterClaim(state,now)
        }
        assertEquals(before.pearls+1000,wallet.wallet.pearls)
        assertEquals(before.coins+320,wallet.wallet.coins)
        assertEquals(1L,wallet.inventory["ancient_core"])
        assertFalse(ProgressionRewardRules.dailyView(state,at("2030-10-01T12:00:00Z")).claimable)
    }
    @Test fun `credit respects wallet limit and never changes completed counters`() {
        val initial=EconomyRules.initial(0,0,0)
        val credited=ProgressionRewardRules.credit(initial,ProgressionReward(200,10,mapOf("wood" to 2)))
        assertEquals(initial.wallet.coins+200,credited.wallet.coins); assertEquals(initial.wallet.pearls+10,credited.wallet.pearls)
        assertEquals(initial.inventory.getValue("wood")+2L,credited.inventory["wood"]); assertEquals(initial.progression,credited.progression)
        assertEquals(initial.completedExplorations,credited.completedExplorations)
        assertEquals("ECONOMY_CAPACITY",assertFailsWith<AuthFailure> { ProgressionRewardRules.credit(initial.copy(
            wallet=EconomyWallet(ECONOMY_MAX_BALANCE,0)),ProgressionReward(coins=10)) }.code)
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
    @Test fun `onboarding has one fixed visible gift and accepts no client reward or progress flags`() {
        assertEquals(ProgressionReward(1_000,200),ProgressionRewardRules.onboarding)
        val base="\"requestId\":\"00000000-0000-4000-8000-000000000001\",\"ownerPublicId\":\"1234-5678-ABCD\",\"kind\":\"onboarding\""
        assertEquals("onboarding",decodeRewardClaim(Json.parseToJsonElement("{$base}")).kind)
        for(extra in listOf(",\"reward\":{\"pearls\":100}",",\"completed\":true",",\"skipped\":false",",\"now\":1",
            ",\"achievementId\":\"first_path\",\"level\":1")) assertFailsWith<AuthFailure> {
            decodeRewardClaim(Json.parseToJsonElement("{$base$extra}")) }
        val before=EconomyRules.initial(0,0,0)
        val paid=ProgressionRewardRules.credit(before,ProgressionRewardRules.onboarding)
        assertEquals(before.wallet.coins+1_000,paid.wallet.coins)
        assertEquals(before.wallet.pearls+200,paid.wallet.pearls)
        assertEquals(before.inventory,paid.inventory)
        assertEquals(before.progression,paid.progression)
    }
}
