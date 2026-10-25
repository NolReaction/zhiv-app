import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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
  assert.equal(report.projects.find(stage => stage.homeLevel === 3).minimumWaitSeconds, 7 * 23 * 3600);
  assert.equal(report.projects.find(stage => stage.homeLevel === 4).minimumWaitSeconds, 11 * 23 * 3600);
  assert.equal(report.fourthStage.constructionCoins, 34800);
  assert.equal(report.fourthStage.constructionSeconds, 58 * 3600);
  assert.equal(report.fourthStage.longWorkshopJobs, 3);
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
  assert.throws(() => auditEconomyProgression(catalog), /Third stage home construction.*eight-hour|Fourth stage.*one-day|construction price must follow builder time/);
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

test("early storage gates match its materials and optional relic tiers have no extra building requirements", () => {
  const catalog = readEconomyCatalog();
  for (const level of catalog.buildings.find(building => building.id === "warehouse").levels) {
    assert.equal(level.requiredHomeLevel, level.level === 2 ? 2 : level.level === 3 ? 3 : 1);
    assert.deepEqual(level.requiredBuildings, {});
    for (const requirement of ["home", "workshop"]) {
      const invalid = structuredClone(catalog), target = invalid.buildings.find(building => building.id === "warehouse").levels.find(candidate => candidate.level === level.level);
      if (requirement === "home") target.requiredHomeLevel = level.requiredHomeLevel + 1;
      else target.requiredBuildings.workshop = 1;
      assert.throws(() => auditEconomyProgression(invalid), /storage must keep its declared material-availability house gate/, `storage ${level.level}: ${requirement}`);
    }
  }
});

test("optional warehouse tiers cannot gate the final home or replace the authored home construction", () => {
  const catalog = readEconomyCatalog();
  catalog.buildings.find(building => building.id === "home").levels[4].requiredBuildings.warehouse = 6;
  assert.throws(() => auditEconomyProgression(catalog), /Storage expansion must not gate ordinary buildings or homes/);
  const compressed = readEconomyCatalog();
  for (const building of compressed.buildings) for (const level of building.levels) if (level.level <= 5) level.seconds = Math.floor(level.seconds / 10);
  assert.throws(() => auditEconomyProgression(compressed), /Third stage home construction.*eight-hour|Fourth stage.*one-day|construction price must follow builder time/);
});


test("fishing shop cannot introduce buy-sell arbitrage or meaningless tackle specializations", () => {
  const catalog = readEconomyCatalog();
  catalog.fishing.fish.find(fish => fish.itemId === "fish_mooncarp").buyPrice = 1;
  assert.throws(() => auditEconomyProgression(catalog), /arbitrage/);
  const invalid = readEconomyCatalog();
  invalid.fishing.rods[0].classOddsBps.common = 0;
  assert.throws(() => auditEconomyProgression(invalid), /class probabilities/);
});

