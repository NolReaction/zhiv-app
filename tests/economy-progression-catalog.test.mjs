import assert from "node:assert/strict";
import test from "node:test";
import { auditEconomyProgression, readEconomyCatalog } from "../scripts/audit-economy-progression.mjs";
import { createLiquidation } from "../scripts/lib/economy-math.mjs";

test("economy catalog has useful chains, reachable actual tiers and separate project and construction bounds", () => {
  const catalog = readEconomyCatalog(), report = auditEconomyProgression(catalog);
  assert.equal(report.itemCount, catalog.items.length);
  assert.equal(report.buildingCount, catalog.buildings.length);
  assert.equal(report.buildingCount, 10);
  assert.equal(report.constructionOrder.length, catalog.buildings.reduce((sum, building) => sum + building.levels.length, 0) - 3);
  assert.equal(report.completionLevels.warehouse, 10);
  assert.equal(report.completionLevels.bridge, 1);
  assert.equal(report.completionLevels.lighthouse, 1);
  assert.deepEqual(report.completionLevels, Object.fromEntries(catalog.buildings.map(building => [building.id, building.levels.at(-1).level])));
  assert.ok(report.fullBaseMinimumSeconds > report.fiveTierBaseMinimumSeconds);
  assert.equal(report.projects.find(stage => stage.homeLevel === 3).minimumWaitSeconds, 7 * 86400);
  assert.equal(report.projects.find(stage => stage.homeLevel === 4).minimumWaitSeconds, 11 * 86400);
  assert.equal(report.fourthStage.constructionCoins, 73300);
  assert.equal(report.fourthStage.constructionSeconds, 96 * 3600);
  assert.equal(report.fourthStage.longWorkshopJobs, 39);
  assert.match(report.timingBasis, /construction queue.*actual play duration are separate/);
});

test("the quarry and workshop furnace follow home two without blocking the starter route", () => {
  const catalog = readEconomyCatalog(), report = auditEconomyProgression(catalog);
  const order = key => report.constructionOrder.indexOf(key);
  assert.ok(order("woodlot:1") < order("home:2"));
  assert.ok(order("workshop:1") < order("home:2"));
  assert.ok(order("home:2") < order("quarry:1"));
  assert.ok(order("quarry:1") < order("quarry:2"));
  assert.ok(order("quarry:2") < order("kiln:1"));
  assert.ok(order("workshop:1") < order("kiln:1"));
  assert.ok(order("kiln:1") < order("home:3"));
  assert.equal(catalog.buildings.find(building => building.id === "home").levels[2].requiredBuildings.warehouse, undefined);
});

test("the catalog cannot accidentally require the closed quarry to unlock home two", () => {
  const catalog = readEconomyCatalog();
  catalog.buildings.find(building => building.id === "home").levels[1].requiredBuildings.quarry = 1;
  assert.throws(() => auditEconomyProgression(catalog), /Construction dependency cycle/);
});

test("starter exploration stone is required to reach home two without market purchases", () => {
  const catalog = readEconomyCatalog();
  for (const route of catalog.explorations.filter(route => route.requiredHomeLevel === 1)) delete route.rewards.stone;
  assert.throws(() => auditEconomyProgression(catalog), /Resources cannot be produced|dependency blocks/);
});

test("catalog audit catches a resource-source cycle even when the explicit construction graph is acyclic", () => {
  const catalog = readEconomyCatalog();
  catalog.buildings.find(building => building.id === "workshop").levels[0].cost.items.reinforced_parts = 1;
  assert.throws(() => auditEconomyProgression(catalog), /Resources cannot be produced|dependency blocks/);
});

test("catalog audit rejects building prerequisites that route back through the target home", () => {
  const catalog = readEconomyCatalog();
  catalog.buildings.find(building => building.id === "workshop").levels[0].requiredHomeLevel = 2;
  assert.throws(() => auditEconomyProgression(catalog), /Construction dependency cycle/);
});

test("catalog audit rejects compression of the authored stage construction contracts", () => {
  const catalog = readEconomyCatalog();
  for (const building of catalog.buildings) for (const level of building.levels) level.seconds = Math.floor(level.seconds / 10);
  assert.throws(() => auditEconomyProgression(catalog), /Third stage home construction.*24 hours|Fourth stage.*48 hours|Fourth stage.*96 hours/);
});

