import assert from "node:assert/strict";
import test from "node:test";
import { createJourneyRareRandom, DEFAULT_JOURNEY_RARE_SEED, journeyConstructionOrder, journeyOrder, loadJourneyRules, simulateJourney } from "../scripts/simulate-player-journey.mjs";
import { readEconomyCatalog } from "../scripts/audit-economy-progression.mjs";
import { lookaheadPolicy } from "../scripts/simulate-player-lookahead.mjs";
import { jointPlanningPolicy } from "../scripts/simulate-player-joint.mjs";
import { loadProgressionRules, simulateProgression, summarizeProgression } from "../scripts/simulate-economy-progression.mjs";

test("a simulated new player reaches home two from starting supplies using actual commands without extra grants or a quarry", async () => {
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
    assert.equal(report.actions.complete_resident_order, 12);
    const course = home => loaded.catalog.stageOrders.find(stage => stage.homeLevel === home);
    const expectedOrders = loaded.catalog.onboarding.residentOrder.coins
      + [1, 2].reduce((sum, home) => sum + course(home).orders.reduce((total, order) => total + order.coins, 0), 0)
      + course(3).orders[0].coins;
    assert.equal(report.coinFlow.orders, expectedOrders);
    assert.equal(report.actions.claim_tutorial_order, undefined);
    assert.equal(report.actions.claim_workshop_starter, undefined);
    assert(report.actions.start_fishing > 0, "The current fishing UI path is exercised");
    assert.equal(report.completionGoal, "base-tier-5");
    assert.equal(report.targetBuildingLevels.warehouse, 5);
  } finally { await loaded.close(); }
});

test("the comparison base, final home and all current upgrades are distinct reproducible goals", async () => {
  const catalog = readEconomyCatalog();
  assert.deepEqual(journeyConstructionOrder(catalog), journeyOrder);
  const full = journeyConstructionOrder(catalog, "all-current-buildings");
  assert.deepEqual(full.slice(-5),
    ["warehouse:6", "warehouse:7", "warehouse:8", "warehouse:9", "warehouse:10"]);
  assert(full.indexOf("quarry:5") < full.indexOf("warehouse:8"), "mortar source must precede its optional storage upgrade");
  const home = journeyConstructionOrder(catalog, "home-5");
  assert.equal(home.at(-1), "home:5");
  assert(!home.some(key => key.startsWith("warehouse:") && Number(key.split(":")[1]) > 4));
  assert.throws(() => journeyConstructionOrder(catalog, "everything"), /Invalid research completion goal/);
  const loaded = await loadJourneyRules();
  try {
    const fullStart = simulateJourney(loaded, "active16h", 1, { completionGoal: "all-current-buildings" });
    const comparisonStart = simulateJourney(loaded, "active16h", 1);
    assert.equal(fullStart.completionGoal, "all-current-buildings");
    assert.equal(fullStart.targetBuildingLevels.warehouse, 10);
    assert.equal(fullStart.complete, false);
    assert.deepEqual(fullStart.milestones, comparisonStart.milestones, "Optional expansion goals cannot change the opening route");
    assert.deepEqual(fullStart.finalBuildingLevels, comparisonStart.finalBuildingLevels);
  } finally { await loaded.close(); }
});

