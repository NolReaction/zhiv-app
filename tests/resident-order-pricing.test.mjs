import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { residentOrderPricing } from "../scripts/lib/resident-order-pricing.mjs";

const catalog = JSON.parse(readFileSync(new URL("../apps/api/src/main/resources/world/economy-catalog.json", import.meta.url), "utf8"));
const vectors = JSON.parse(readFileSync(new URL("../apps/api/src/test/resources/world/resident-order-balance-vectors.json", import.meta.url), "utf8"));

test("the original 85 repeatable rewards retain their promised quantities and manufacturing payouts", () => {
  const price = residentOrderPricing(catalog), baselineIds = new Set(vectors.orders.map(row => row.templateId));
  const templates = catalog.food.orders.templates.filter(template => baselineIds.has(template.id));
  assert.equal(templates.length, 85); assert.equal(vectors.orders.length, templates.length);
  assert.equal(new Set(vectors.orders.map(row => row.templateId)).size, templates.length);
  let changed = 0, raw = 0, processing = 0;
  for (const expected of vectors.orders) {
    const template = templates.find(template => template.id === expected.templateId);
    assert(template, expected.templateId);
    assert.deepEqual(template.items, expected.items, `${template.id}: quantities are unchanged`);
    assert.deepEqual(price(template), { npcValue: expected.npcValue, manufacturingSeconds: expected.manufacturingSeconds, coins: expected.coins }, template.id);
    assert.equal(template.coins, expected.coins, template.id);
    assert(template.coins >= expected.previousCoins, `${template.id}: no previous reward is reduced`);
    if (expected.manufacturingSeconds === 0) { raw++; assert.equal(template.coins, expected.previousCoins, template.id); } else processing++;
    if (template.coins !== expected.previousCoins) changed++;
  }
  assert.deepEqual({ changed, raw, processing }, { changed: 47, raw: 33, processing: 52 });
  assert.equal(templates.reduce((sum, template) => sum + template.coins, 0), 83090);
});

test("time premium counts processed quantities and upstream recipes without charging raw acquisition twice", () => {
  const price = residentOrderPricing(catalog);
  const quote = id => price(catalog.food.orders.templates.find(template => template.id === id));
  assert.deepEqual(quote("starter_fresh_berries"), { npcValue: 110, manufacturingSeconds: 0, coins: 170 });
  assert.deepEqual(quote("builder_trail_snack"), { npcValue: 120, manufacturingSeconds: 48 * 60, coins: 230 });
  assert.deepEqual(quote("builder_bench_repair"), { npcValue: 70, manufacturingSeconds: 2 * 60, coins: 110 }, "105 + 2 rounds once, not 110 + 2");
  assert.equal(quote("builder_trail_supplies").manufacturingSeconds, 144 * 60, "one full ration chain plus two ropes");
  assert.equal(quote("builder_research_tools").manufacturingSeconds, 487 * 60, "tools and their smelted components are counted with their quantities");
  const slowerRaw = structuredClone(catalog);
  for (const recipe of slowerRaw.recipes.filter(recipe => Object.keys(recipe.cost.items).length === 0)) recipe.seconds *= 10;
  for (const route of slowerRaw.explorations) route.seconds *= 10;
  const unchanged = residentOrderPricing(slowerRaw);
  for (const template of catalog.food.orders.templates) assert.deepEqual(unchanged(template), price(template), template.id);
});

test("baseline quotes use available early technology and ignore later faster alternatives and array order", () => {
  const price = residentOrderPricing(catalog), template = catalog.food.orders.templates.find(template => template.id === "builder_iron_fittings");
  assert.deepEqual(price(template), { npcValue: 1020, manufacturingSeconds: 96 * 60, coins: 1630 }, "three ingots use 30-minute smelting and two-minute charcoal each");
  const future = structuredClone(catalog);
  for (const recipe of future.recipes.filter(recipe => ["smelt_tempered_iron", "make_clear_glass", "make_precision_parts"].includes(recipe.id))) recipe.seconds = 1;
  future.recipes.reverse();
  const unchanged = residentOrderPricing(future);
  for (const order of catalog.food.orders.templates) assert.deepEqual(unchanged(order), price(order), order.id);
  assert.throws(() => price({ ...template, requiredHomeLevel: 2, requiredBuildings: { kiln: 1 } }), /baseline recipe smelt_iron is unavailable/);
});
