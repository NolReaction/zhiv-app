import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";
import { recipeBuildingLevel } from "./helpers/recipe-level.mjs";

const readJson = path => JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8"));
const catalog = readJson("../apps/api/src/main/resources/world/economy-catalog.json");
for (const recipe of catalog.recipes) recipe.requiredRecipes ??= {};
const rewards = readJson("../apps/api/src/main/resources/world/progression-rewards-catalog.json");
const storefrontCatalog = readJson("../apps/api/src/main/resources/world/storefront-catalog.json");
const plain = value => JSON.parse(JSON.stringify(value));
function load(path, dependencies = {}) {
  const context = { exports: {}, structuredClone, require: id => {
    assert.ok(id in dependencies, `Unexpected import ${id}`);
    return dependencies[id];
  } };
  const source = readFileSync(new URL(path, import.meta.url), "utf8");
  vm.runInNewContext(ts.transpileModule(source, { compilerOptions: {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS,
  } }).outputText, context);
  return context.exports;
}
const money = load("../features/economy/domain/money.ts");
const timePrice = load("../features/economy/domain/time-price.ts");
const sale = load("../features/economy/domain/local-sale.ts", { "./model": money });
const currencyShop = load("../features/economy/domain/currency-shop.ts", {
  "./money": money, "./time-price": timePrice, "./storefront": { storefrontCatalog },
});
const gameRewards = load("../features/game/game-rewards.ts");
const sources = load("../features/progression/economy-sources.ts", { "@/features/economy/domain/model": { economyCatalog: catalog, recipeBuildingLevel } });
const model = load("../features/progression/economy-data.ts", {
  "./economy-sources": sources,
  "@/features/economy/domain/model": { economyCatalog: catalog, recipeBuildingLevel },
  "@/features/economy/domain/money": money,
  "@/features/economy/domain/currency-shop": currencyShop,
  "@/features/economy/domain/storefront": { storefrontCatalog },
  "@/features/game/game-rewards": gameRewards,
  "@/features/economy/domain/rules": { constructionTimePearlPrice: (seconds, config) => timePrice.durationPearlPrice(seconds * 1000,
    config.secondsPerPearl, money.ECONOMY_PEARL_SCALE, config.priceStepPearls, config.pricingPoints) },
  "@/features/economy/domain/local-sale": sale,
  "@/apps/api/src/main/resources/world/progression-rewards-catalog.json": { default: rewards },
});
const { progressionEconomy: economy, calculateRecipePlan, buildProgressionEconomy } = model;
const activeRecipes = catalog.recipes.filter(recipe => !recipe.retired);
const activeRoutes = catalog.explorations.filter(route => !route.retired);
const recipe = id => economy.recipes.find(value => value.id === id);
const item = id => economy.items.find(value => value.id === id);
const queue = (plan, id) => plan.queues.find(value => value.buildingId === id);

test("recipe references show the functional level-zero fire while leaving its wire catalog compatible", () => {
  const wire = catalog.recipes.find(value => value.id === "cook_grilled_fish");
  assert.equal(wire.buildingLevel, 1);
  assert.equal(wire.baseCampfire, true);
  assert.equal(recipe("cook_grilled_fish").buildingLevel, 0);
  const fish = item("grilled_fish").sources.find(value => value.recipeId === "cook_grilled_fish");
  assert.equal(fish.requiredBuildings.dryer, 0);
  assert.match(fish.detail, /уровень 0/);
  assert.equal(recipe("cook_compote").buildingLevel, 1);
});

test("economy reference covers every actual item and recipe, with sources and reverse uses", () => {
  assert.equal(economy.items.length, catalog.items.length);
  assert.equal(economy.recipes.length, activeRecipes.length);
  assert.equal(new Set(economy.items.map(value => value.id)).size, catalog.items.length);
  for (const value of economy.items) assert.ok(value.sources.length, `No source for ${value.id}`);
  for (const value of activeRecipes) {
    assert.deepEqual(plain(recipe(value.id).cost), value.cost);
    assert.deepEqual(plain(recipe(value.id).rewards), value.rewards);
    assert.equal(Object.values(value.rewards).reduce((sum, count) => sum + count, 0), 1);
    for (const id of Object.keys(value.cost.items)) assert.ok(item(id).uses.some(use => use.id === `recipe:${value.id}`));
  }
  assert.ok(item("living_resin").uses.some(use => use.id === "building:home:4"));
  assert.ok(item("living_resin").sources.some(source => source.kind === "project" && source.guaranteed && source.quantity === 1));
  assert.ok(item("ancient_core").sources.some(source => source.kind === "daily"));
  assert.ok(item("worm_bait").sources.some(source => source.kind === "shop" && !source.guaranteed));
});