// The old journey helper remains useful for opening-route/lookahead research.
// Full progression is tested with the same current command policy as /branch.
test("the canonical eight-hour daily player earns every building and storage ten with real relics", async t => {
  const loaded = await loadProgressionRules();
  try {
    const exchangeReceipts = [], exchangeConfig = loaded.catalog.leaftailShop.relicExchange;
    const observed = { ...loaded, rules: { ...loaded.rules, applyEconomyCommand(state, command, ...args) {
      if (command.action !== "exchange_leaftail_relic") return loaded.rules.applyEconomyCommand(state, command, ...args);
      const [fromItemId, toItemId] = command.targetId.split(":");
      const before = { coins: state.wallet.coins, inventory: { ...state.inventory } };
      const value = loaded.rules.applyEconomyCommand(state, command, ...args);
      assert.equal(command.quantity, 1);
      assert.equal(command.totalPrice, exchangeConfig.priceCoins);
      assert.notEqual(fromItemId, toItemId);
      assert(loaded.catalog.rareDrops.itemIds.includes(fromItemId) && loaded.catalog.rareDrops.itemIds.includes(toItemId));
      const receipt = { fromItemId, toItemId,
        spentQuantity: (before.inventory[fromItemId] ?? 0) - (state.inventory[fromItemId] ?? 0),
        receivedQuantity: (state.inventory[toItemId] ?? 0) - (before.inventory[toItemId] ?? 0),
        paidCoins: before.coins - state.wallet.coins };
      assert.equal(receipt.spentQuantity, exchangeConfig.quantity);
      assert.equal(receipt.receivedQuantity, 1);
      assert.equal(receipt.paidCoins, exchangeConfig.priceCoins);
      for (const id of loaded.catalog.rareDrops.itemIds.filter(id => ![fromItemId, toItemId].includes(id)))
        assert.equal(state.inventory[id] ?? 0, before.inventory[id] ?? 0, `${id}: exchange cannot alter a third relic type`);
      exchangeReceipts.push(receipt);
      return value;
    } } };
    const result = simulateProgression(observed, { seed: 1, visitsPerDay: 1, regularActiveMinutes: 480, firstVisitMinutes: 480,
      maxDays: 240, claimRewards: true, completionGoal: "all-buildings", slotPolicy: "earned", speedupPolicy: "none" });
    // This also verifies every item and both currencies against the actual
    // receipt ledger, including supplies, rewards, slot purchases and sales.
    const report = summarizeProgression(result);
    assert.equal(report.completed, true, JSON.stringify({ elapsedDays: report.elapsedDays, buildings: report.buildings, waits: report.lastWaits }));
    assert.equal(result.externalSlotBudget, 0);
    assert.equal(result.state.buildings.warehouse, 10);
    for (const building of loaded.catalog.buildings) assert.equal(result.state.buildings[building.id], building.levels.at(-1).level);
    assert(exchangeReceipts.length > 0, "This seeded route exercises the paid duplicate exchange");
    assert.equal(report.actions.exchange_leaftail_relic, exchangeReceipts.length);
    assert.equal(report.coinLedger.debits.exchange_leaftail_relic, exchangeReceipts.reduce((sum, receipt) => sum + receipt.paidCoins, 0));
    assert.deepEqual(result.relicExchanges.map(({ fromItemId, toItemId, spentQuantity, receivedQuantity, paidCoins }) =>
      ({ fromItemId, toItemId, spentQuantity, receivedQuantity, paidCoins })), exchangeReceipts,
    "The simulator ledger must describe the actual inventory and wallet changes");
    for (const id of loaded.catalog.rareDrops.itemIds) {
      const required = loaded.catalog.buildings.reduce((sum, building) => sum + building.levels.reduce((total, level) => total + (level.cost.items[id] ?? 0), 0), 0);
      const exchanged = exchangeReceipts.filter(receipt => receipt.fromItemId === id).reduce((sum, receipt) => sum + receipt.spentQuantity, 0);
      assert.equal(result.flow[id].consumed, required + exchanged, `${id}: construction and paid exchange inputs are both actually consumed`);
      assert.equal(result.flow[id].sold, 0, `${id}: rare stock is never sold for coins`);
      assert.equal(result.flow[id].received - required - exchanged, result.state.inventory[id] ?? 0,
        `${id}: grants, claimed finds and exchange outputs are conserved`);
    }
    assert(result.builds.some(build => build.target === "warehouse" && build.level === 10));
    const daily = result.rewardClaims.filter(claim => claim.kind === "daily");
    assert.equal(daily.length, 7);
    assert.equal(new Set(daily.map(claim => claim.id)).size, 7, "the gift chain never repeats");
    assert.equal(daily.reduce((sum, claim) => sum + claim.pearls, 0), loaded.rewards.progressionRewardsCatalog.daily
      .reduce((sum, reward) => sum + reward.pearls, 0));
    assert.equal(report.actions.speedup_construction, undefined);
    assert.equal(report.actions.cancel_exploration, undefined);
    assert.equal(report.actions.buy, undefined, "the route needs no other player's market supply");
    assert(report.allBuildingsDays <= 240);
    t.diagnostic(JSON.stringify({ allBuildingsDays: report.allBuildingsDays, commands: report.commandCount,
      activeHours: report.activeHours, relicWorkSeconds: report.claimedWorkSeconds, exchanges: exchangeReceipts, buildings: report.buildings }));
  } finally { await loaded.close(); }
});

