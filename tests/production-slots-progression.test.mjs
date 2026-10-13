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
    assert.deepEqual(dailyPearlThreshold(rewards, 200), { targetPearls: 200, giftClaims: 7, elapsedDaysWithFirstGiftToday: 6, pearlsReceived: 450 });
    assert.deepEqual(dailyPearlThreshold(rewards, 3500), { targetPearls: 3500, giftClaims: 56, elapsedDaysWithFirstGiftToday: 55, pearlsReceived: 3600 });
    const report = simulateJourney(loaded, "visits3", 40, { ...jointPlanningPolicy, constructionSpeedups: false,
      buyProductionSlots: true, dailyPearlsOnly: true });
    assert.equal(report.pearlBudget, 0);
    assert.equal(report.dailyPearlProjection.claims, 40, "Multiple daily visits cannot duplicate the UTC gift");
    const earned = Array.from({ length: 40 }, (_, index) => rewards.daily[index % rewards.daily.length].pearls).reduce((sum, amount) => sum + amount, 0);
    assert.equal(report.dailyPearlProjection.pearlsReceived, earned);
    assert.equal(report.pearlsSpent + report.pearlsRemaining, earned);
    assert.equal(report.productionSlots.purchases[0].day, 6);
    assert(report.productionSlots.purchases.length > 1);
    for (const purchase of report.productionSlots.purchases) {
      const byDay = Math.floor(purchase.day), earnedAtPurchase = Array.from({ length: byDay + 1 }, (_, index) => rewards.daily[index % rewards.daily.length].pearls).reduce((sum, amount) => sum + amount, 0);
      const paidByPurchase = report.productionSlots.purchases.filter(row => row.day <= purchase.day).reduce((sum, row) => sum + row.pricePearls, 0);
      assert(paidByPurchase <= earnedAtPurchase, "Slots consume already earned pearls");
    }
    assert.equal(report.actions.speedup_construction, undefined);
    assert.equal(report.actions.buy_fishing_item, undefined);
    assert(report.excludedIncome.includes("daily_reward_coins_and_items"));
  } finally { await loaded.close(); }
});
