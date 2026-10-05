import assert from "node:assert/strict";
import test from "node:test";
import { loadJourneyRules, simulateJourney } from "../scripts/simulate-player-journey.mjs";
import { lookaheadPolicy } from "../scripts/simulate-player-lookahead.mjs";

test("a simulated empty player reaches home two using actual commands without grants or a quarry", async () => {
  const loaded = await loadJourneyRules();
  try {
    const report = simulateJourney(loaded, "active16h", 1);
    assert(report.homeDays[2] > 0 && report.homeDays[2] < 1);
    assert(report.saleRevenue > 0);
    const order = report.milestones.map(m => m.building);
    assert(order.indexOf("woodlot:1") < order.indexOf("workshop:1"));
    assert(order.indexOf("workshop:1") < order.indexOf("home:2"));
    assert(order.indexOf("home:2") < order.indexOf("quarry:1"));
    assert.equal(report.actions.buy_fishing_item, undefined);
    assert.equal(report.actions.speedup_construction, undefined);
    assert.equal(report.actions.cancel_exploration, undefined);
    assert(report.actions.start_fishing > 0, "The current fishing UI path is exercised");
  } finally { await loaded.close(); }
});

test("lookahead prepares later upgrades with real commands while the default player policy stays unchanged", async () => {
  const loaded = await loadJourneyRules();
  try {
    const original = simulateJourney(loaded, "visits3", 40);
    assert.equal(original.homeDays[2], 2.667);
    assert.equal(original.homeDays[3], 25.333);
    const explicitDefault = simulateJourney(loaded, "visits3", 40, { prepareNextConstruction: false, preserveFutureCraftedStock: false });
    assert.deepEqual(explicitDefault, original);
    const planned = simulateJourney(loaded, "visits3", 40, lookaheadPolicy);
    assert(planned.homeDays[3] > 0 && planned.homeDays[3] < original.homeDays[3]);
    for (const result of [original, planned]) {
      assert.equal(result.actions.buy_fishing_item, undefined);
      assert.equal(result.actions.speedup_construction, undefined);
      assert.equal(result.actions.cancel_exploration, undefined);
      assert.equal(result.failures.ECONOMY_BUILDING_REQUIRED, undefined, "Planning must not start a locked recipe");
      assert(result.saleRevenue > 0);
      assert(result.actions.start_construction >= 14);
    }
  } finally { await loaded.close(); }
});