test("fish species remain collection records, and no fishing route promises common fish", () => {
  for (const fish of catalog.fishing.fish) {
    const value = item(fish.itemId);
    assert.equal(value.kind, "fish-species");
    assert.equal(value.inventoryItemId, catalog.fishing.classes.find(group => group.rarity === fish.rarity).itemId);
    assert.ok(value.sources.some(source => source.kind === "fishing" && !source.guaranteed));
  }
  for (const group of catalog.fishing.classes) {
    assert.ok(item(group.itemId).sources.some(source => source.kind === "fishing" && !source.guaranteed));
    assert.ok(!item(group.itemId).sources.some(source => source.kind === "exploration" && source.guaranteed));
  }
  assert.ok(!item("fish").sources.some(source => source.kind === "exploration" && source.guaranteed));
  assert.equal(item("fish").inventoryItemId, "fish_common");
  assert.ok(item("fish").uses.some(use => use.id === "recipe:cook_grilled_fish"));
  assert.ok(item("fish_mooncarp").uses.some(use => use.id === "recipe:cook_hearty_fish"));
  assert.equal(item("ancient_core").npcSellPrice, null);
  assert.ok(item("moon_crystal").sources.some(source => source.kind === "rare" && !source.guaranteed));
  assert.ok(item("moon_crystal").sources.some(source => source.kind === "project" && source.guaranteed && source.homeLevel === 4 && source.quantity === 1));
});

test("source costs and prerequisites are complete catalog copies, including the recipe's own station", () => {
  const before = JSON.stringify(catalog);
  const reference = buildProgressionEconomy(catalog);
  for (const recipe of activeRecipes) {
    const source = reference.items.find(item => item.id === Object.keys(recipe.rewards)[0]).sources.find(source => source.recipeId === recipe.id);
    assert.deepEqual(plain(source.cost), recipe.cost);
    assert.deepEqual(plain(source.requiredBuildings), { ...recipe.requiredBuildings,
      [recipe.buildingId]: Math.max(recipeBuildingLevel(recipe), recipe.requiredBuildings[recipe.buildingId] ?? 0) });
    assert.deepEqual(plain(source.requiredRecipes), recipe.requiredRecipes);
    source.cost.coins += 1;
    source.requiredBuildings[recipe.buildingId] += 1;
  }
  for (const route of activeRoutes.filter(route => !catalog.fishing.routeIds.includes(route.id))) {
    const source = reference.items.find(item => item.id === Object.keys(route.rewards)[0]).sources.find(source => source.routeId === route.id);
    assert.deepEqual(plain(source.cost), route.cost);
    assert.deepEqual(plain(source.requiredBuildings), route.requiredBuildings);
    assert.deepEqual(plain(source.rewards), route.rewards);
    source.cost.items.modified_source = 1;
    source.requiredBuildings.modified_source = 1;
    source.rewards.modified_source = 1;
  }
  assert.equal(JSON.stringify(catalog), before);
  const legendary = item("fish_legendary").sources.find(source => source.kind === "fishing");
  for (const rod of catalog.fishing.rods.filter(rod => rod.rarity === "legendary" && rod.classOddsBps.legendary > 0)) {
    assert.ok(legendary.detail.includes(`${rod.name} (дом ${rod.requiredHomeLevel})`));
  }
});

