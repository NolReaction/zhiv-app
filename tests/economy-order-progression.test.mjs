import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false } });
after(() => vite.close());
const { economyCatalog: catalog, economyResidentOrdersSchema } = await vite.ssrLoadModule("/features/economy/domain/model.ts");
const food = await vite.ssrLoadModule("/features/economy/domain/food.ts");
const rules = await vite.ssrLoadModule("/features/economy/domain/rules.ts");
const vectors = JSON.parse(await readFile(new URL("../apps/api/src/test/resources/world/orders-progression-vectors.json", import.meta.url), "utf8"));
const now = Date.parse("2026-10-07T12:00:00Z");
const fresh = () => rules.newEconomyState({ resources: { sparks: 0, wood: 0, stone: 0 }, houseLevel: 1, workshopLevel: 0 });

test("shared Kotlin vectors scale raw materials strongly, bound complex goods and preserve mixed item premiums", () => {
  for (const expected of vectors.scaling) {
    const template = catalog.food.orders.templates.find(template => template.id === expected.templateId);
    const actual = food.progressedResidentOrderTemplate(template, expected.home);
    assert.deepEqual(actual.items, expected.items, `${expected.templateId}@${expected.home}`);
    assert.equal(actual.coins, expected.coins, `${expected.templateId}@${expected.home}`);
  }
});

test("shared Kotlin reachability vectors require every production input and both legendary tackle pieces", () => {
  for (const scenario of vectors.availability) {
    const state = fresh(); state.buildings = scenario.buildings;
    state.fishing.ownedRods = scenario.ownedRods; state.fishing.ownedHooks = scenario.ownedHooks;
    state.inventory = Object.fromEntries(catalog.items.map(item => [item.id, 100]));
    const reachable = food.obtainableResidentOrderItems(state);
    for (const id of scenario.present) assert(reachable.has(id), `${scenario.label}: expected ${id}`);
    for (const id of scenario.missing) assert(!reachable.has(id), `${scenario.label}: unexpected ${id}`);
    for (const offer of food.eligibleResidentOrderTemplates(state))
      assert(Object.keys(offer.items).every(id => reachable.has(id)), `${scenario.label}: ${offer.id}`);
  }
});

test("new material templates unlock only with completed supply chains and include every ordinary crafted/material item", () => {
  const state = fresh(); state.buildings.home = 5;
  const initial = food.eligibleResidentOrderTemplates(state);
  for (const id of ["ore", "clay", "sand", "hardwood", "resin", "charcoal", "iron_ingot", "reinforced_parts"])
    assert(!initial.some(template => template.items[id]), `home alone must not open ${id}`);
  state.buildings = Object.fromEntries(catalog.buildings.map(building => [building.id, building.levels.at(-1).level]));
  const available = food.eligibleResidentOrderTemplates(state), requested = new Set(available.flatMap(template => Object.keys(template.items)));
  for (const item of catalog.items.filter(item => ["material", "crafted"].includes(item.category)))
    assert(requested.has(item.id), `missing ordinary material ${item.id}`);
});

test("saved cards keep IDs goods and payouts through home upgrades catalog edits removals and read refresh", () => {
  const fixture = structuredClone(catalog), state = fresh(); state.catalog = fixture;
  state.residentOrders = food.normalizedResidentOrders(state, now, fixture);
  const before = food.residentOrderBoard(state, now, fixture);
  state.buildings.home = 5;
  fixture.food.orders.templates = fixture.food.orders.templates.filter(template => template.id !== before.offers[0].templateId);
  for (const template of fixture.food.orders.templates) { template.coins *= 2; for (const id of Object.keys(template.items)) template.items[id]++; }
  state.residentOrders = economyResidentOrdersSchema.parse(JSON.parse(JSON.stringify(state.residentOrders)));
  assert.deepEqual(food.residentOrderBoard(state, now + 1000, fixture).offers, before.offers);
  const replaced = food.advanceResidentOrder(state, 1, now, fixture);
  const changed = food.residentOrderBoard({ ...state, residentOrders: replaced }, now, fixture);
  assert.deepEqual(changed.offers.filter(offer => offer.slot !== 1), before.offers.filter(offer => offer.slot !== 1));
});

test("legacy v2 terms migrate at their old unscaled quote; next cards use the current level", () => {
  const state = fresh(); state.buildings.home = 5;
  const cycle = Math.floor(now / (catalog.food.orders.refreshSeconds * 1000));
  const original = catalog.food.orders.templates.find(template => template.id === "builder_wood_supply");
  state.residentOrders = { ...food.initialResidentOrders(), version: 2, cycle, slots: [
    { sequence: 2, readyAt: new Date(now).toISOString(), templateId: "plesk_river_catch", terms: null },
    { sequence: 3, readyAt: new Date(now).toISOString(), templateId: original.id },
  ], completed: 11, earnedCoins: 8000, replacementCycle: cycle, freeReplacementsUsed: 2 };
  const board = food.residentOrderBoard(state, now), preserved = board.offers.find(offer => offer.slot === 1);
  assert.deepEqual(preserved.items, original.items); assert.equal(preserved.coins, original.coins);
  assert.equal(preserved.id, `order2_${cycle}_1_3_${food.residentOrderFingerprint(original)}`);
  state.residentOrders = food.normalizedResidentOrders(state, now);
  assert.equal(state.residentOrders.completed, 11); assert.equal(state.residentOrders.earnedCoins, 8000);
  assert.equal(state.residentOrders.freeReplacementsUsed, 2);
  state.inventory = { ...preserved.items };
  const beforeCoins = state.wallet.coins;
  rules.applyEconomyCommand(state, { requestId: crypto.randomUUID(), ownerPublicId: "0123-4567-89AB", expectedRevision: 0,
    action: "complete_resident_order", targetId: preserved.id, quantity: 1, totalPrice: 0 }, now, () => crypto.randomUUID());
  assert.equal(state.wallet.coins, beforeCoins + preserved.coins);
  assert.equal(state.residentOrders.completed, 12);
  const next = food.residentOrderBoard(state, now).offers.find(offer => offer.slot === 1);
  const expected = food.progressedResidentOrderTemplate(catalog.food.orders.templates.find(template => template.id === next.templateId), 5);
  assert.deepEqual(next.items, expected.items); assert.equal(next.coins, expected.coins);
});
