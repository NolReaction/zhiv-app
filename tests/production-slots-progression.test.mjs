import assert from "node:assert/strict";
import test from "node:test";
import { loadJourneyRules, simulateJourney } from "../scripts/simulate-player-journey.mjs";
import { jointPlanningPolicy } from "../scripts/simulate-player-joint.mjs";
import { dailyPearlThreshold } from "../scripts/review-production-slots.mjs";

test("parallel progression buys capacity at real gates, reserves pending inputs and drains stations for construction", async () => {
  const loaded = await loadJourneyRules();
  try {
    const base = { ...jointPlanningPolicy, parallelProductionPlanning: true, constructionSpeedups: false };
    const baseline = simulateJourney(loaded, "visits3", 40, base);
    const expanded = simulateJourney(loaded, "visits3", 40, { ...base, buyProductionSlots: true, pearlBudget: 3500 });
    assert.equal(baseline.actions.buy_production_slot, undefined);
    assert(Object.values(baseline.productionSlots.maximumProductionJobs).every(count => count <= 1));
    assert.equal(expanded.actions.buy_production_slot, 10);
    assert.equal(expanded.pearlsSpent, 3500);
    assert.equal(expanded.pearlsRemaining, 0);
    assert.equal(expanded.actions.speedup_construction, undefined, "A slot budget must not silently speed up construction");
    assert(expanded.homeDays[3] > 0, "Staggered harvesting must drain so garden upgrades do not deadlock");
    assert(expanded.productionSlots.maximumProductionJobs.garden === 3);
    assert(expanded.productionSlots.maximumProductionJobs.workshop === 3, "The purchased crafting slots must actually run concurrently");
    const homeTwo = expanded.milestones.find(milestone => milestone.building === "home:2");
    assert(homeTwo);
    for (const purchase of expanded.productionSlots.purchases) {
      assert(purchase.houseLevel >= 1);
      assert.equal(purchase.pricePearls, purchase.slots === 2 ? 200 : 500);
    }
    for (const code of ["ECONOMY_BUILDING_BUSY", "ECONOMY_BUILDING_REQUIRED", "ECONOMY_PEARLS", "ECONOMY_QUARRY_BUSY", "ECONOMY_EXPLORER_BUSY", "ECONOMY_COLLECTOR_BUSY"])
      assert.equal(expanded.failures[code], undefined);
    for (const [id, flow] of Object.entries(expanded.itemFlow))
      assert.equal(flow.initial + flow.received, flow.sold + flow.productionInputs + flow.expeditionInputs + flow.constructionInputs + flow.orderInputs + flow.remaining, id);
    assert.equal(expanded.productionSlots.finalCapacity.quarry, undefined, "Mining must retain its single actor");
  } finally { await loaded.close(); }
});

