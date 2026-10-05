import assert from "node:assert/strict";
import test from "node:test";
import { createJourneyRareRandom, DEFAULT_JOURNEY_RARE_SEED, loadJourneyRules, simulateJourney } from "../scripts/simulate-player-journey.mjs";
import { lookaheadPolicy } from "../scripts/simulate-player-lookahead.mjs";
import { jointPlanningPolicy } from "../scripts/simulate-player-joint.mjs";

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

test("an explicit research pearl balance pays only actual construction speedups and cannot create materials", async () => {
  const loaded = await loadJourneyRules();
  try {
    const casts = [];
    const observed = { ...loaded, rules: { ...loaded.rules, applyEconomyCommand: (state, command, now, jobId, reserved, rareRandom) => {
      const result = loaded.rules.applyEconomyCommand(state, command, now, jobId, reserved, rareRandom);
      if (command.action === "start_fishing") casts.push(state.fishingCastSeed);
      return result;
    } } };
    simulateJourney(observed, "visits3", 40, lookaheadPolicy);
    const baseline = casts.splice(0);
    const result = simulateJourney(observed, "visits3", 40, { ...lookaheadPolicy, pearlBudget: 1000 });
    assert(casts.length >= 50 && baseline.length >= 50);
    assert.deepEqual(casts.slice(0, 50), baseline.slice(0, 50), "The paired scenarios share the same nth-cast seeds");
    assert(result.actions.speedup_construction > 0);
    assert(result.pearlsSpent > 0 && result.pearlsSpent <= 1000);
    assert.equal(result.pearlsRemaining + result.pearlsSpent, 1000);
    assert.equal(result.actions.buy_fishing_item, undefined);
    assert.equal(result.failures.ECONOMY_PEARLS, undefined);
    assert.equal(result.failures.ECONOMY_BUILDING_REQUIRED, undefined);
    assert(result.saleRevenue > 0, "Construction resources and coins still require ordinary acquisition");
    const ids = result.milestones.map(m => m.building);
    assert.equal(new Set(ids).size, ids.length, "A speedup must not complete the same upgrade twice");
    assert.throws(() => simulateJourney(loaded, "visits3", 1, { pearlBudget: -1 }), /Invalid research pearl budget/);
  } finally { await loaded.close(); }
});

test("research relic entropy is bounded, reproducible and can roll back a rejected transition", () => {
  const random = createJourneyRareRandom(DEFAULT_JOURNEY_RARE_SEED);
  const snapshot = random.snapshot();
  const draw = () => Array.from({ length: 32 }, (_, i) => random.integer(i % 2 ? 3 : 345601));
  const first = draw();
  assert(first.every((value, i) => Number.isInteger(value) && value >= 0 && value < (i % 2 ? 3 : 345601)));
  random.restore(snapshot);
  assert.deepEqual(draw(), first);
  const paired = createJourneyRareRandom(DEFAULT_JOURNEY_RARE_SEED);
  assert.deepEqual(Array.from({ length: 32 }, (_, i) => paired.integer(i % 2 ? 3 : 345601)), first);
  assert.throws(() => createJourneyRareRandom(0), /Invalid research relic seed/);
  assert.throws(() => random.integer(0), /Invalid relic draw bound/);
});

test("the current simulator earns relics only from completed home-three explorations and keeps their stock", async () => {
  const loaded = await loadJourneyRules();
  try {
    const starts = [], claims = [];
    const observed = { ...loaded, rules: { ...loaded.rules, applyEconomyCommand: (state, command, now, jobId, reserved, rareRandom) => {
      const home = state.buildings.home;
      const claimedJob = command.action === "claim_job" ? structuredClone(state.jobs.find(job => job.id === command.targetId)) : null;
      const result = loaded.rules.applyEconomyCommand(state, command, now, jobId, reserved, rareRandom);
      if (command.action === "start_fishing" || command.action === "start_exploration") {
        const job = state.jobs.find(job => job.kind === "exploration");
        starts.push({ home, rare: job.rareDrop });
      }
      if (claimedJob?.rareDrop) claims.push(claimedJob);
      assert(!(command.action === "sell" && loaded.catalog.items.find(item => item.id === command.targetId)?.category === "special"));
      return result;
    } } };
    const report = simulateJourney(observed, "visits3", 40, jointPlanningPolicy);
    assert(starts.some(start => start.home < 3) && starts.some(start => start.home >= 3));
    assert(starts.every(start => Boolean(start.rare) === (start.home >= 3)));
    assert.equal(report.rareMaterials.seed, DEFAULT_JOURNEY_RARE_SEED);
    assert.equal(report.rareMaterials.eligibleExplorationHours, Number((claims.reduce((sum, job) => sum + job.rareDrop.seconds, 0) / 3600).toFixed(4)));
    assert(report.rareMaterials.finds.length > 0);
    assert(report.rareMaterials.finds.every(find => find.day > report.homeDays[3]));
    assert.equal(report.rareMaterials.finds.length, claims.filter(job => job.rareDrop.itemId).length);
    for (const id of loaded.catalog.rareDrops.itemIds) {
      assert.equal(report.rareMaterials.received[id], claims.reduce((sum, job) => sum + (job.rewards[id] ?? 0), 0));
      assert.equal(report.rareMaterials.received[id] - report.rareMaterials.spentOnConstruction[id], report.rareMaterials.inventory[id]);
    }
    assert.deepEqual(simulateJourney(loaded, "visits3", 40, jointPlanningPolicy), report, "The complete current-catalog sample path is reproducible");
    assert(report.excludedIncome.includes("daily_rewards") && report.excludedIncome.includes("achievement_rewards"));
    assert.equal(report.actions.cancel_exploration, undefined);
    assert.equal(report.actions.speedup_construction, undefined);
  } finally { await loaded.close(); }
});

test("joint planning actually starts multi-output orders without unlocking stations or granting their inputs", async () => {
  const loaded = await loadJourneyRules();
  try {
    const result = simulateJourney(loaded, "visits3", 40, jointPlanningPolicy);
    assert(result.productionRecipes.workshop_overnight > 0);
    assert(result.homeDays[3] > 0);
    assert.equal(result.failures.ECONOMY_BUILDING_REQUIRED, undefined);
    assert.equal(result.actions.speedup_construction, undefined);
    assert.equal(result.actions.buy_fishing_item, undefined);
    assert(result.saleRevenue > 0);
  } finally { await loaded.close(); }
});
