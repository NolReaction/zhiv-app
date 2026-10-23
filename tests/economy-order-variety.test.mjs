import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false } });
after(() => vite.close());
const { economyCatalog: catalog } = await vite.ssrLoadModule("/features/economy/domain/model.ts");
const food = await vite.ssrLoadModule("/features/economy/domain/food.ts");
const { newEconomyState } = await vite.ssrLoadModule("/features/economy/domain/rules.ts");
const scenarios = JSON.parse(await readFile(new URL("../apps/api/src/test/resources/world/orders-variety-vectors.json", import.meta.url), "utf8"));
const balanceVectors = JSON.parse(await readFile(new URL("../apps/api/src/test/resources/world/resident-order-balance-vectors.json", import.meta.url), "utf8"));
const now = Date.parse("2026-10-16T09:00:00Z");
const make = scenario => {
  const state = newEconomyState({ resources: { sparks: 0, wood: 0, stone: 0 }, houseLevel: 1, workshopLevel: 0 });
  state.buildings = scenario.buildings;
  state.progression.recipes = scenario.recipes ?? {};
  state.fishing.ownedRods = scenario.ownedRods;
  state.fishing.ownedHooks = scenario.ownedHooks;
  return state;
};

for (const scenario of scenarios) test(`shared order variety/availability: ${scenario.label}`, () => {
  const state = make(scenario);
  // Purchased stock cannot open recipes, a missing source, or a future building.
  state.inventory = Object.fromEntries(catalog.items.map(item => [item.id, 100]));
  const eligible = food.eligibleResidentOrderTemplates(state), ids = new Set(eligible.map(template => template.id));
  for (const id of scenario.present) assert(ids.has(id), `expected ${id}`);
  for (const id of scenario.missing) assert(!ids.has(id), `unexpected ${id}`);
  for (let cycle = 0; cycle < 24; cycle++) {
    const board = food.residentOrderBoard(state, now + cycle * catalog.food.orders.refreshSeconds * 1000);
    assert.equal(board.offers.length, 3);
    assert.equal(new Set(board.offers.map(offer => JSON.stringify(Object.entries(offer.items).sort()))).size, 3);
    for (const offer of board.offers) assert(ids.has(offer.templateId), `cycle ${cycle}: unavailable ${offer.templateId}`);
  }
});

test("Plesk starts with berries then gains mixed meals and drinks without requiring fish on every card", () => {
  const state = make(scenarios[0]);
  let plesk = food.eligibleResidentOrderTemplates(state).filter(template => template.residentId === "plesk");
  assert(plesk.some(template => !Object.keys(template.items).some(id => id.startsWith("fish_"))), "the initial bush supports a berry-only request");
  state.buildings.dryer = 1;
  plesk = food.eligibleResidentOrderTemplates(state).filter(template => template.residentId === "plesk");
  assert(plesk.some(template => template.items.grilled_fish && template.items.berry_compote));
  assert(plesk.some(template => template.items.fish_common && template.items.berries));
  assert(plesk.some(template => template.items.berry_compote && !Object.keys(template.items).some(id => id.includes("fish"))));
  const seen = new Set();
  for (let index = 0; index < 32; index++) {
    const board = food.residentOrderBoard(state, now);
    const offer = board.offers.find(offer => offer.slot === 0);
    seen.add(offer.templateId);
    state.residentOrders = food.advanceResidentOrder(state, 0, now);
  }
  assert(seen.size >= 6, "one Plesk slot rotates through several real requests");
  assert([...seen].some(id => catalog.food.orders.templates.find(template => template.id === id).items.berry_compote));
});

test("owned valid tackle must have real positive fish-class odds including hook weights", () => {
  const state = make(scenarios[0]);
  state.fishing.ownedRods = ["missing_rod"];
  assert(!food.obtainableResidentOrderItems(state).has("fish_common"));
  state.fishing.ownedRods = ["reed_rod"];
  state.fishing.ownedHooks = ["missing_hook"];
  assert(!food.obtainableResidentOrderItems(state).has("fish_common"));
  const fixture = structuredClone(catalog);
  fixture.fishing.hooks.find(hook => hook.id === "bare_hook").rarityWeights = { common: 100, uncommon: 0, rare: 0, epic: 0, legendary: 0 };
  state.fishing.ownedHooks = ["bare_hook"];
  const reachable = food.obtainableResidentOrderItems(state, fixture);
  assert(reachable.has("fish_common"));
  assert(!reachable.has("fish_uncommon"));
  assert(!reachable.has("fish_rare"));
});

test("new request combinations keep compact quantities and the authored manufacturing premium", () => {
  const newIds = ["plesk_berry_break", "plesk_catch_and_berries", "plesk_compote_break", "plesk_picnic_lunch", "plesk_evening_basket",
    "plesk_strawberry_lunch", "builder_small_repair", "builder_bench_repair", "builder_drink_and_firewood", "plesk_blueberry_lunch",
    "plesk_berry_assortment", "builder_blueberry_snack", "plesk_soup_and_compote", "plesk_berry_sauce_lunch", "plesk_smoked_currants",
    "plesk_catch_and_jelly", "builder_trail_snack", "plesk_blackberry_feast", "plesk_preserve_and_catch", "plesk_path_provisions",
    "plesk_cranberry_dinner", "plesk_winter_table"];
  for (const id of newIds) {
    const template = catalog.food.orders.templates.find(template => template.id === id);
    assert(template, id);
    const expected = balanceVectors.orders.find(row => row.templateId === id);
    assert.equal(template.coins, expected.coins, id);
    assert(Object.values(template.items).every(count => count >= 1 && count <= 4), id);
    assert(!Object.keys(template.items).some(itemId => catalog.rareDrops.itemIds.includes(itemId)), `${id} cannot consume relics`);
  }
});