test("direct processing math uses current NPC prices; timer rate excludes collection and ingredients", () => {
  assert.equal(recipe("make_beams").inputNpcValue, 450);
  assert.equal(recipe("make_beams").outputNpcValue, 650);
  assert.equal(recipe("make_beams").addedNpcValue, 200);
  assert.equal(recipe("weave_cloth").inputNpcValue, 100);
  assert.equal(recipe("weave_cloth").addedNpcValue, 120);
  assert.equal(recipe("cook_fish_soup").inputNpcValue, 90);
  assert.equal(recipe("cook_fish_soup").outputNpcValue, 170);
  assert.equal(recipe("cook_fish_soup").addedNpcValue, 80);
  assert.equal(recipe("cook_fish_soup").unitsPerHour, 7.5);
  assert.equal(recipe("cook_fish_soup").grossNpcPerHour, 1275);
  assert.equal(recipe("grow_berries").unitsPerHour, 60);
  assert.equal(recipe("grow_berries").collectionSeconds, 8);
});

test("two beams recursively require eight hardwood and four fibre with shared workshop queue", () => {
  const plan = calculateRecipePlan("make_beams", 2);
  assert.deepEqual(plain(plan.rawInputs), { hardwood: 8, fiber: 4 });
  assert.equal(queue(plan, "woodlot").seconds, 8 * 600 + 4 * 60);
  assert.equal(queue(plan, "workshop").seconds, 2 * 1200 + 2 * 180);
  assert.ok(plan.steps.some(step => step.recipeId === "gather_hardwood" && step.runs === 8));
  assert.ok(!plan.steps.some(step => step.recipeId === "hardwood_shift"));
  assert.equal(plan.uncertainItemIds.length, 0);
  assert.equal(plan.coins, 0);
  assert.match(plan.warnings.join(" "), /не длительность прохождения/);
});

test("cloth expands its rope ingredient and soup explicitly leaves fish acquisition uncertain", () => {
  const cloth = calculateRecipePlan("weave_cloth");
  assert.deepEqual(plain(cloth.rawInputs), { fiber: 7 });
  assert.equal(queue(cloth, "woodlot").seconds, 420);
  assert.equal(queue(cloth, "workshop").seconds, 720 + 180);
  assert.deepEqual(plain(cloth.steps.map(step => step.recipeId)), ["gather_fiber", "make_rope", "weave_cloth"]);
  const soup = calculateRecipePlan("cook_fish_soup");
  assert.deepEqual(plain(soup.rawInputs), { fish_common: 2, berries: 1, wood: 1 });
  assert.deepEqual(plain(soup.uncertainItemIds), ["fish_common"]);
  assert.equal(queue(soup, "garden").seconds, 60);
  assert.equal(queue(soup, "garden").collectionSeconds, 8);
  assert.equal(queue(soup, "dryer").seconds, 480);
  assert.ok(!soup.queues.some(value => value.buildingId === "fishing"));
});

test("unit mining is counted independently without choosing a multi-output expedition", () => {
  const plan = calculateRecipePlan("smelt_iron");
  assert.deepEqual(plain(plan.rawInputs), { ore: 3, wood: 1 });
  assert.equal(queue(plan, "quarry").seconds, 3 * 600);
  assert.deepEqual(plain(plan.miningSteps), [{ routeId: "quarry_ore", runs: 3 }]);
  assert.equal(queue(plan, "kiln").seconds, 900 + 120);
  assert.equal(queue(plan, "woodlot").seconds, 180);
  assert.equal(plan.uncertainItemIds.length, 0);
  const stone = calculateRecipePlan("cut_stone");
  assert.equal(queue(stone, "quarry").seconds, 3 * 180);
});

