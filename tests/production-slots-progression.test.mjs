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

test("one-time gift pearls cannot buy a second slot alone or regenerate after the seventh gift", async () => {
  const loaded = await loadJourneyRules();
  try {
    const rewards = loaded.progressionRewards.progressionRewardsCatalog;
    assert.deepEqual(dailyPearlThreshold(rewards, 140), { targetPearls: 140, reachable: true, giftClaims: 7, elapsedDaysWithFirstGiftToday: 6, pearlsReceived: 140 });
    for (const targetPearls of [200, 1000, 3500])
      assert.deepEqual(dailyPearlThreshold(rewards, targetPearls), { targetPearls, reachable: false, giftClaims: null, elapsedDaysWithFirstGiftToday: null, pearlsReceived: 140 });
    for (const [days, claims, earned] of [[1, 1, 10], [2, 2, 20], [3, 3, 40], [40, 7, 140]]) {
      const report = simulateJourney(loaded, "visits3", days, { ...jointPlanningPolicy, constructionSpeedups: false,
        buyProductionSlots: true, dailyPearlsOnly: true, completionGoal: "all-current-buildings" });
      assert.equal(report.pearlBudget, 0);
      assert.equal(report.dailyPearlProjection.claims, claims);
      assert.equal(report.dailyPearlProjection.pearlsReceived, earned);
      assert.equal(report.dailyPearlProjection.completed, claims === 7);
      assert.equal(report.pearlsSpent, 0);
      assert.equal(report.pearlsRemaining, earned);
      assert.deepEqual(report.productionSlots.purchases, [], "Purchases cannot spend tutorial, welcome or achievement pearls excluded from this projection");
      assert(Object.values(report.productionSlots.maximumProductionJobs).every(count => count <= 1));
      assert.equal(report.productionSlots.finalCapacity.quarry, undefined);
      assert.equal(report.actions.speedup_construction, undefined);
      assert(report.excludedIncome.includes("daily_reward_coins_and_items"));
      for (const [id, flow] of Object.entries(report.itemFlow))
        assert.equal(flow.initial + flow.received, flow.sold + flow.productionInputs + flow.expeditionInputs + flow.constructionInputs + flow.orderInputs + flow.remaining, id);
    }
  } finally { await loaded.close(); }
});
