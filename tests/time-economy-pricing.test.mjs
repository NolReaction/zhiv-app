import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { timeEconomyPricing } from "../scripts/lib/time-economy-pricing.mjs";
import { residentOrderPricing } from "../scripts/lib/resident-order-pricing.mjs";
import { repriceTimeEconomy } from "../scripts/reprice-time-economy.mjs";

const read = () => JSON.parse(readFileSync(new URL("../apps/api/src/main/resources/world/economy-catalog.json", import.meta.url), "utf8"));

test("the fixed minute standard prices raw goods and real nested processing without charging inputs twice", () => {
  const catalog = read(), pricing = timeEconomyPricing(catalog);
  const expected = { berries: 10, strawberries: 50, blueberries: 30, currants: 120, blackberries: 300, cranberries: 600,
    wood: 30, stone: 30, clay: 30, sand: 50, ore: 100, quartz: 150, limestone: 200,
    planks: 50, rope: 50, charcoal: 50, bricks: 110, dried_berries: 180, ceramic_jar: 160,
    packed_berries: 420, glass: 250, glass_bottle: 300, lens: 550, mortar: 340, stone_tile: 850,
    trade_crate: 230, field_kit: 2000, bottled_compote: 400, berry_gift: 1750 };
  for (const [id, coins] of Object.entries(expected)) {
    assert.equal(pricing.price(id), coins, id);
    assert.equal(catalog.items.find(item => item.id === id).baseSellPrice, coins, id);
    assert.equal(catalog.localBuyer.unitPrices[id], coins, id);
  }
  assert.equal(pricing.order({ dried_berries: 1 }), 225);
  assert.equal(pricing.order({ dried_berries: 1, rope: 1 }), 288, "287.5 rounds only once to a whole coin");
  assert.equal(pricing.order({ packed_berries: 1 }), 525);
});

test("a changed upstream minute propagates once through every dependent product", () => {
  const original = read(), changed = read();
  changed.recipes.find(recipe => recipe.id === "gather_wood").seconds += 60;
  const before = timeEconomyPricing(original), after = timeEconomyPricing(changed);
  for (const id of ["wood", "charcoal", "ceramic_jar", "packed_berries"])
    assert.equal(after.price(id) - before.price(id), 10, id);
  assert.equal(after.price("trade_crate") - before.price("trade_crate"), 20, "a crate really consumes two planks");
  assert.equal(after.price("dried_berries"), before.price("dried_berries"));
});

test("faster later technology cannot reprice everyone's inventory and source order is irrelevant", () => {
  const original = read(), changed = read();
  for (const recipe of changed.recipes.filter(recipe => ["smelt_tempered_iron", "make_clear_glass", "make_precision_parts"].includes(recipe.id))) recipe.seconds = 1;
  changed.recipes.reverse(); changed.explorations.reverse();
  const before = timeEconomyPricing(original), after = timeEconomyPricing(changed);
  for (const item of original.items) assert.equal(after.price(item.id), before.price(item.id), item.id);
});

test("ordinary and weekly orders add the same bonus to the already complete price", () => {
  const catalog = read(), price = residentOrderPricing(catalog), basis = timeEconomyPricing(catalog);
  for (const template of catalog.food.orders.templates) assert.equal(price(template).coins, basis.order(template.items), template.id);
  for (const weekly of catalog.tradeRelations.weekly.templates) for (const stage of weekly.stages)
    assert.equal(price({ ...weekly, ...stage }).coins, basis.order(stage.items), stage.id);
  const snack = price(catalog.food.orders.templates.find(template => template.id === "builder_trail_snack"));
  assert.deepEqual(snack, { npcValue: 230, manufacturingSeconds: 15 * 60, coins: 288 });
});

test("retired bulk routes remain identifiable but all selectable mining and manufacturing is one item", () => {
  const catalog = read();
  const retired = catalog.explorations.find(route => route.id === "quarry_clay_overnight");
  assert.equal(retired.retired, true); assert.equal(retired.seconds, 8 * 3600); assert.deepEqual(retired.rewards, { clay: 48 });
  for (const source of [...catalog.recipes.filter(recipe => !recipe.retired), ...catalog.explorations.filter(route => route.activity === "mining" && !route.retired)]) {
    assert(source.seconds > 0 && source.seconds <= 3600, source.id);
    assert.equal(Object.keys(source.rewards).length, 1, source.id);
    assert.equal(Object.values(source.rewards)[0], 1, source.id);
  }
  for (const level of [1, 2, 3, 4, 5]) assert(catalog.explorations.some(route => !route.retired
    && route.activity === "mining" && route.requiredBuildings.quarry === level), `quarry ${level} must unlock a real resource`);
});

test("invalid missing retired joint or cyclic price bases fail instead of silently inventing a price", () => {
  const missing = read(); delete missing.timeEconomy.baselineRecipes.berries;
  assert.throws(() => timeEconomyPricing(missing).price("berries"), /exactly one price basis/);
  const retired = read(); retired.recipes.find(recipe => recipe.id === "grow_berries").retired = true;
  assert.throws(() => timeEconomyPricing(retired).price("berries"), /missing or retired baseline/);
  const joint = read(); joint.recipes.find(recipe => recipe.id === "grow_berries").rewards.strawberries = 1;
  assert.throws(() => timeEconomyPricing(joint).price("berries"), /joint outputs/);
  const cyclic = read(); cyclic.recipes.find(recipe => recipe.id === "grow_berries").cost.items.berry_compote = 1;
  assert.throws(() => timeEconomyPricing(cyclic).price("berries"), /Price cycle/);
});

test("constructor work and material inputs stay separate and the complete derivation is reproducible", () => {
  const catalog = read();
  assert.deepEqual(catalog.buildings.find(building => building.id === "home").levels.map(level => level.cost.coins), [0, 300, 1200, 2400, 3600]);
  assert.equal(catalog.buildings.find(building => building.id === "home").levels[1].cost.items.planks, 2);
  assert.deepEqual(repriceTimeEconomy(catalog), catalog);
});

test("random fish and shop-only bait are explicitly external valuations rather than false fixed acquisition times", () => {
  const catalog = read(), pricing = timeEconomyPricing(catalog);
  for (const group of catalog.fishing.classes) {
    assert.equal(catalog.timeEconomy.baselineRecipes[group.itemId], undefined);
    assert.equal(catalog.timeEconomy.baselineExplorations[group.itemId], undefined);
    assert.equal(pricing.price(group.itemId), catalog.timeEconomy.externalPrices[group.itemId]);
  }
  assert.equal(pricing.price("ancient_core"), 0);
  assert.equal(catalog.timeEconomy.externalPrices.ancient_core, undefined);
});