test("stage budgets derive only required new buildings and the current short delivery cadence", () => {
  const first = economy.stages.find(stage => stage.homeLevel === 1);
  assert.equal(first.buildingCoins, 400);
  assert.equal(first.orderCoins, 338);
  assert.equal(first.orders.length, 4);
  assert.deepEqual(plain(economy.starter), { coins: 100, pearls: 0, items: { wood: 3, stone: 5 } });
  assert.equal(economy.starter.coins + first.orderCoins - first.buildingCoins, 38);
  assert.deepEqual(plain(economy.storage.map(level => level.capacity)), [50, 100, 150, 200, 250, 300, 350, 400, 450, 500]);
  const second = economy.stages.find(stage => stage.homeLevel === 2);
  assert.equal(second.buildingCoins, 1550);
  assert.equal(second.orderCoins, second.orders.reduce((sum, order) => sum + order.coins, 0));
  assert.equal(second.orders.length, 7);
  const third = economy.stages.find(stage => stage.homeLevel === 3);
  assert.equal(third.buildingCoins, 9000);
  assert.equal(third.orderCoins, third.orders.reduce((sum, order) => sum + order.coins, 0));
  assert.equal(third.orders.length, 8);
  assert.equal(third.intervalSeconds, catalog.stageOrders.find(course => course.homeLevel === 3).intervalSeconds);
  assert(third.intervalSeconds <= 3600);
  assert.equal(third.minimumGateSeconds, (third.orders.length - 1) * third.intervalSeconds);
  assert.equal(third.buildings.find(value => value.id === "home").seconds, catalog.buildings.find(building => building.id === "home").levels.find(level => level.level === 4).seconds);
  assert.deepEqual(plain(third.completionRewards), { living_resin: 1 });
  assert.equal(third.orders[0].inputNpcValue, Object.entries(third.orders[0].items).reduce((sum, [id, quantity]) => sum + item(id).npcSellPrice * quantity, 0));
  assert.equal(third.orders[0].addedNpcValue, third.orders[0].coins - third.orders[0].inputNpcValue);
  assert.ok(economy.stages.every(stage => !stage.buildings.some(value => value.id === "warehouse")));
  assert.equal(economy.stages.find(stage => stage.homeLevel === 4).preliminary, false);
});

test("pearl budgets respect visible denomination and distinguish seven gifts from finite achievements", () => {
  assert.equal(economy.pearls.dailyCycle, rewards.daily.reduce((sum, reward) => sum + reward.pearls, 0) / 2);
  assert.equal(economy.pearls.achievementLifetime, Object.values(rewards.achievementPearls).flat().reduce((sum, pearls) => sum + pearls, 0) / 2);
  assert.deepEqual(plain(economy.pearls.dailyRewards.map(reward => reward.pearls)), rewards.daily.map(reward => reward.pearls / 2));
  assert.equal(economy.pearls.achievementRewards.flatMap(quest => quest.tiers).reduce((sum, tier) => sum + tier.pearls, 0), economy.pearls.achievementLifetime);
  assert.ok(economy.pearls.achievementRewards.every(quest => quest.id !== "full_collection"));
  assert.deepEqual(plain(economy.pearls.achievementRewards.find(quest => quest.id === "explorer").tiers),
    [10, 50, 200].map((target, index) => ({ level: index + 1, target, pearls: rewards.achievementPearls.explorer[index] / 2 })));
  assert.equal(economy.pearls.dailyMinimumHours, 20);
  assert.deepEqual(plain(economy.pearls.marketSlotPrices), [50, 80, 120, 180, 250]);
  assert.equal(economy.pearls.marketTotal, 680);
  assert.deepEqual(plain(economy.pearls.productionSlots), [{ slots: 2, pearls: 100, requiredHomeLevel: 1 }, { slots: 3, pearls: 250, requiredHomeLevel: 3 }]);
  assert.deepEqual(plain(economy.pearls.construction), { stepPearls: 1, curved: false, secondsPerVisiblePearl: 300,
    prices: [{ seconds: 60, pearls: 1 }, { seconds: 3600, pearls: 12 }, { seconds: 21600, pearls: 72 },
      { seconds: 43200, pearls: 144 }, { seconds: 86400, pearls: 288 }, { seconds: 172800, pearls: 576 }, { seconds: 604800, pearls: 2016 }] });
  assert.deepEqual(plain(economy.fishingShop), { refreshSeconds: 21600, maximumRefreshPearls: 50 });
});

test("resident board reference follows the five-resident catalog while older catalogs keep their own capacity", () => {
  assert.equal(economy.orderBoard.templates, catalog.food.orders.templates.length);
  assert.equal(economy.orderBoard.slots, catalog.food.orders.slots);
  assert.equal(economy.orderBoard.slots, new Set(catalog.food.orders.templates.map(order => order.residentId)).size);
  assert.equal(economy.orderBoard.perResident, true);
  assert.equal(economy.orderBoard.replacementPricePearls, 5);
  const legacy = structuredClone(catalog);
  delete legacy.tradeRelations;
  legacy.food.orders.slots = 3;
  const board = buildProgressionEconomy(legacy).orderBoard;
  assert.equal(board.slots, 3);
  assert.equal(board.perResident, false);
  assert.equal(board.templates, legacy.food.orders.templates.length);
});