test("one-time pearl projection ends at its earned budget and cannot buy a slot before earning its price", async () => {
  const loaded = await loadJourneyRules();
  try {
    const rewards = loaded.progressionRewards.progressionRewardsCatalog;
    assert.deepEqual(dailyPearlThreshold(rewards, 200), { targetPearls: 200, reachable: true, giftClaims: 3, elapsedDaysWithFirstGiftToday: 2, pearlsReceived: 300 });
    assert.deepEqual(dailyPearlThreshold(rewards, 1000), { targetPearls: 1000, reachable: true, giftClaims: 7, elapsedDaysWithFirstGiftToday: 6, pearlsReceived: 1000 });
    assert.deepEqual(dailyPearlThreshold(rewards, 1001), { targetPearls: 1001, reachable: false, giftClaims: null, elapsedDaysWithFirstGiftToday: null, pearlsReceived: 1000 });
    assert.deepEqual(dailyPearlThreshold(rewards, 3500), { targetPearls: 3500, reachable: false, giftClaims: null, elapsedDaysWithFirstGiftToday: null, pearlsReceived: 1000 });
    const report = simulateJourney(loaded, "visits3", 40, { ...jointPlanningPolicy, constructionSpeedups: false,
      buyProductionSlots: true, dailyPearlsOnly: true });
    assert.equal(report.pearlBudget, 0);
    assert.equal(report.dailyPearlProjection.claims, 7, "Multiple visits and later weeks cannot duplicate the seven gifts");
    assert.equal(report.dailyPearlProjection.completed, true);
    const earned = rewards.daily.reduce((sum, reward) => sum + reward.pearls, 0);
    assert.equal(report.dailyPearlProjection.pearlsReceived, earned);
    assert.equal(report.pearlsSpent + report.pearlsRemaining, earned);
    assert.equal(earned, 1000);
    assert(report.productionSlots.purchases.length < 10, "The finite gifts cannot fund every permanent expansion");
    assert.equal(report.productionSlots.purchases[0].day, 2);
    assert(report.pearlsSpent <= earned);
    assert(Object.values(report.productionSlots.finalCapacity).some(count => count < 3));
    for (const building of ["garden", "workshop"]) {
      assert(report.productionSlots.maximumProductionJobs[building] > 1, "Affordable gift-funded slots actually work in parallel");
      assert(report.productionSlots.maximumProductionJobs[building] <= report.productionSlots.finalCapacity[building]);
    }
    assert.equal(report.productionSlots.finalCapacity.quarry, undefined, "Daily gifts must not add another mining actor");
    const completedBase = simulateJourney(loaded, "visits3", 500, { ...jointPlanningPolicy, constructionSpeedups: false,
      buyProductionSlots: true, dailyPearlsOnly: true });
    assert.equal(completedBase.complete, true);
    assert.equal(completedBase.stoppedAt, null);
    assert(completedBase.elapsedDays < 500, "Ordinary progression continues with the affordable slots after gifts end");
    assert.equal(completedBase.dailyPearlProjection.claims, 7);
    assert.equal(completedBase.dailyPearlProjection.completed, true);
    assert.equal(completedBase.dailyPearlProjection.pearlsReceived, 1000);
    assert.equal(completedBase.pearlsRemaining + completedBase.pearlsSpent, completedBase.dailyPearlProjection.pearlsReceived);
    for (const [days, earnedPearls] of [[1, 80], [2, 180]]) {
      const beforePrice = simulateJourney(loaded, "visits3", days, { ...jointPlanningPolicy, constructionSpeedups: false,
        buyProductionSlots: true, dailyPearlsOnly: true, completionGoal: "all-current-buildings" });
      assert.equal(beforePrice.dailyPearlProjection.claims, days);
      assert.equal(beforePrice.dailyPearlProjection.pearlsReceived, earnedPearls);
      assert.equal(beforePrice.pearlsSpent, 0);
      assert.equal(beforePrice.pearlsRemaining, earnedPearls);
      assert.deepEqual(beforePrice.productionSlots.purchases, [], "The third gift's payout cannot be spent on either of the first two days");
    }
    const earnedSlot = simulateJourney(loaded, "visits3", 3, { ...jointPlanningPolicy, constructionSpeedups: false,
      buyProductionSlots: true, dailyPearlsOnly: true, completionGoal: "all-current-buildings" });
    assert.equal(earnedSlot.productionSlots.purchases.length, 1);
    assert.equal(earnedSlot.productionSlots.purchases[0].day, 2);
    assert.equal(earnedSlot.productionSlots.purchases[0].building, "garden");
    assert.equal(earnedSlot.productionSlots.purchases[0].slots, 2);
    assert.equal(earnedSlot.pearlBudget, 0);
    assert.equal(earnedSlot.dailyPearlProjection.claims, 3);
    assert.equal(earnedSlot.dailyPearlProjection.pearlsReceived, 300);
    assert.equal(earnedSlot.pearlsSpent, 200);
    assert.equal(earnedSlot.pearlsRemaining, 100);
    assert.equal(earnedSlot.pearlsRemaining + earnedSlot.pearlsSpent, earnedSlot.dailyPearlProjection.pearlsReceived);
    for (const result of [report, completedBase, earnedSlot]) {
      for (const purchase of result.productionSlots.purchases) {
        const byDay = Math.floor(purchase.day), earnedAtPurchase = rewards.daily.slice(0, byDay + 1).reduce((sum, reward) => sum + reward.pearls, 0);
        const paidByPurchase = result.productionSlots.purchases.filter(row => row.day <= purchase.day).reduce((sum, row) => sum + row.pricePearls, 0);
        assert(paidByPurchase <= earnedAtPurchase, "Slots consume already earned pearls");
        const tier = loaded.catalog.productionSlots.upgrades.find(upgrade => upgrade.slots === purchase.slots);
        assert(tier && purchase.houseLevel >= tier.requiredHomeLevel, "Gift-funded purchases retain actual house gates");
        assert.equal(purchase.pricePearls, tier.pricePearls);
      }
      for (const code of ["ECONOMY_BUILDING_BUSY", "ECONOMY_BUILDING_REQUIRED", "ECONOMY_PEARLS", "ECONOMY_QUARRY_BUSY", "ECONOMY_EXPLORER_BUSY", "ECONOMY_COLLECTOR_BUSY"])
        assert.equal(result.failures[code], undefined);
    }
    assert.equal(report.actions.speedup_construction, undefined);
    assert.equal(report.actions.buy_fishing_item, undefined);
    assert(report.excludedIncome.includes("daily_reward_coins_and_items"));
  } finally { await loaded.close(); }
});