test("warehouse has ten increasing tiers, ordinary early costs and independent relic expansions", () => {
  const catalog = readEconomyCatalog();
  const warehouse = catalog.buildings.find(building => building.id === "warehouse");
  assert.deepEqual(warehouse.levels.map(level => level.level), Array.from({ length: 10 }, (_, index) => index + 1));
  for (const mutate of [
    c => c.buildings.find(building => building.id === "warehouse").levels[2].cost.items.living_resin = 1,
    c => c.buildings.find(building => building.id === "warehouse").levels[3].cost.coins = 10,
    c => c.buildings.find(building => building.id === "warehouse").levels[3].requiredHomeLevel = 4,
    c => c.buildings.find(building => building.id === "warehouse").levels[3].requiredBuildings.workshop = 3,
    c => c.buildings.find(building => building.id === "warehouse").levels[3].cost.items.planks = 1,
    c => c.buildings.find(building => building.id === "warehouse").levels[9].warehouseCapacity = 8200,
  ]) {
    const invalid = structuredClone(catalog); mutate(invalid);
    assert.throws(() => auditEconomyProgression(invalid), /early storage|relic storage|storage must grow|storage must keep/);
  }
});

test("only warehouse two requires home two and storage tiers cannot acquire other-building unlock requirements", () => {
  const catalog = readEconomyCatalog();
  for (const level of catalog.buildings.find(building => building.id === "warehouse").levels) {
    assert.equal(level.requiredHomeLevel, level.level === 2 ? 2 : 1);
    assert.deepEqual(level.requiredBuildings, {});
    for (const requirement of ["home", "workshop"]) {
      const invalid = structuredClone(catalog), target = invalid.buildings.find(building => building.id === "warehouse").levels.find(candidate => candidate.level === level.level);
      if (requirement === "home") target.requiredHomeLevel = level.level === 2 ? 3 : 2;
      else target.requiredBuildings.workshop = 1;
      assert.throws(() => auditEconomyProgression(invalid), /storage must keep only the declared second-stage house gate/, `storage ${level.level}: ${requirement}`);
    }
  }
});

test("optional warehouse tiers cannot gate the final home or replace the authored home construction", () => {
  const catalog = readEconomyCatalog();
  catalog.buildings.find(building => building.id === "home").levels[4].requiredBuildings.warehouse = 6;
  assert.throws(() => auditEconomyProgression(catalog), /Storage expansion must not gate ordinary buildings or homes/);
  const compressed = readEconomyCatalog();
  for (const building of compressed.buildings) for (const level of building.levels) if (level.level <= 5) level.seconds = Math.floor(level.seconds / 10);
  assert.throws(() => auditEconomyProgression(compressed), /Third stage home construction.*24 hours|Fourth stage.*48 hours|Fourth stage.*96 hours/);
});


test("fishing shop cannot introduce buy-sell arbitrage or meaningless tackle specializations", () => {
  const catalog = readEconomyCatalog();
  catalog.fishing.fish.find(fish => fish.itemId === "fish_mooncarp").buyPrice = 1;
  assert.throws(() => auditEconomyProgression(catalog), /arbitrage/);
  const invalid = readEconomyCatalog();
  invalid.fishing.rods[0].classOddsBps.common = 0;
  assert.throws(() => auditEconomyProgression(invalid), /class probabilities/);
});


test("local-sale audit protects processing margins and rejects a zero recovery payout", () => {
  const lowSmokedPrice = readEconomyCatalog();
  const recipe = lowSmokedPrice.recipes.find(recipe => recipe.id === "smoke_fish");
  const actualInputs = createLiquidation(lowSmokedPrice)(recipe.cost.items) + recipe.cost.coins;
  lowSmokedPrice.localBuyer.unitPrices.smoked_fish = actualInputs;
  assert.throws(() => auditEconomyProgression(lowSmokedPrice), /actual sale proceeds/);
  const unavailableRecovery = readEconomyCatalog();
  unavailableRecovery.localBuyer.payoutBps = 0;
  assert.throws(() => auditEconomyProgression(unavailableRecovery), /Invalid local buyer payout/);
});

test("unit production, bounded unattended mining and ingredient value cannot silently regress", () => {
  for (const [id, mutate, pattern] of [
    ["grow_berries", r => r.maxBatch = 10, /cannot be bulk queued|First-stage production must reserve one slot/],
    ["garden_abundance", r => r.rewards.berries = 2, /Every current production recipe must reserve one slot for one item/],
    ["quarry_stone_overnight", r => r.rewards.stone = 110, /unattended output|quarter of storage/],
    ["make_planks", r => r.cost.items.wood = 100, /crafting destroys NPC value|crafting destroys actual sale proceeds/],
  ]) {
    const catalog = readEconomyCatalog(); mutate([...catalog.recipes, ...catalog.explorations].find(r => r.id === id));
    assert.throws(() => auditEconomyProgression(catalog), pattern, id);
  }
});