test("currency shop reference uses visible pearls and home quotes, excluding storage from production bonuses", () => {
  assert.equal(economy.currencyShop.preview, true);
  assert.deepEqual(plain(economy.currencyShop.pearlPackages.map(pack => [pack.pearls, pack.priceRub])), [[100, 99], [350, 299], [800, 599]]);
  assert.deepEqual(plain(economy.currencyShop.goldPrices), [20, 50, 100]);
  assert.deepEqual(plain(economy.currencyShop.goldByHome.map(row => row.offers.map(offer => offer.coins))),
    Array.from({ length: 5 }, () => [1000, 2500, 5000]));
  assert.equal(economy.currencyShop.productionBonusPercent, 0);
  assert.equal(economy.currencyShop.maximumGold, 5000);
});

test("branch references all five stage packs and cosmetic prices without turning preview contents into free item sources", () => {
  assert.deepEqual(plain(economy.currencyShop.starterPacks.map(pack => [pack.homeLevel, pack.priceRub, pack.rewards.pearls, pack.rewards.coins])),
    storefrontCatalog.starterPacks.map(pack => [pack.homeLevel, pack.priceRub, pack.rewards.pearls / 2, pack.rewards.coins]));
  for (const pack of economy.currencyShop.starterPacks) {
    const original = storefrontCatalog.starterPacks.find(value => value.id === pack.id);
    assert.equal(pack.purchaseLimit, 1);
    assert.deepEqual(plain(pack.rewards.items), original.rewards.items);
    for (const id of Object.keys(pack.rewards.items)) {
      assert.ok(item(id), id);
      assert.ok(!item(id).sources.some(source => source.id === pack.id), "unavailable premium preview is not an acquisition route");
    }
  }
  assert.deepEqual(plain(economy.currencyShop.costumeOffers.map(offer => [offer.outfitId, offer.priceRub])),
    [["premium_explorer", 199], ["premium_stargazer", 299], ["premium_ember", 299]]);
  const copied = buildProgressionEconomy();
  copied.currencyShop.starterPacks[0].rewards.items.wood = 999;
  copied.currencyShop.costumeOffers[0].priceRub = 1;
  assert.notEqual(storefrontCatalog.starterPacks[0].rewards.items.wood, 999);
  assert.equal(storefrontCatalog.costumeOffers[0].priceRub, 199);
});

test("house four has a separate twelve-delivery course, restored landmarks and guaranteed home-five relics", () => {
  const fourth = economy.stages.find(stage => stage.homeLevel === 4);
  assert.equal(fourth.buildingCoins, 19200);
  assert.equal(fourth.buildSeconds, fourth.buildings.reduce((sum, building) => sum + building.seconds, 0), "one builder's queue excludes delivery waits and resource preparation");
  assert.equal(fourth.orders.length, 12);
  assert.equal(fourth.orderCoins, fourth.orders.reduce((sum, order) => sum + order.coins, 0));
  assert.equal(fourth.intervalSeconds, catalog.stageOrders.find(course => course.homeLevel === 4).intervalSeconds);
  assert(fourth.intervalSeconds <= 3600);
  assert.equal(fourth.minimumGateSeconds, (fourth.orders.length - 1) * fourth.intervalSeconds);
  assert.deepEqual(plain(fourth.completionRewards), { ancient_core: 1, moon_crystal: 1 });
  assert.equal(fourth.preliminary, false, "the command route is verified; its runtime is not a guarantee for every visit pattern");
  for (const id of ["bridge", "lighthouse"]) assert.ok(fourth.buildings.some(building => building.id === id && building.level === 1));
  assert.equal(fourth.buildings.find(building => building.id === "home").seconds, catalog.buildings.find(building => building.id === "home").levels.find(level => level.level === 5).seconds);
  const final = fourth.orders.find(order => order.id === "stage4_completion_order");
  assert.deepEqual(plain(final.requiredBuildings), { bridge: 1, lighthouse: 1 });
  assert.deepEqual(plain(final.requiredExplorations), { ancient_ruins: 1 });
  const before = JSON.stringify(catalog), copied = buildProgressionEconomy(catalog);
  const copiedFinal = copied.stages.find(stage => stage.homeLevel === 4).orders.find(order => order.id === final.id);
  copiedFinal.requiredBuildings.bridge = 10;
  copiedFinal.requiredExplorations.ancient_ruins = 10;
  copiedFinal.items.cloth = 10;
  assert.equal(JSON.stringify(catalog), before, "view mutation cannot rewrite catalog gates or paid ingredients");
});

