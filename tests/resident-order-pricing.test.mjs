import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { residentOrderPricing } from "../scripts/lib/resident-order-pricing.mjs";

const catalog = JSON.parse(readFileSync(new URL("../apps/api/src/main/resources/world/economy-catalog.json", import.meta.url), "utf8"));
const vectors = JSON.parse(readFileSync(new URL("../apps/api/src/test/resources/world/resident-order-balance-vectors.json", import.meta.url), "utf8"));

const currentVectors = JSON.parse(readFileSync(new URL("../apps/api/src/test/resources/world/time-economy-order-vectors.json", import.meta.url), "utf8"));

test("current repeatable orders use time-value quotes while the original 85 retain their ingredient quantities", () => {
  const price = residentOrderPricing(catalog);
  assert.equal(currentVectors.orders.length, catalog.food.orders.templates.length);
  assert.equal(currentVectors.orders.length, 163);
  assert.equal(new Set(currentVectors.orders.map(row => row.templateId)).size, currentVectors.orders.length);
  for (const expected of currentVectors.orders) {
    const template = catalog.food.orders.templates.find(template => template.id === expected.templateId);
    assert(template, expected.templateId);
    assert.deepEqual(template.items, expected.items, template.id);
    assert.deepEqual(price(template), { npcValue: expected.npcValue, manufacturingSeconds: expected.manufacturingSeconds, coins: expected.coins }, template.id);
    assert.equal(template.coins, expected.coins, template.id);
  }
  assert.equal(vectors.orders.length, 85, "historical reward vectors remain separate from new quotes");
  for (const historical of vectors.orders) {
    const template = catalog.food.orders.templates.find(template => template.id === historical.templateId);
    assert.deepEqual(template.items, historical.items, `${template.id}: original quantities`);
  }
});

test("time premium counts processed quantities and upstream recipes without charging raw acquisition twice", () => {
  const price = residentOrderPricing(catalog);
  const quote = id => price(catalog.food.orders.templates.find(template => template.id === id));
  assert.deepEqual(quote("starter_fresh_berries"), { npcValue: 130, manufacturingSeconds: 0, coins: 163 });
  assert.deepEqual(quote("builder_trail_snack"), { npcValue: 230, manufacturingSeconds: 15 * 60, coins: 288 });
  assert.deepEqual(quote("builder_bench_repair"), { npcValue: 80, manufacturingSeconds: 2 * 60, coins: 100 }, "manufacturing is already in item value; add the order bonus once");
  assert.equal(quote("builder_trail_supplies").manufacturingSeconds, 56 * 60, "one full ration chain plus two ropes");
  assert.equal(quote("builder_research_tools").manufacturingSeconds, 179 * 60, "tools and their smelted components are counted with their quantities");
  const slowerRaw = structuredClone(catalog);
  for (const recipe of slowerRaw.recipes.filter(recipe => Object.keys(recipe.cost.items).length === 0)) recipe.seconds *= 10;
  for (const route of slowerRaw.explorations) route.seconds *= 10;
  const unchanged = residentOrderPricing(slowerRaw);
  for (const template of catalog.food.orders.templates) assert.deepEqual(unchanged(template), price(template), template.id);
});

test("baseline quotes use available early technology and ignore later faster alternatives and array order", () => {
  const price = residentOrderPricing(catalog), template = catalog.food.orders.templates.find(template => template.id === "builder_iron_fittings");
  assert.deepEqual(price(template), { npcValue: 1500, manufacturingSeconds: 51 * 60, coins: 1875 }, "three ingots use 15-minute smelting and two-minute charcoal each");
  const future = structuredClone(catalog);
  for (const recipe of future.recipes.filter(recipe => ["smelt_tempered_iron", "make_clear_glass", "make_precision_parts"].includes(recipe.id))) recipe.seconds = 1;
  future.recipes.reverse();
  const unchanged = residentOrderPricing(future);
  for (const order of catalog.food.orders.templates) assert.deepEqual(unchanged(order), price(order), order.id);
  assert.throws(() => price({ ...template, requiredHomeLevel: 2, requiredBuildings: { kiln: 1 } }), /baseline recipe smelt_iron is unavailable/);
});
