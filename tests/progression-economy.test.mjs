import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

const readJson = path => JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8"));
const catalog = readJson("../apps/api/src/main/resources/world/economy-catalog.json");
for (const recipe of catalog.recipes) recipe.requiredRecipes ??= {};
const rewards = readJson("../apps/api/src/main/resources/world/progression-rewards-catalog.json");
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
const sale = load("../features/economy/domain/local-sale.ts", { "./model": money });
const model = load("../features/progression/economy-data.ts", {
  "@/features/economy/domain/model": { economyCatalog: catalog },
  "@/features/economy/domain/money": money,
  "@/features/economy/domain/local-sale": sale,
  "@/apps/api/src/main/resources/world/progression-rewards-catalog.json": { default: rewards },
});
const { progressionEconomy: economy, calculateRecipePlan, buildProgressionEconomy } = model;
const recipe = id => economy.recipes.find(value => value.id === id);
const item = id => economy.items.find(value => value.id === id);
const queue = (plan, id) => plan.queues.find(value => value.buildingId === id);

test("economy reference covers every actual item and recipe, with sources and reverse uses", () => {
  assert.equal(economy.items.length, catalog.items.length);
  assert.equal(economy.items.length, 56);
  assert.equal(economy.recipes.length, catalog.recipes.length);
  assert.equal(economy.recipes.length, 39);
  assert.equal(new Set(economy.items.map(value => value.id)).size, catalog.items.length);
  for (const value of economy.items) assert.ok(value.sources.length, `No source for ${value.id}`);
  for (const value of catalog.recipes) {
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
  assert.ok(item("moon_crystal").sources.every(source => !source.guaranteed));
});

test("source costs and prerequisites are complete catalog copies, including the recipe's own station", () => {
  const before = JSON.stringify(catalog);
  const reference = buildProgressionEconomy(catalog);
  for (const recipe of catalog.recipes) {
    const source = reference.items.find(item => item.id === Object.keys(recipe.rewards)[0]).sources.find(source => source.recipeId === recipe.id);
    assert.deepEqual(plain(source.cost), recipe.cost);
    assert.deepEqual(plain(source.requiredBuildings), { ...recipe.requiredBuildings,
      [recipe.buildingId]: Math.max(recipe.buildingLevel, recipe.requiredBuildings[recipe.buildingId] ?? 0) });
    assert.deepEqual(plain(source.requiredRecipes), recipe.requiredRecipes);
    source.cost.coins += 1;
    source.requiredBuildings[recipe.buildingId] += 1;
  }
  for (const route of catalog.explorations.filter(route => !catalog.fishing.routeIds.includes(route.id))) {
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
  assert.equal(recipe("make_beams").inputNpcValue, 430);
  assert.equal(recipe("make_beams").outputNpcValue, 600);
  assert.equal(recipe("make_beams").addedNpcValue, 170);
  assert.equal(recipe("weave_cloth").inputNpcValue, 80);
  assert.equal(recipe("weave_cloth").addedNpcValue, 160);
  assert.equal(recipe("cook_fish_soup").inputNpcValue, 140);
  assert.equal(recipe("cook_fish_soup").outputNpcValue, 220);
  assert.equal(recipe("cook_fish_soup").addedNpcValue, 80);
  assert.equal(recipe("cook_fish_soup").unitsPerHour, 2);
  assert.equal(recipe("cook_fish_soup").grossNpcPerHour, 440);
  assert.equal(recipe("grow_berries").unitsPerHour, 60);
  assert.equal(recipe("grow_berries").collectionSeconds, 8);
});

test("two beams recursively require eight hardwood and four fibre with shared workshop queue", () => {
  const plan = calculateRecipePlan("make_beams", 2);
  assert.deepEqual(plain(plan.rawInputs), { hardwood: 8, fiber: 4 });
  assert.equal(queue(plan, "woodlot").seconds, 8 * 600 + 4 * 60);
  assert.equal(queue(plan, "workshop").seconds, 2 * 3600 + 2 * 180);
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
  assert.equal(queue(cloth, "workshop").seconds, 2400 + 180);
  assert.deepEqual(plain(cloth.steps.map(step => step.recipeId)), ["gather_fiber", "make_rope", "weave_cloth"]);
  const soup = calculateRecipePlan("cook_fish_soup");
  assert.deepEqual(plain(soup.rawInputs), { fish_common: 2, berries: 1, wood: 1 });
  assert.deepEqual(plain(soup.uncertainItemIds), ["fish_common"]);
  assert.equal(queue(soup, "garden").seconds, 60);
  assert.equal(queue(soup, "garden").collectionSeconds, 8);
  assert.equal(queue(soup, "dryer").seconds, 1800);
  assert.ok(!soup.queues.some(value => value.buildingId === "fishing"));
});

test("unit mining is counted independently without choosing a multi-output expedition", () => {
  const plan = calculateRecipePlan("smelt_iron");
  assert.deepEqual(plain(plan.rawInputs), { ore: 3, wood: 1 });
  assert.equal(queue(plan, "quarry").seconds, 3 * 540);
  assert.deepEqual(plain(plan.miningSteps), [{ routeId: "quarry_ore", runs: 3 }]);
  assert.equal(queue(plan, "kiln").seconds, 1800 + 120);
  assert.equal(queue(plan, "woodlot").seconds, 180);
  assert.equal(plan.uncertainItemIds.length, 0);
  const stone = calculateRecipePlan("cut_stone");
  assert.equal(queue(stone, "quarry").seconds, 3 * 180);
});

test("stage budgets derive only required new buildings and preserve the seven daily gates", () => {
  const first = economy.stages.find(stage => stage.homeLevel === 1);
  assert.equal(first.buildingCoins, 380);
  assert.equal(first.orderCoins, 330);
  assert.equal(first.orders.length, 4);
  assert.deepEqual(plain(economy.starter), { coins: 100, pearls: 0, items: { wood: 3, stone: 5 } });
  assert.equal(economy.starter.coins + first.orderCoins - first.buildingCoins, 50);
  assert.deepEqual(plain(economy.storage.map(level => level.capacity)), [50, 100, 150, 200, 250, 300, 350, 400, 450, 500]);
  const second = economy.stages.find(stage => stage.homeLevel === 2);
  assert.equal(second.buildingCoins, 1050);
  assert.equal(second.orderCoins, 1990);
  assert.equal(second.orders.length, 7);
  const third = economy.stages.find(stage => stage.homeLevel === 3);
  assert.equal(third.buildingCoins, 20600);
  assert.equal(third.orderCoins, 14840);
  assert.equal(third.orders.length, 8);
  assert.equal(third.intervalSeconds, 86400);
  assert.equal(third.minimumGateSeconds, 7 * 86400);
  assert.equal(third.buildings.find(value => value.id === "home").seconds, 86400);
  assert.deepEqual(plain(third.completionRewards), { living_resin: 1 });
  assert.equal(third.orders[0].inputNpcValue, 380);
  assert.equal(third.orders[0].addedNpcValue, 190);
  assert.ok(economy.stages.every(stage => !stage.buildings.some(value => value.id === "warehouse")));
  assert.ok(economy.stages.find(stage => stage.homeLevel === 4).preliminary);
});

test("pearl budgets respect visible denomination and distinguish repeat gifts from finite achievements", () => {
  assert.equal(economy.pearls.dailyCycle, 7);
  assert.equal(economy.pearls.achievementLifetime, 119);
  assert.equal(economy.pearls.dailyMinimumHours, 20);
  assert.deepEqual(plain(economy.pearls.marketSlotPrices), [50, 80, 120, 180, 250]);
  assert.equal(economy.pearls.marketTotal, 680);
  assert.deepEqual(plain(economy.pearls.productionSlots), [{ slots: 2, pearls: 100 }, { slots: 3, pearls: 250 }]);
  assert.deepEqual(plain(economy.pearls.construction), { pearls: 1, seconds: 600 });
  assert.equal(economy.orderBoard.templates, 49);
  assert.equal(economy.orderBoard.slots, 3);
  assert.equal(economy.orderBoard.replacementPricePearls, 5);
  assert.deepEqual(plain(economy.fishingShop), { refreshSeconds: 21600, maximumRefreshPearls: 50 });
});

test("builders and calculations do not mutate the source catalog, and reject invalid requests", () => {
  const before = JSON.stringify(catalog);
  buildProgressionEconomy(catalog);
  for (const value of catalog.recipes) calculateRecipePlan(value.id, 3, catalog);
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
  assert.equal(updated.recipes.find(value => value.id === "make_planks").addedNpcValue, -60);
  const timberOrder = updated.stages[0].orders.find(value => value.id === "tutorial_wood_order");
  assert.equal(timberOrder.inputNpcValue, 200);
  assert.equal(timberOrder.addedNpcValue, -110);
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