test("rations and research equipment add NPC value and expand the actual dependency chains", () => {
  const ration = recipe("prepare_trail_ration"), gear = recipe("make_research_gear");
  assert.deepEqual(plain(ration.cost.items), { smoked_fish: 1, dried_berries: 1, berry_compote: 1 });
  assert.deepEqual(plain(gear.cost.items), { tools: 1, cloth: 1, rope: 2 });
  for (const [entry, input, output, added] of [[ration, 440, 640, 200], [gear, 1350, 1750, 400]]) {
    assert.equal(entry.inputNpcValue, input);
    assert.equal(entry.outputNpcValue, output);
    assert.equal(entry.addedNpcValue, added);
    assert.equal(entry.maxBatch, 1);
    assert.equal(Object.values(entry.rewards).reduce((sum, count) => sum + count, 0), 1);
  }
  const rationPlan = calculateRecipePlan(ration.id);
  assert.deepEqual(plain(rationPlan.rawInputs), { wood: 1, fish_common: 2, berries: 8 });
  assert.deepEqual(plain(rationPlan.uncertainItemIds), ["fish_common"]);
  assert.equal(queue(rationPlan, "dryer").seconds, 3000);
  assert.equal(queue(rationPlan, "garden").collectionSeconds, 64);
  const gearPlan = calculateRecipePlan(gear.id);
  assert.deepEqual(plain(gearPlan.rawInputs), { ore: 3, wood: 4, fiber: 13 });
  assert.equal(gearPlan.uncertainItemIds.length, 0);
  assert.equal(queue(gearPlan, "workshop").seconds, 6180);
  assert.equal(queue(gearPlan, "quarry").seconds, 1800);
  assert.equal(queue(gearPlan, "kiln").seconds, 1020);
  for (const [itemId, routeId] of [["trail_ration", "far_bank_path"], ["field_kit", "ancient_ruins"]]) {
    assert.ok(item(itemId).uses.some(use => use.id === `route:${routeId}`));
    assert.ok(item(itemId).sources.some(source => source.kind === "recipe" && source.guaranteed));
  }
});

test("each house adds a real berry and useful processing chain, with catalog meal characteristics", () => {
  const expected = [[1, ["berries", "strawberries"], "strawberry_compote"], [2, ["blueberries"], "blueberry_compote"],
    [3, ["currants"], "currant_jelly"], [4, ["blackberries"], "blackberry_preserve"], [5, ["cranberries"], "cranberry_glaze"]];
  assert.deepEqual(plain(economy.homeUnlocks.map(unlock => unlock.homeLevel)), [1, 2, 3, 4, 5]);
  for (const [home, berries, product] of expected) {
    const unlock = economy.homeUnlocks.find(unlock => unlock.homeLevel === home);
    assert.deepEqual(plain(unlock.berries.map(berry => berry.itemId)), berries);
    assert.ok(unlock.newItems.includes(product), product);
    assert.ok(unlock.recipes.some(id => recipe(id).rewards[product] === 1));
    const processing = economy.recipes.find(recipe => recipe.rewards[product] === 1);
    assert.equal(processing.unlockHomeLevel, home);
    assert.ok(processing.addedNpcValue > 0, `Processing ${product} must add value`);
    const meal = catalog.food.meals.find(meal => meal.itemId === product);
    assert.deepEqual(plain(item(product).meal), { heroSpeedBps: meal.heroSpeedBps, builderSpeedBps: meal.builderSpeedBps, heroWorkSeconds: meal.heroWorkSeconds });
  }
  assert.deepEqual(plain(economy.market), { homeLevel: 2, requiredBuildings: { bridge: 1 }, requiredExplorations: 0 });
  assert.deepEqual(plain(economy.homeUnlocks.filter(unlock => unlock.landmarks.length).map(unlock => [unlock.homeLevel, unlock.landmarks[0].id])), [[2, "bridge"], [3, "lighthouse"]]);
  assert.equal(economy.stages.find(stage => stage.homeLevel === 2).buildings.some(building => building.id === "bridge"), false);
  assert.equal(economy.stages.find(stage => stage.homeLevel === 3).buildings.some(building => building.id === "lighthouse"), false);
});