test("mixed travelling tackle keeps specialist limits and needs a real merchant source", () => {
  const explicitPlesk = readEconomyCatalog();
  for (const kind of ["rods", "hooks", "baits"]) for (const entry of explicitPlesk.fishing[kind]) {
    if (entry.shop !== "leaftail") entry.shop = "plesk";
  }
  assert.doesNotThrow(() => auditEconomyProgression(explicitPlesk), "an explicit Pleska source has the same old specialist contract");
  const shares = (common, uncommon, rare, epic, legendary) => ({ common, uncommon, rare, epic, legendary });
  for (const [mutate, expected] of [
    [c => { c.fishing.rods.find(rod => rod.id === "willow_rod").classOddsBps = shares(1000, 4000, 4000, 1000, 0); }, /strongly target its named class/],
    [c => { c.fishing.rods.find(rod => rod.id === "traveller_rod").classOddsBps = shares(1000, 2000, 6000, 1000, 0); }, /two useful directions/],
    [c => { c.fishing.rods.find(rod => rod.id === "dusk_rod").classOddsBps = shares(2000, 2000, 2000, 2000, 2000); }, /two useful directions/],
    [c => { c.fishing.hooks.find(hook => hook.id === "braided_hook").rarityWeights.uncommon = 150; }, /two weaker-than-specialist/],
    [c => { c.fishing.baits.find(bait => bait.itemId === "spice_bait").rarityWeights.uncommon = 100; }, /two weaker-than-specialist/],
    [c => { c.fishing.baits.find(bait => bait.itemId === "dusk_bait").rarityWeights.common = 90; }, /two weaker-than-specialist/],
    [c => { c.fishing.rods.find(rod => rod.id === "dusk_rod").shop = "unknown"; }, /Unknown fishing gear merchant/],
    [c => { c.leaftailShop.travelOffers = c.leaftailShop.travelOffers.filter(offer => offer.itemId !== "spice_bait"); }, /actual matching merchant offer/],
    [c => { c.leaftailShop.travelOffers.find(offer => offer.itemId === "dusk_rod").priceCoins--; }, /preserve its catalog price/],
  ]) {
    const catalog = readEconomyCatalog(); mutate(catalog);
    assert.throws(() => auditEconomyProgression(catalog), expected);
  }
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

test("unit production, short mining and ingredient value cannot silently regress", () => {
  for (const [id, mutate, pattern] of [
    ["grow_berries", r => r.maxBatch = 10, /cannot be bulk queued|First-stage production must reserve one slot/],
    ["grow_blueberries", r => r.rewards.blueberries = 2, /Every current production recipe must reserve one slot for one item/],
    ["quarry_stone", r => r.rewards.stone = 2, /a new job must yield exactly one item/],
    ["make_planks", r => r.cost.items.wood = 100, /crafting destroys NPC value|crafting destroys actual sale proceeds/],
  ]) {
    const catalog = readEconomyCatalog(); mutate([...catalog.recipes, ...catalog.explorations].find(r => r.id === id));
    assert.throws(() => auditEconomyProgression(catalog), pattern, id);
  }
});

test("the authored v13 catalog keeps every current production unit-sized and every storage gate optional", () => {
  const catalog = readEconomyCatalog();
  assert.equal(catalog.version, 13); assert.equal(catalog.recipes.filter(recipe => !recipe.retired).length, 55);
  for (const recipe of catalog.recipes.filter(recipe => !recipe.retired)) {
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

test("each home opens a distinct berry chain with a meal choice and recurring orders", () => {
  const catalog = readEconomyCatalog(), report = auditEconomyProgression(catalog);
  assert.deepEqual(report.berryProgression.map(row => [row.homeLevel, row.cropId, row.productId]), [
    [1, "strawberries", "strawberry_compote"], [2, "blueberries", "blueberry_compote"],
    [3, "currants", "currant_jelly"], [4, "blackberries", "blackberry_preserve"], [5, "cranberries", "cranberry_glaze"],
  ]);
  assert(report.berryProgression.every(row => row.processingMarginCoins > 0 && row.harvestSeconds === 8));
  for (const [mutate, pattern] of [
    [c => delete c.recipes.find(recipe => recipe.id === "grow_blackberries").collection, /new berry must use one garden slot/],
    [c => c.recipes.find(recipe => recipe.id === "cook_currant_jelly").requiredBuildings.garden = 1, /new reachable recipe and corresponding garden gate/],
    [c => c.food.meals = c.food.meals.filter(meal => meal.itemId !== "cranberry_glaze"), /berry product needs a food benefit/],
    [c => c.food.orders.templates = c.food.orders.templates.filter(order => !order.items.blueberries), /repeatable earning opportunities/],
  ]) {
    const invalid = structuredClone(catalog); mutate(invalid);
    assert.throws(() => auditEconomyProgression(invalid), pattern);
  }
});

test("the restored bridge gates the market while the lighthouse and its materials are reachable at home three", () => {
  const catalog = readEconomyCatalog();
  for (const [mutate, pattern] of [
    [c => c.market.requiredExplorations = 1, /not an arbitrary trip count/],
    [c => c.market.requiredBuildings = {}, /Market access must require the restored bridge/],
    [c => c.buildings.find(building => building.id === "bridge").levels[0].requiredHomeLevel = 3, /bridge must be attainable at home two/],
    [c => c.buildings.find(building => building.id === "lighthouse").levels[0].requiredHomeLevel = 4, /lighthouse must be attainable at home three/],
  ]) {
    const invalid = structuredClone(catalog); mutate(invalid);
    assert.throws(() => auditEconomyProgression(invalid), pattern);
  }
  const milestones = catalog.buildings.filter(building => ["bridge", "lighthouse"].includes(building.id));
  assert(milestones.every(building => Object.values(building.levels[0].cost.items).reduce((a, b) => a + b, 0) <= 50));
});

test("pearl rewards provide regular free progress while permanent slots retain distinct prices", () => {
  const catalog = readEconomyCatalog();
  const rewards = JSON.parse(readFileSync(new URL("../apps/api/src/main/resources/world/progression-rewards-catalog.json", import.meta.url), "utf8"));
  assert.equal(rewards.version, 5);
  for (const cycle of [rewards.daily, ...Object.values(rewards.dailyByHomeLevel)]) {
    assert.deepEqual(cycle.map(reward => reward.pearls / 2), [40, 50, 60, 70, 80, 90, 110]);
    assert.equal(cycle.reduce((sum, reward) => sum + reward.pearls / 2, 0), 500);
  }
  assert.equal(Object.values(rewards.achievementPearls).flat().reduce((sum, amount) => sum + amount / 2, 0), 2060);
  assert.deepEqual(catalog.productionSlots.upgrades.map(upgrade => upgrade.pricePearls / 2), [100, 250]);
  assert.equal(catalog.market.baseSlots, 5);
  assert.deepEqual(catalog.market.slotPricesPearls.map(price => price / 2), [50, 80, 120, 180, 250]);
  const prices = auditEconomyProgression(catalog).pearlPricing;
  assert.deepEqual(prices.map(point => [point.seconds, point.visiblePearls]), [[300, 1], [600, 2]]);
  const invalid = structuredClone(catalog); invalid.constructionSpeedup.pricingPoints[1].pearls *= 25;
  assert.throws(() => auditEconomyProgression(invalid), /declared time tariff in stored pearl units/);
});

test("project pacing cannot lose its daily fences or guaranteed home relics", () => {
  for (const [mutate, pattern] of [
    [c => c.stageOrders.find(stage => stage.homeLevel === 3).orders.pop(), /Third stage project.*eight deliveries/],
    [c => c.stageOrders.find(stage => stage.homeLevel === 3).intervalSeconds = 23 * 3600 - 1, /Third stage project.*23-hour waits/],
    [c => c.stageOrders.find(stage => stage.homeLevel === 3).completionRewards = {}, /Third stage must guarantee/],
    [c => c.stageOrders.find(stage => stage.homeLevel === 4).orders.pop(), /Fourth stage project.*twelve deliveries/],
    [c => c.stageOrders.find(stage => stage.homeLevel === 4).intervalSeconds = 23 * 3600 - 1, /Fourth stage project.*23-hour waits/],
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
  assert.throws(() => auditEconomyProgression(cycle), /lighthouse must be attainable at home three/);
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
    [c => c.stageOrders.find(stage => stage.homeLevel === 4).orders[0].coins += 1, /project must pay item value plus 25 percent/],
    [c => c.buildings.find(building => building.id === "woodlot").levels[3].cost.coins += 1, /construction price must follow builder time/],
    [c => c.buildings.find(building => building.id === "quarry").levels[3].seconds -= 60, /construction price must follow builder time/],
    [c => { c.buildings.find(building => building.id === "home").levels[4].cost.items.reinforced_parts = 35; const order = c.stageOrders.find(stage => stage.homeLevel === 4).orders.at(-1); order.items.reinforced_parts = 6; order.coins = Math.ceil(createLiquidation(c)(order.items) * 1.25); }, /workshop workload must stay within forty/],
    [c => c.buildings.find(building => building.id === "home").levels[4].cost.items.wood = 51, /upgrade inputs exceed available storage/],
    [c => c.stageOrders.find(stage => stage.homeLevel === 4).orders[0].items.moon_crystal = 1, /must not depend on a rare find/],
    [c => { const order = c.stageOrders.find(stage => stage.homeLevel === 4).orders[0]; order.items.fish_epic = 1; order.coins = Math.ceil(createLiquidation(c)(order.items) * 1.25); }, /must not depend on a rare find or rare fish/],
    [c => { const order = c.stageOrders.find(stage => stage.homeLevel === 4).orders[0]; order.items.epic_fish = 1; order.coins = Math.ceil(createLiquidation(c)(order.items) * 1.25); }, /must not depend on a rare find or rare fish.*recipe ingredients/],
    [c => c.buildings.find(building => building.id === "home").levels[4].cost.items.moon_crystal = 2, /required relics must be covered by guaranteed project rewards/],
  ]) {
    const invalid = readEconomyCatalog(); mutate(invalid);
    assert.throws(() => auditEconomyProgression(invalid), pattern);
  }
});

test("arcade production improvements do not make earlier tiers slower than later ones", () => {
  const catalog = readEconomyCatalog();
  for (const id of ["garden", "woodlot", "quarry", "workshop", "dryer", "kiln"]) {
    const levels = catalog.buildings.find(building => building.id === id).levels;
    assert(levels.every((level, index) => !index || level.seconds >= levels[index - 1].seconds), id);
  }
  const oldWorkshopWait = structuredClone(catalog);
  oldWorkshopWait.buildings.find(building => building.id === "workshop").levels[2].seconds = 36 * 3600;
  assert.throws(() => auditEconomyProgression(oldWorkshopWait), /workshop: later production upgrades must not take less construction time/);
  const oldFurnaceWait = structuredClone(catalog);
  oldFurnaceWait.buildings.find(building => building.id === "kiln").levels[1].seconds = 8 * 3600;
  assert.throws(() => auditEconomyProgression(oldFurnaceWait), /kiln: later production upgrades must not take less construction time/);
});

test("third-stage mandatory building bundles stay compact without removing their week-long project", () => {
  const catalog = readEconomyCatalog(), report = auditEconomyProgression(catalog);
  assert.deepEqual(report.thirdStage, { constructionCount: 7, constructionCoins: 11400,
    constructionSeconds: 19 * 3600, largestMaterialBundle: 12 });
  assert.equal(report.projects.find(stage => stage.homeLevel === 3).minimumWaitSeconds, 161 * 3600);
  const home = catalog.buildings.find(building => building.id === "home").levels.find(level => level.level === 4);
  assert.equal(home.seconds, 8 * 3600);
  for (const mutate of [
    c => c.buildings.find(building => building.id === "workshop").levels[2].cost.items.planks = 20,
    c => c.buildings.find(building => building.id === "home").levels[3].cost.items.beams = 10,
  ]) {
    const invalid = structuredClone(catalog); mutate(invalid);
    assert.throws(() => auditEconomyProgression(invalid), /Third stage mandatory building materials must fit a compact fourteen-item bundle/);
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
  for (const route of catalog.explorations.filter(route => route.activity === "mining" && !route.retired)) {
    assert.ok(route.requiredBuildings?.quarry >= 1, route.id);
    const invalid = structuredClone(catalog);
    delete invalid.explorations.find(candidate => candidate.id === route.id).requiredBuildings.quarry;
    assert.throws(() => auditEconomyProgression(invalid), /mining requires a built quarry/, route.id);
  }
  for (const id of ["cave", "deep_cave"]) {
    assert.equal(catalog.explorations.find(route => route.id === id).requiredBuildings.quarry, 1);
  }
});


test("advertised building unlocks cannot silently depend on future-home ingredients", () => {
  const catalog = readEconomyCatalog();
  catalog.buildings.find(building => building.id === "lighthouse").levels[0].cost.items.lens = 1;
  assert.throws(() => auditEconomyProgression(catalog), /lighthouse:1: materials or prerequisites unavailable at advertised home 3: lens/);
});
