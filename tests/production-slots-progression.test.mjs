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

test("daily-only pearl projection follows gift payouts and cannot buy a slot before earning its price", async () => {
  const loaded = await loadJourneyRules();
  try {
    const rewards = loaded.progressionRewards.progressionRewardsCatalog;
    assert.deepEqual(dailyPearlThreshold(rewards, 200), { targetPearls: 200, giftClaims: 27, elapsedDaysWithFirstGiftToday: 26, pearlsReceived: 204 });
    assert.deepEqual(dailyPearlThreshold(rewards, 3500), { targetPearls: 3500, giftClaims: 439, elapsedDaysWithFirstGiftToday: 438, pearlsReceived: 3500 });
    const report = simulateJourney(loaded, "visits3", 40, { ...jointPlanningPolicy, constructionSpeedups: false,
      buyProductionSlots: true, dailyPearlsOnly: true });
    assert.equal(report.pearlBudget, 0);
    assert.equal(report.dailyPearlProjection.claims, 40, "Multiple daily visits cannot duplicate the UTC gift");
    const earned = Array.from({ length: 40 }, (_, index) => rewards.daily[index % rewards.daily.length].pearls).reduce((sum, amount) => sum + amount, 0);
    assert.equal(report.dailyPearlProjection.pearlsReceived, earned);
    assert.equal(report.pearlsSpent + report.pearlsRemaining, earned);
    assert.equal(report.productionSlots.purchases.length, 1, "forty daily gifts can fund one permanent 200-unit slot");
    assert.equal(report.productionSlots.purchases[0].day, 26);
    assert.equal(report.pearlsSpent, 200);
    const completedBase = simulateJourney(loaded, "visits3", 105, { ...jointPlanningPolicy, constructionSpeedups: false,
      buyProductionSlots: true, dailyPearlsOnly: true });
    assert.equal(completedBase.complete, true);
    assert.equal(completedBase.stoppedAt, null);
    assert(completedBase.elapsedDays < 105, "a completed policy stops instead of farming gifts indefinitely");
    assert(completedBase.dailyPearlProjection.claims < 105);
    assert.equal(completedBase.pearlsRemaining + completedBase.pearlsSpent, completedBase.dailyPearlProjection.pearlsReceived);
    // A real longer goal keeps the player active across the gift-price boundary.
    const beforePrice = simulateJourney(loaded, "visits3", 26, { ...jointPlanningPolicy, constructionSpeedups: false,
      buyProductionSlots: true, dailyPearlsOnly: true, completionGoal: "all-current-buildings" });
    assert.equal(beforePrice.dailyPearlProjection.claims, 26);
    assert.equal(beforePrice.dailyPearlProjection.pearlsReceived, 196);
    assert.deepEqual(beforePrice.productionSlots.purchases, [], "the next day's larger payout cannot be spent early");
    const earnedSlot = simulateJourney(loaded, "visits3", 28, { ...jointPlanningPolicy, constructionSpeedups: false,
      buyProductionSlots: true, dailyPearlsOnly: true, completionGoal: "all-current-buildings" });
    assert.equal(earnedSlot.productionSlots.purchases.length, 1);
    assert.equal(earnedSlot.productionSlots.purchases[0].day, 26);
    assert.equal(earnedSlot.pearlBudget, 0);
    assert.equal(earnedSlot.dailyPearlProjection.claims, 28);
    assert.equal(earnedSlot.pearlsSpent, 200);
    assert.equal(earnedSlot.pearlsRemaining + earnedSlot.pearlsSpent, earnedSlot.dailyPearlProjection.pearlsReceived);
    for (const purchase of completedBase.productionSlots.purchases) {
      const byDay = Math.floor(purchase.day), earnedAtPurchase = Array.from({ length: byDay + 1 }, (_, index) => rewards.daily[index % rewards.daily.length].pearls).reduce((sum, amount) => sum + amount, 0);
      const paidByPurchase = completedBase.productionSlots.purchases.filter(row => row.day <= purchase.day).reduce((sum, row) => sum + row.pricePearls, 0);
      assert(paidByPurchase <= earnedAtPurchase, "Slots consume already earned pearls");
    }
    assert.equal(report.actions.speedup_construction, undefined);
    assert.equal(report.actions.buy_fishing_item, undefined);
    assert(report.excludedIncome.includes("daily_reward_coins_and_items"));
  } finally { await loaded.close(); }
});
