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
    const expanded = simulateJourney(loaded, "visits3", 40, { ...base, buyProductionSlots: true, pearlBudget: 32500 });
    assert.equal(baseline.actions.buy_production_slot, undefined);
    assert(Object.values(baseline.productionSlots.maximumProductionJobs).every(count => count <= 1));
    assert.equal(expanded.actions.buy_production_slot, 5);
    assert.equal(expanded.pearlsSpent, 7500);
    assert.equal(expanded.pearlsRemaining, 25000);
    assert.equal(expanded.actions.speedup_construction, undefined, "A slot budget must not silently speed up construction");
    assert(expanded.homeDays[3] > 0, "Staggered harvesting must drain so garden upgrades do not deadlock");
    assert(expanded.productionSlots.maximumProductionJobs.garden === 2);
    assert(expanded.productionSlots.maximumProductionJobs.workshop === 2, "The second crafting slot must actually run concurrently");
    for (const purchase of expanded.productionSlots.purchases) {
      assert(purchase.houseLevel >= 2);
      assert(purchase.day >= expanded.homeDays[2]);
      assert.equal(purchase.slots, 2);
      assert.equal(purchase.pricePearls, 1500);
    }
    for (const code of ["ECONOMY_BUILDING_BUSY", "ECONOMY_BUILDING_REQUIRED", "ECONOMY_PEARLS", "ECONOMY_QUARRY_BUSY", "ECONOMY_EXPLORER_BUSY", "ECONOMY_COLLECTOR_BUSY"])
      assert.equal(expanded.failures[code], undefined);
    for (const [id, flow] of Object.entries(expanded.itemFlow))
      assert.equal(flow.received, flow.sold + flow.productionInputs + flow.expeditionInputs + flow.constructionInputs + flow.remaining, id);
    assert.equal(expanded.productionSlots.finalCapacity.quarry, undefined, "Mining must retain its single actor");
  } finally { await loaded.close(); }
});

test("daily-only pearl projection follows gift payouts and cannot buy a slot before earning its price", async () => {
  const loaded = await loadJourneyRules();
  try {
    const rewards = loaded.progressionRewards.progressionRewardsCatalog;
    assert.deepEqual(dailyPearlThreshold(rewards, 1500), { targetPearls: 1500, giftClaims: 27, elapsedDaysWithFirstGiftToday: 26, pearlsReceived: 1500 });
    assert.deepEqual(dailyPearlThreshold(rewards, 32500), { targetPearls: 32500, giftClaims: 510, elapsedDaysWithFirstGiftToday: 509, pearlsReceived: 32550 });
    const report = simulateJourney(loaded, "visits3", 40, { ...jointPlanningPolicy, constructionSpeedups: false,
      buyProductionSlots: true, dailyPearlsOnly: true });
    assert.equal(report.pearlBudget, 0);
    assert.equal(report.dailyPearlProjection.claims, 40, "Multiple daily visits cannot duplicate the UTC gift");
    const earned = Array.from({ length: 40 }, (_, index) => rewards.daily[index % rewards.daily.length].pearls).reduce((sum, amount) => sum + amount, 0);
    assert.equal(report.dailyPearlProjection.pearlsReceived, earned);
    assert.equal(report.pearlsSpent + report.pearlsRemaining, earned);
    assert.equal(report.productionSlots.purchases[0].day, 26);
    assert.equal(report.productionSlots.purchases.length, 1);
    assert.equal(report.actions.speedup_construction, undefined);
    assert.equal(report.actions.buy_fishing_item, undefined);
    assert(report.excludedIncome.includes("daily_reward_coins_and_items"));
  } finally { await loaded.close(); }
});