test("the authored v9 catalog keeps every current production unit-sized and every storage gate optional", () => {
  const catalog = readEconomyCatalog();
  assert.equal(catalog.version, 9); assert.equal(catalog.recipes.length, 41);
  for (const recipe of catalog.recipes) {
    assert.equal(recipe.maxBatch, 1, recipe.id);
    assert.equal(Object.values(recipe.rewards).reduce((sum, count) => sum + count, 0), 1, recipe.id);
    assert.equal(recipe.requiredBuildings?.warehouse, undefined, recipe.id);
    const invalid = structuredClone(catalog); invalid.recipes.find(entry => entry.id === recipe.id).maxBatch = 2;
    assert.throws(() => auditEconomyProgression(invalid), /production.*one slot for one item/, recipe.id);
  }
  for (const route of catalog.explorations) assert.equal(route.requiredBuildings?.warehouse, undefined, route.id);
  for (const building of catalog.buildings.filter(entry => entry.id !== "warehouse")) for (const level of building.levels) {
    assert.equal(level.requiredBuildings?.warehouse, undefined, `${building.id}:${level.level}`);
    assert.ok(Object.values(level.cost.items).reduce((sum, count) => sum + count, 0) <= 42, `${building.id}:${level.level}`);
  }
});

test("project pacing cannot lose its daily fences or guaranteed home relics", () => {
  for (const [mutate, pattern] of [
    [c => c.stageOrders.find(stage => stage.homeLevel === 3).orders.pop(), /Third stage project.*eight deliveries/],
    [c => c.stageOrders.find(stage => stage.homeLevel === 3).intervalSeconds = 86399, /Third stage project.*daily waits/],
    [c => c.stageOrders.find(stage => stage.homeLevel === 3).completionRewards = {}, /Third stage must guarantee/],
    [c => c.stageOrders.find(stage => stage.homeLevel === 4).orders.pop(), /Fourth stage project.*twelve deliveries/],
    [c => c.stageOrders.find(stage => stage.homeLevel === 4).intervalSeconds = 86399, /Fourth stage project.*daily waits/],
    [c => delete c.stageOrders.find(stage => stage.homeLevel === 4).completionRewards.moon_crystal, /Fourth stage must guarantee both/],
  ]) {
    const invalid = readEconomyCatalog(); mutate(invalid);
    assert.throws(() => auditEconomyProgression(invalid), pattern);
  }
});

test("the fourth stage needs restored landmarks and a successfully claimed ruins route", () => {
  for (const [mutate, pattern] of [
    [c => delete c.stageOrders.find(stage => stage.homeLevel === 4).orders[4].requiredBuildings.bridge, /deliveries from five onward require the bridge/],
    [c => delete c.stageOrders.find(stage => stage.homeLevel === 4).orders.at(-1).requiredBuildings.lighthouse, /final delivery requires the lighthouse/],
    [c => delete c.stageOrders.find(stage => stage.homeLevel === 4).orders.at(-1).requiredExplorations, /final delivery requires a claimed ruins/],
    [c => c.stageOrders.find(stage => stage.homeLevel === 4).orders.at(-1).requiredExplorations.ancient_ruins = 0, /unknown or invalid claimed exploration/],
    [c => delete c.buildings.find(building => building.id === "home").levels.at(-1).requiredBuildings.bridge, /Final home must require restored bridge/],
    [c => c.explorations.find(route => route.id === "ancient_ruins").requiredHomeLevel = 5, /claimed exploration opens after its project/],
  ]) {
    const invalid = readEconomyCatalog(); mutate(invalid);
    assert.throws(() => auditEconomyProgression(invalid), pattern);
  }
  const cycle = readEconomyCatalog();
  cycle.buildings.find(building => building.id === "lighthouse").levels[0].requiredHomeLevel = 5;
  assert.throws(() => auditEconomyProgression(cycle), /Construction dependency cycle/);
});

test("new landmarks stop at their actual restored tier and cannot add a fake production benefit", () => {
  const catalog = readEconomyCatalog();
  for (const id of ["bridge", "lighthouse"]) {
    assert.deepEqual(catalog.buildings.find(building => building.id === id).levels.map(level => level.level), [1]);
    const invalid = structuredClone(catalog);
    invalid.buildings.find(building => building.id === id).levels.push({ ...invalid.buildings.find(building => building.id === id).levels[0], level: 2 });
    assert.throws(() => auditEconomyProgression(invalid), /current landmark has one restoration tier/);
  }
});