test("unlock overview follows changed station gates and owns its copies while early landmarks remain a later worst-case cost", () => {
  const changed = structuredClone(catalog), before = JSON.stringify(catalog);
  changed.buildings.find(building => building.id === "garden").levels.find(level => level.level === 2).requiredHomeLevel = 3;
  const custom = buildProgressionEconomy(changed);
  assert.ok(!custom.homeUnlocks.find(unlock => unlock.homeLevel === 2).berries.some(berry => berry.itemId === "blueberries"));
  assert.ok(custom.homeUnlocks.find(unlock => unlock.homeLevel === 3).berries.some(berry => berry.itemId === "blueberries"));
  assert.equal(custom.recipes.find(recipe => recipe.rewards.blueberries).unlockHomeLevel, 3);
  const fourth = economy.stages.find(stage => stage.homeLevel === 4);
  const landmarks = fourth.buildings.filter(building => ["bridge", "lighthouse"].includes(building.id));
  assert.deepEqual(plain(landmarks.map(building => [building.id, building.availableHomeLevel])), [["bridge", 2], ["lighthouse", 3]]);
  assert.equal(fourth.buildingCoins - landmarks.reduce((sum, building) => sum + building.cost.coins, 0), 16200);
  assert.equal(fourth.buildSeconds - landmarks.reduce((sum, building) => sum + building.seconds, 0), fourth.buildings.filter(building => !["bridge", "lighthouse"].includes(building.id)).reduce((sum, building) => sum + building.seconds, 0));
  custom.homeUnlocks.find(unlock => unlock.homeLevel === 2).landmarks[0].cost.items.rope = 100;
  custom.items.find(item => item.id === "currant_jelly").meal.heroSpeedBps = 9999;
  custom.market.requiredBuildings.bridge = 100;
  assert.equal(JSON.stringify(catalog), before);
});

test("builders and calculations do not mutate the source catalog, and reject invalid requests", () => {
  const before = JSON.stringify(catalog);
  buildProgressionEconomy(catalog);
  for (const value of activeRecipes) calculateRecipePlan(value.id, 3, catalog);
  assert.equal(JSON.stringify(catalog), before);
  for (const quantity of [0, 1000, 1.5, NaN, Infinity]) assert.throws(() => calculateRecipePlan("make_beams", quantity), /Quantity/);
  assert.throws(() => calculateRecipePlan("nonexistent"), /Unknown recipe/);
});

test("changing a catalog price or timer flows into recipe values, stage rewards and acquisition queues", () => {
  const changed = structuredClone(catalog);
  changed.localBuyer.unitPrices.wood = 100;
  changed.recipes.find(value => value.id === "gather_wood").seconds = 321;
  const updated = buildProgressionEconomy(changed);
  assert.equal(updated.recipes.find(value => value.id === "make_planks").inputNpcValue, 100);
  assert.equal(updated.recipes.find(value => value.id === "make_planks").addedNpcValue, -50);
  const timberOrder = updated.stages[0].orders.find(value => value.id === "stage1_wood_order");
  assert.equal(timberOrder.inputNpcValue, 200);
  assert.equal(timberOrder.addedNpcValue, -125);
  assert.equal(queue(calculateRecipePlan("make_planks", 2, changed), "woodlot").seconds, 642);
  assert.equal(recipe("make_planks").inputNpcValue, 30);
});

test("cycles and unknown ingredients stop safely rather than recursively inventing resources", () => {
  const changed = structuredClone(catalog);
  changed.recipes.find(value => value.id === "make_rope").cost.items = { beams: 1, missing_item: 2 };
  const plan = calculateRecipePlan("make_beams", 1, changed);
  assert.equal(plan.rawInputs.beams, 1);
  assert.equal(plan.rawInputs.missing_item, 2);
  assert.ok(plan.uncertainItemIds.includes("beams"));
  assert.ok(plan.uncertainItemIds.includes("missing_item"));
  assert.match(plan.warnings.join(" "), /Цикл рецептов/);
  assert.match(plan.warnings.join(" "), /Неизвестный ингредиент/);
});