test("lookahead prepares later upgrades with real commands while omitted options match the default policy", async () => {
  const loaded = await loadJourneyRules();
  try {
    const original = simulateJourney(loaded, "visits3", 40);
    assert(original.homeDays[2] > 1 && original.homeDays[2] < 5);
    assert(original.homeDays[3] > original.homeDays[2] && original.homeDays[3] < 40);
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
    const casts = [], fishSales = [];
    const observed = { ...loaded, rules: { ...loaded.rules, applyEconomyCommand: (state, command, now, jobId, reserved, rareRandom) => {
      const beforeCoins = state.wallet.coins;
      const result = loaded.rules.applyEconomyCommand(state, command, now, jobId, reserved, rareRandom);
      if (command.action === "start_fishing") casts.push(state.fishingCastSeed);
      const group = loaded.fishing.fishClassForItem(command.targetId, loaded.catalog.fishing);
      if (group && ["sell", "sell_fish"].includes(command.action)) {
        assert.equal(command.action, "sell_fish", "The simulated player sells class stock to Pleska at the specialist price");
        const price = loaded.catalog.items.find(item => item.id === group.itemId).baseSellPrice;
        assert.equal(state.wallet.coins - beforeCoins, price * command.quantity);
        fishSales.push(group.itemId);
      }
      return result;
    } } };
    // Minute-scale fishing needs an active visit schedule. At three visits per
    // day, a rational construction policy prefers long forest/mining outings.
    const baselineReport = simulateJourney(observed, "active16h", 2, lookaheadPolicy);
    const baseline = casts.splice(0);
    assert(fishSales.length > 0 && fishSales.every(id => id.startsWith("fish_")));
    const result = simulateJourney(observed, "active16h", 2, { ...lookaheadPolicy, pearlBudget: 1000 });
    const pairedCasts = Math.min(casts.length, baseline.length);
    const secondCourse = loaded.catalog.stageOrders.find(course => course.homeLevel === 2);
    const requiredFish = secondCourse.orders.reduce((sum, order) => sum + (order.items.fish_common ?? 0)
      + (order.items.grilled_fish ?? 0) * loaded.catalog.recipes.find(recipe => recipe.id === "cook_grilled_fish").cost.items.fish_common, 0);
    const minimumCasts = Math.ceil(requiredFish / loaded.catalog.fishing.collectionDrawsByRoute.shore);
    assert(baselineReport.homeDays[3] > 0 && result.homeDays[3] > 0);
    assert(pairedCasts >= minimumCasts, "Both policies execute the entire mandatory fishing course before their paired seeds are compared");
    assert.deepEqual(casts.slice(0, pairedCasts), baseline.slice(0, pairedCasts), "The paired scenarios share the same nth-cast seeds");
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

test("the early-route simulator counts only completed home-three relic work and conserves any resulting finds", async () => {
  const loaded = await loadJourneyRules();
  try {
    const starts = [], claims = [];
    const observed = { ...loaded, rules: { ...loaded.rules, applyEconomyCommand: (state, command, now, jobId, reserved, rareRandom) => {
      const home = state.buildings.home;
      const claimedJob = command.action === "claim_job" ? structuredClone(state.jobs.find(job => job.id === command.targetId)) : null;
      const result = loaded.rules.applyEconomyCommand(state, command, now, jobId, reserved, rareRandom);
      if (command.action === "start_fishing" || command.action === "start_exploration") {
        const job = state.jobs.find(job => job.kind === "exploration" && job.targetId === command.targetId && Date.parse(job.startedAt) === now);
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
    assert(claims.some(job => job.rareDrop.seconds > 0), "claimed eligible jobs really advance the relic clocks");
    // Forty days of brief visits complete less work per actor than a guaranteed
    // drop interval. The canonical full-building test exercises actual finds.
    assert(report.rareMaterials.finds.every(find => find.day > report.homeDays[3]));
    assert.equal(report.rareMaterials.finds.length, claims.filter(job => job.rareDrop.itemId).length);
    for (const id of loaded.catalog.rareDrops.itemIds) {
      assert.equal(report.rareMaterials.received[id], claims.reduce((sum, job) => sum + (job.rewards[id] ?? 0), 0));
      assert.equal(report.rareMaterials.received[id] + report.rareMaterials.stageRewards[id]
        - report.rareMaterials.spentOnConstruction[id], report.rareMaterials.inventory[id]);
    }
    assert.deepEqual(simulateJourney(loaded, "visits3", 40, jointPlanningPolicy), report, "The complete current-catalog sample path is reproducible");
    assert(report.excludedIncome.includes("daily_rewards") && report.excludedIncome.includes("achievement_rewards"));
    assert.equal(report.actions.cancel_exploration, undefined);
    assert.equal(report.actions.speedup_construction, undefined);
  } finally { await loaded.close(); }
});

test("joint planning uses only current unit production without reviving retired bulk work or granting its inputs", async () => {
  const loaded = await loadJourneyRules();
  try {
    const result = simulateJourney(loaded, "visits3", 40, jointPlanningPolicy);
    assert.equal(result.productionRecipes.workshop_overnight, undefined);
    assert(result.productionRecipes.make_planks > 0 && result.productionRecipes.make_rope > 0);
    for (const id of Object.keys(result.productionRecipes)) {
      const recipe = loaded.catalog.recipes.find(recipe => recipe.id === id);
      assert(recipe, `current recipe ${id}`); assert.equal(recipe.maxBatch, 1);
      assert.equal(Object.values(recipe.rewards).reduce((sum, amount) => sum + amount, 0), 1);
    }
    assert(result.homeDays[3] > 0);
    assert.equal(result.failures.ECONOMY_BUILDING_REQUIRED, undefined);
    assert.equal(result.actions.speedup_construction, undefined);
    assert.equal(result.actions.buy_fishing_item, undefined);
    assert(result.saleRevenue > 0);
  } finally { await loaded.close(); }
});

test("the early player policy schedules independent actors and records eligible relic work without overlapping them", async () => {
  const loaded = await loadJourneyRules();
  try {
    const actorSeconds = { miner: 0, exploration: 0, collection: 0 }; let parallelActors = false;
    const observed = { ...loaded, rules: { ...loaded.rules, applyEconomyCommand: (state, command, now, jobId, reserved, rareRandom) => {
      const claimed = command.action === "claim_job" ? structuredClone(state.jobs.find(job => job.id === command.targetId)) : null;
      const result = loaded.rules.applyEconomyCommand(state, command, now, jobId, reserved, rareRandom);
      const active = state.jobs.filter(job =>
        ((job.kind === "exploration" || loaded.actorAvailability.isQuarryProduction(job)) && Date.parse(job.finishesAt) > now)
        || (job.collection?.startedAt && Date.parse(job.collection.finishesAt) > now));
      const miners = active.filter(job => job.actorId === "miner");
      const heroes = active.filter(job => job.actorId !== "miner");
      assert(miners.length <= 1 && heroes.length <= 1, "An observed confirmed state must not schedule the same actor twice");
      parallelActors ||= miners.length === 1 && heroes.length === 1;
      if (claimed) {
        const seconds = (Date.parse(claimed.finishesAt) - Date.parse(claimed.startedAt)) / 1000;
        if (claimed.kind === "exploration") actorSeconds[claimed.actorId === "miner" ? "miner" : "exploration"] += seconds;
        if (loaded.actorAvailability.isQuarryProduction(claimed)) actorSeconds.exploration += seconds;
        if (claimed.collection?.startedAt) actorSeconds.collection += claimed.collection.seconds;
      }
      return result;
    } } };
    const report = simulateJourney(observed, "visits3", 40, jointPlanningPolicy);
    for (const kind of Object.keys(actorSeconds)) {
      assert(actorSeconds[kind] > 0);
      assert.equal(report.actorWorkHours[kind], Number((actorSeconds[kind] / 3600).toFixed(4)));
    }
    assert(parallelActors, "A genuine confirmed state exercises simultaneous mining and hero activity");
    assert(actorSeconds.miner <= report.elapsedDays * 86400);
    assert(actorSeconds.exploration + actorSeconds.collection <= report.elapsedDays * 86400);
    for (const code of ["ECONOMY_MINER_BUSY", "ECONOMY_QUARRY_BUSY", "ECONOMY_EXPLORER_BUSY", "ECONOMY_COLLECTOR_BUSY"])
      assert.equal(report.failures[code], undefined, "Policy availability matches the authoritative rule");
    assert(report.rareMaterials.eligibleExplorationHours > 0, "completed work advances independent relic clocks even before a find is due");
  } finally { await loaded.close(); }
});


test("the scenario conserves crafted inputs and exposes sales separately from progression consumption", async () => {
  const loaded = await loadJourneyRules();
  try {
    const report = simulateJourney(loaded, "visits3", 40, jointPlanningPolicy);
    assert(Object.entries(report.explorationRoutes).some(([id, count]) => id.startsWith("quarry_") && count > 0));
    assert.equal(report.productionRecipes.quarry_stone, undefined);
    for (const [id, flow] of Object.entries(report.itemFlow))
      assert.equal(flow.initial + flow.received, flow.sold + flow.productionInputs + flow.expeditionInputs + flow.constructionInputs + flow.orderInputs + flow.remaining, id);
    assert(report.itemFlow.fiber.productionInputs > 0, "Fiber serves actual crafting demand");
    assert(report.itemFlow.rope.constructionInputs > 0, "Rope serves actual construction demand");
    assert(report.saleRevenue > 0);
    assert(Object.entries(report.itemFlow).some(([id, flow]) => flow.sold > 0
      && loaded.catalog.items.find(item => item.id === id)?.category === "raw"), "Passive raw surplus pays progression coin costs");
  } finally { await loaded.close(); }
});
