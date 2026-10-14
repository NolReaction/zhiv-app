import assert from "node:assert/strict";
import test from "node:test";
import { loadJourneyRules, simulateJourney } from "../scripts/simulate-player-journey.mjs";
import { jointPlanningPolicy } from "../scripts/simulate-player-joint.mjs";
import { baselineGiftRules } from "../scripts/review-daily-gift-progression.mjs";

const policy = { ...jointPlanningPolicy, constructionSpeedups: false, parallelProductionPlanning: true, dailyRewards: true };

test("complete daily projection uses completed home tiers, the claim calendar and conserved inventory", async () => {
  const loaded = await loadJourneyRules();
  try {
    const report = simulateJourney(loaded, "visits3", 40, { ...policy, buyProductionSlots: true });
    const gifts = report.dailyRewards;
    const completedOrders = report.actions.complete_resident_order ?? 0;
    const courses = [...loaded.catalog.onboarding.residentOrders, ...loaded.catalog.stageOrders.flatMap(stage => stage.orders)];
    assert(completedOrders >= loaded.catalog.onboarding.residentOrders.length, "the calendar projection still completes the first course");
    assert(completedOrders <= courses.length, "permanent requests cannot be paid again");
    const delivered = courses.slice(0, completedOrders), orderInputs = {};
    for (const order of delivered) for (const [id, quantity] of Object.entries(order.items))
      orderInputs[id] = (orderInputs[id] ?? 0) + quantity;
    assert.equal(report.coinFlow.remaining, report.coinFlow.initial + report.coinFlow.sales + report.coinFlow.gifts + report.coinFlow.orders
      - Object.values(report.coinFlow.spendingByAction).reduce((sum, value) => sum + value, 0));
    assert.equal(report.coinFlow.initial, 100);
    assert.equal(report.coinFlow.orders, delivered.reduce((sum, order) => sum + order.coins, 0));
    assert(gifts.claims <= 40, "Three visits cannot create three daily bundles");
    assert(gifts.claims + gifts.storageDeferrals >= 40, "Missed daily bundles must be explained by storage deferrals");
    assert(!report.excludedIncome.includes("daily_rewards"));
    assert(report.excludedIncome.includes("player_market"));
    assert(gifts.claimRows.some(row => row.homeLevel >= 2));
    const earnedItems = {};
    const cycle = [
      { wood: 2, stone: 1 }, { fiber: 2, berries: 2 }, { planks: 1, wood: 1 },
      { fish: 1, berries: 1 }, { wood: 2, fiber: 2 }, { planks: 1, stone: 1 },
      { ancient_core: 1, planks: 1, wood: 1 },
    ];
    for (const [index, row] of gifts.claimRows.entries()) {
      assert.equal(row.step, index % 7 + 1);
      assert.deepEqual(row.reward, loaded.progressionRewards.dailyRewardCycle(row.homeLevel)[row.step - 1]);
      assert.equal(row.reward.coins, [30, 30, 40, 40, 50, 50, 80][row.step - 1] * row.homeLevel);
      assert.equal(row.reward.pearls, [80, 100, 120, 140, 160, 180, 220][row.step - 1]);
      assert.deepEqual(row.reward.items, cycle[row.step - 1], "completed homes keep the same compact stock without advanced gifts");
      if (index > 0) {
        assert(Date.parse(row.at) - Date.parse(gifts.claimRows[index - 1].at) >= 20 * 3_600_000);
        assert.notEqual(row.at.slice(0, 10), gifts.claimRows[index - 1].at.slice(0, 10));
      }
      for (const [id, quantity] of Object.entries(row.reward.items)) {
        const storedId = id === "fish" ? "fish_common" : id;
        earnedItems[storedId] = (earnedItems[storedId] ?? 0) + quantity;
      }
    }
    assert.deepEqual(gifts.itemsReceived, earnedItems);
    assert.equal(gifts.coinsReceived, gifts.claimRows.reduce((sum, row) => sum + row.reward.coins, 0));
    assert.equal(gifts.pearlsReceived, report.pearlsRemaining + report.pearlsSpent);
    assert.deepEqual(Object.fromEntries(Object.entries(report.itemFlow).filter(([, flow]) => flow.initial > 0)
      .map(([id, flow]) => [id, flow.initial])), { wood: 3, stone: 5 });
    assert.deepEqual(loaded.catalog.buildings.find(building => building.id === "warehouse").levels
      .map(level => level.warehouseCapacity), Array.from({ length: 10 }, (_, index) => (index + 1) * 50));
    assert.deepEqual(Object.fromEntries(Object.entries(report.itemFlow).filter(([, flow]) => flow.orderInputs > 0)
      .map(([id, flow]) => [id, flow.orderInputs])), orderInputs);
    for (const [id, flow] of Object.entries(report.itemFlow))
      assert.equal(flow.initial + flow.received, flow.sold + flow.productionInputs + flow.expeditionInputs + flow.constructionInputs + flow.orderInputs + flow.remaining, id);
    for (const [id, amount] of Object.entries(report.rareMaterials.inventory))
      assert.equal(amount, report.rareMaterials.received[id] + report.rareMaterials.stageRewards[id]
        + (gifts.itemsReceived[id] ?? 0) - report.rareMaterials.spentOnConstruction[id]);
  } finally { await loaded.close(); }
});