test("the compact fourth stage protects financing, construction fees and manual unit workload", () => {
  for (const [mutate, pattern] of [
    [c => c.stageOrders.find(stage => stage.homeLevel === 4).orders[0].coins += 1, /project financing must total 50000/],
    [c => c.buildings.find(building => building.id === "woodlot").levels[3].cost.coins += 1, /mandatory construction must total 73300/],
    [c => c.buildings.find(building => building.id === "quarry").levels[3].seconds -= 1, /mandatory construction must total 96 hours/],
    [c => c.buildings.find(building => building.id === "home").levels[4].cost.items.beams = 20, /workshop workload must stay within forty/],
    [c => c.buildings.find(building => building.id === "home").levels[4].cost.items.wood = 51, /upgrade inputs exceed available storage/],
    [c => c.stageOrders.find(stage => stage.homeLevel === 4).orders[0].items.moon_crystal = 1, /must not depend on a rare find/],
    [c => c.stageOrders.find(stage => stage.homeLevel === 4).orders[0].items.fish_epic = 1, /must not depend on a rare find or rare fish/],
    [c => c.stageOrders.find(stage => stage.homeLevel === 4).orders[0].items.epic_fish = 1, /must not depend on a rare find or rare fish.*recipe ingredients/],
    [c => c.buildings.find(building => building.id === "home").levels[4].cost.items.moon_crystal = 2, /required relics must be covered by guaranteed project rewards/],
  ]) {
    const invalid = readEconomyCatalog(); mutate(invalid);
    assert.throws(() => auditEconomyProgression(invalid), pattern);
  }
});

test("first-stage slots stay single-unit and recipe dependencies cannot silently cycle", () => {
  const oversized = readEconomyCatalog(); oversized.recipes.find(recipe => recipe.id === "make_planks").maxBatch = 2;
  assert.throws(() => auditEconomyProgression(oversized), /First-stage production must reserve one slot/);
  const invalidUnlock = readEconomyCatalog(); invalidUnlock.recipes.find(recipe => recipe.id === "grow_strawberries").requiredRecipes = { missing_compote: 1 };
  assert.throws(() => auditEconomyProgression(invalidUnlock), /unknown or invalid recipe unlock/);
  const cycle = readEconomyCatalog(); cycle.recipes.find(recipe => recipe.id === "cook_compote").requiredRecipes = { grow_strawberries: 1 };
  assert.throws(() => auditEconomyProgression(cycle), /Recipe unlock cycle/);
});

test("rare source audit rejects ordinary prices NPC stock deterministic recipes and early upgrade gates", () => {
  for (const mutate of [
    c => c.items.find(item => item.id === "living_resin").baseSellPrice = 1,
    c => c.items.find(item => item.id === "living_resin").tradable = true,
    c => c.fishing.baits.push({ itemId: "living_resin", price: 20, rareBonus: 0 }),
    c => c.recipes[0].rewards.living_resin = 1,
    c => c.buildings.find(building => building.id === "home").levels[1].cost.items.living_resin = 1,
    c => c.explorations[0].seconds = c.rareDrops.minSeconds,
  ]) {
    const catalog = readEconomyCatalog(); mutate(catalog);
    assert.throws(() => auditEconomyProgression(catalog), /Special|Early homes|One trip/);
  }
});


test("mining is one actor activity with an upgrade benefit at every mine level", () => {
  const catalog = readEconomyCatalog();
  assert.equal(catalog.recipes.filter(recipe => recipe.buildingId === "quarry").length, 0);
  assert.equal(catalog.explorations.find(route => route.id === "quarry_stone").activity, "mining");
  const removed = structuredClone(catalog);
  removed.explorations = removed.explorations.filter(route => route.requiredBuildings?.quarry !== 5);
  assert.throws(() => auditEconomyProgression(removed), /quarry:5: upgrade has no mining route benefit/);
  const revived = structuredClone(catalog);
  revived.recipes.push({ ...revived.explorations.find(route => route.id === "quarry_stone"), buildingId: "quarry", buildingLevel: 1 });
  assert.throws(() => auditEconomyProgression(revived), /duplicate character mining/);
});

test("every mining route requires a built quarry including early cave exploration", () => {
  const catalog = readEconomyCatalog();
  for (const route of catalog.explorations.filter(route => route.activity === "mining")) {
    assert.ok(route.requiredBuildings?.quarry >= 1, route.id);
    const invalid = structuredClone(catalog);
    delete invalid.explorations.find(candidate => candidate.id === route.id).requiredBuildings.quarry;
    assert.throws(() => auditEconomyProgression(invalid), /mining requires a built quarry/, route.id);
  }
  for (const id of ["cave", "deep_cave"]) {
    assert.equal(catalog.explorations.find(route => route.id === id).requiredBuildings.quarry, 1);
  }
});
