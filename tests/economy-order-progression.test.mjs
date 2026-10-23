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
const balanceVectors = JSON.parse(await readFile(new URL("../apps/api/src/test/resources/world/resident-order-balance-vectors.json", import.meta.url), "utf8"));
const now = Date.parse("2026-10-07T12:00:00Z");
const fresh = () => rules.newEconomyState({ resources: { sparks: 0, wood: 0, stone: 0 }, houseLevel: 1, workshopLevel: 0 });

test("shared Kotlin vectors keep compact requests and mixed-item premiums identical across home levels", () => {
  for (const multipliers of Object.values(catalog.food.orders.progression)) assert.deepEqual(multipliers, [10000, 10000, 10000, 10000, 10000]);
  for (const expected of vectors.scaling) {
    const template = catalog.food.orders.templates.find(template => template.id === expected.templateId);
    const actual = food.progressedResidentOrderTemplate(template, expected.home);
    assert.deepEqual(actual.items, expected.items, `${expected.templateId}@${expected.home}`);
    assert.equal(actual.coins, expected.coins, `${expected.templateId}@${expected.home}`);
  }
  for (const template of catalog.food.orders.templates) for (let home = 1; home <= 5; home++) {
    const actual = food.progressedResidentOrderTemplate(template, home);
    assert.deepEqual(actual.items, template.items, `${template.id}@${home}: higher houses keep the accepted quantity compact`);
    assert.equal(actual.coins, template.coins, `${template.id}@${home}: the authored premium is preserved`);
  }
});

test("all shared manufacturing quotes match Kotlin at every house level", () => {
  assert.equal(balanceVectors.orders.length, 85);
  for (const expected of balanceVectors.orders) for (let home = 1; home <= 5; home++) {
    const template = catalog.food.orders.templates.find(template => template.id === expected.templateId);
    const actual = food.progressedResidentOrderTemplate(template, home);
    assert.deepEqual(actual.items, expected.items, `${expected.templateId}@${home}`);
    assert.equal(actual.coins, expected.coins, `${expected.templateId}@${home}`);
  }
});

test("shared Kotlin reachability vectors require every production input and rods with positive class odds", () => {
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

test("the first-stage update keeps a saved 400-coin delivery exact and quotes new wood at 90", () => {
  const state = fresh(), template = catalog.food.orders.templates.find(template => template.id === "builder_wood_supply");
  assert.equal(template.coins, 90);
  state.residentOrders = food.normalizedResidentOrders(state, now);
  state.residentOrders.slots[1] = { sequence: 3, readyAt: new Date(now).toISOString(), templateId: template.id,
    terms: { ...template, items: { wood: 8 }, coins: 400 } };
  const saved = food.residentOrderBoard(state, now).offers.find(offer => offer.slot === 1);
  assert.equal(saved.coins, 400); assert.deepEqual(saved.items, { wood: 8 });
  const initialCoins = state.wallet.coins;
  state.inventory = { wood: 8 };
  rules.applyEconomyCommand(state, { requestId: crypto.randomUUID(), ownerPublicId: "0123-4567-89AB", expectedRevision: 0,
    action: "complete_resident_order", targetId: saved.id, quantity: 1, totalPrice: 0 }, now, () => crypto.randomUUID());
  assert.equal(state.wallet.coins, initialCoins + 400);
  assert.equal(state.residentOrders.earnedCoins, 400);
  const next = food.residentOrderBoard(state, now).offers.find(offer => offer.slot === 1);
  assert.equal(next.coins, catalog.food.orders.templates.find(template => template.id === next.templateId).coins);
});

test("the manufacturing rebalance retains an accepted 180-coin snack and quotes its next card at 230", () => {
  const state = fresh(), template = catalog.food.orders.templates.find(template => template.id === "builder_trail_snack");
  state.buildings = { home: 3, warehouse: 1, garden: 2, workshop: 1, woodlot: 1, dryer: 1 };
  state.residentOrders = food.normalizedResidentOrders(state, now);
  state.residentOrders.slots[1] = { sequence: 3, readyAt: new Date(now).toISOString(), templateId: template.id,
    terms: { ...template, coins: 180 } };
  const accepted = food.residentOrderBoard(state, now).offers.find(offer => offer.slot === 1);
  state.residentOrders = economyResidentOrdersSchema.parse(JSON.parse(JSON.stringify(state.residentOrders)));
  assert.deepEqual(food.residentOrderBoard(state, now + 1000).offers.find(offer => offer.slot === 1), accepted);
  assert.equal(accepted.coins, 180); assert.equal(template.coins, 230);
  const fixture = structuredClone(catalog); fixture.food.orders.templates = [template];
  const replaced = food.advanceResidentOrder(state, 1, now, fixture);
  const next = food.residentOrderBoard({ ...state, residentOrders: replaced }, now, fixture).offers.find(offer => offer.slot === 1);
  assert.equal(next.templateId, accepted.templateId); assert.equal(next.coins, 230);
  assert.deepEqual(next.items, accepted.items); assert.notEqual(next.id, accepted.id);
  const beforeCoins = state.wallet.coins; state.inventory = { ...accepted.items };
  rules.applyEconomyCommand(state, { requestId: crypto.randomUUID(), ownerPublicId: "0123-4567-89AB", expectedRevision: 0,
    action: "complete_resident_order", targetId: accepted.id, quantity: 1, totalPrice: 0 }, now, () => crypto.randomUUID());
  assert.equal(state.wallet.coins, beforeCoins + 180, "accepted terms pay their original exact amount");
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
  const legacyTerms = { id: original.id, residentId: original.residentId, name: original.name, items: original.items, coins: original.coins };
  assert.equal(preserved.id, `order2_${cycle}_1_3_${food.residentOrderFingerprint(legacyTerms)}`);
  assert.equal(preserved.reputationXp, undefined, "legacy cards without saved metadata cannot gain retroactive reputation");
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