test("gift capacity rejection does not credit its wallet or advance its seven-step calendar", async () => {
  const loaded = await loadJourneyRules();
  try {
    let denied = 0, naturalDeferrals = 0;
    const observed = { ...loaded, rules: { ...loaded.rules,
      assertEconomyStorageTransition(before, after, ...rest) {
        if (after.wallet?.coins > before.wallet?.coins && denied < 5) {
          denied++;
          throw new loaded.rules.EconomyRuleError("ECONOMY_STORAGE_FULL", "Research forced capacity boundary");
        }
        try { return loaded.rules.assertEconomyStorageTransition(before, after, ...rest); }
        catch (error) {
          if (error.code === "ECONOMY_STORAGE_FULL" || error.code === "ECONOMY_CAPACITY") naturalDeferrals++;
          throw error;
        }
      } } };
    const report = simulateJourney(observed, "visits3", 5, policy);
    assert.equal(denied, 5);
    assert.equal(report.dailyRewards.storageDeferrals, denied + naturalDeferrals);
    assert(report.dailyRewards.claims > 0);
    assert.equal(report.dailyRewards.claimRows[0].step, 1);
    assert.equal(report.dailyRewards.pearlsReceived, report.pearlsRemaining);
    assert.equal(report.dailyRewards.coinsReceived, report.dailyRewards.claimRows.reduce((sum, row) => sum + row.reward.coins, 0));
    assert.equal(report.dailyRewards.itemsReceived.wood, report.dailyRewards.claimRows.reduce((sum, row) => sum + (row.reward.items.wood ?? 0), 0));
    assert.equal(report.coinFlow.remaining, report.coinFlow.initial + report.coinFlow.sales + report.coinFlow.gifts + report.coinFlow.orders
      - Object.values(report.coinFlow.spendingByAction).reduce((sum, value) => sum + value, 0));
    for (const [id, flow] of Object.entries(report.itemFlow))
      assert.equal(flow.initial + flow.received, flow.sold + flow.productionInputs + flow.expeditionInputs + flow.constructionInputs + flow.orderInputs + flow.remaining, id);
  } finally { await loaded.close(); }
});

test("before comparison claims the entire pinned old bundle rather than only its pearls", async () => {
  const loaded = await loadJourneyRules();
  try {
    const baseline = { dailyMinimumHours: 20, daily: Array.from({ length: 7 }, () => ({ coins: 123, pearls: 2, items: { wood: 1 } })) };
    const report = simulateJourney(baselineGiftRules(loaded, baseline), "visits3", 7, policy);
    assert.equal(report.dailyRewards.claims, 7);
    assert.equal(report.dailyRewards.coinsReceived, 861);
    assert.equal(report.dailyRewards.pearlsReceived, 14);
    assert.deepEqual(report.dailyRewards.itemsReceived, { wood: 7 });
  } finally { await loaded.close(); }
});
