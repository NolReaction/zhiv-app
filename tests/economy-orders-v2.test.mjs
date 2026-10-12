import assert from "node:assert/strict";
import test, { after, beforeEach } from "node:test";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false } });
after(() => vite.close());
const model = await vite.ssrLoadModule("/features/economy/domain/model.ts");
const food = await vite.ssrLoadModule("/features/economy/domain/food.ts");
const rules = await vite.ssrLoadModule("/features/economy/domain/rules.ts");
const identities = await vite.ssrLoadModule("/lib/dev/api-store.ts");
const api = await vite.ssrLoadModule("/lib/dev/economy-store.ts");
const vectors = JSON.parse(await readFile(new URL("../apps/api/src/test/resources/world/orders-v2-vectors.json", import.meta.url), "utf8"));
const now = Date.parse(vectors.now), catalog = model.economyCatalog;
const fresh = () => rules.newEconomyState({ resources: { sparks: 0, wood: 0, stone: 0 }, houseLevel: 1, workshopLevel: 0 });
const command = (action, targetId, totalPrice = 0) => ({ requestId: crypto.randomUUID(), ownerPublicId: "0123-4567-89AB", expectedRevision: 0, action, targetId, quantity: 1, totalPrice });
const apply = (state, action, targetId, at = now, totalPrice = 0) => rules.applyEconomyCommand(state, command(action, targetId, totalPrice), at, () => crypto.randomUUID(), {}, () => 0);
const board = (state, at = now) => food.residentOrderBoard(state, at);
const synthetic = () => ({ ...structuredClone(catalog), food: { ...structuredClone(catalog.food), orders: structuredClone(vectors.config) } });
const failWithoutChanges = (state, action, targetId, code, price = 0, at = now) => {
  const before = structuredClone(state);
  assert.throws(() => apply(state, action, targetId, at, price), { code });
  assert.deepEqual(state, before);
};
const player = () => identities.createDevIdentity("Доска заказов", crypto.randomUUID());
const read = (player, at = now) => api.getDevEconomy(player.token, at);
const request = (player, action, targetId, totalPrice = 0, at = now) => ({ ...command(action, targetId, totalPrice), ownerPublicId: player.me.user.publicId, expectedRevision: read(player, at).revision });
const row = player => { read(player); return globalThis.__zhivDevEconomyStore.profiles.get(player.me.user.publicId); };
beforeEach(() => identities.resetDevStoreForTests());

function uniqueOffers(offers) {
  assert.equal(new Set(offers.map(offer => offer.templateId)).size, offers.length);
  assert.equal(new Set(offers.map(offer => JSON.stringify(Object.entries(offer.items).sort()))).size, offers.length);
  assert.equal(offers[0].residentId, "plesk"); assert.equal(offers[1].residentId, "builder");
}

test("shared Kotlin vectors pin FNV selection, canonical fingerprints, history and calendar refresh", () => {
  const fixture = synthetic(), state = { ...fresh(), catalog: fixture };
  const before = structuredClone(state);
  vectors.stages.forEach((stage, index) => {
    if (index > 0) state.residentOrders = food.advanceResidentOrder(state, Number(stage.label.split("-")[1]), now, fixture);
    const actual = food.residentOrderBoard(state, now, fixture);
    assert.deepEqual(actual.offers.map(offer => offer.id), stage.ids);
    assert.deepEqual(actual.offers.map(offer => offer.templateId), stage.templates);
    assert.deepEqual(state.residentOrders.recentTemplateIds, stage.history);
    assert.equal(actual.freeReplacementsRemaining, stage.quota);
    assert.ok(actual.offers.every(offer => offer.id.length <= 80));
    uniqueOffers(actual.offers);
    if (index === 0) assert.deepEqual(state, before, "derivation is read-only");
  });
  const later = now + fixture.food.orders.refreshSeconds * 1000;
  const refresh = food.residentOrderBoard(state, later, fixture);
  assert.deepEqual(refresh.offers.map(offer => offer.id), vectors.refresh.ids);
  assert.deepEqual(refresh.offers.map(offer => offer.templateId), vectors.refresh.templates);
  assert.deepEqual(food.normalizedResidentOrders(state, later, fixture).recentTemplateIds, vectors.refresh.history);
});

test("hundreds of immediate changes keep neighbours stable and avoid all six recent cards when the pool permits", () => {
  const fixture = synthetic(), state = { ...fresh(), catalog: fixture };
  for (let turn = 0; turn < 200; turn++) {
    const slot = turn % 3, before = food.residentOrderBoard(state, now, fixture);
    state.residentOrders = food.advanceResidentOrder(state, slot, now, fixture);
    const after = food.residentOrderBoard(state, now, fixture);
    uniqueOffers(after.offers);
    assert.notEqual(after.offers[slot].templateId, before.offers[slot].templateId);
    assert.ok(!state.residentOrders.recentTemplateIds.includes(after.offers[slot].templateId));
    for (let neighbour = 0; neighbour < 3; neighbour++) if (neighbour !== slot) assert.deepEqual(after.offers[neighbour], before.offers[neighbour]);
    assert.ok(state.residentOrders.recentTemplateIds.length <= 6);
    assert.equal(state.residentOrders.recentTemplateIds.at(-1), before.offers[slot].templateId);
  }
});

test("a small resident pool relaxes only oldest history without copying a current card", () => {
  const fixture = synthetic(); fixture.food.orders.templates = fixture.food.orders.templates.filter(template => /_[012]$/.test(template.id));
  const cycle = Math.floor(now / (fixture.food.orders.refreshSeconds * 1000));
  const state = { ...fresh(), catalog: fixture, residentOrders: { ...food.initialResidentOrders(), version: 2, cycle,
    recentTemplateIds: ["plesk_1", "plesk_2"], slots: ["plesk_0", "builder_0", "builder_1"].map(templateId => ({ templateId, sequence: 0, readyAt: new Date(now).toISOString() })) } };
  state.residentOrders = food.advanceResidentOrder(state, 0, now, fixture);
  const actual = food.residentOrderBoard(state, now, fixture);
  assert.equal(actual.offers[0].templateId, "plesk_1");
  assert.deepEqual(state.residentOrders.recentTemplateIds, ["plesk_1", "plesk_2", "plesk_0"], "local relaxation does not erase the actual history");
  uniqueOffers(actual.offers);
});

test("three free replacements share one board budget, then require an approved pearl quote", () => {
  const state = fresh(); state.wallet.pearls = 40;
  for (const slot of [0, 1, 2]) {
    const before = board(state); assert.equal(before.replacementPricePearls, 0);
    apply(state, "replace_resident_order", before.offers[slot].id);
    assert.equal(state.wallet.pearls, 40); assert.equal(board(state).freeReplacementsRemaining, 2 - slot);
  }
  let current = board(state);
  assert.equal(current.replacementPricePearls, 10);
  failWithoutChanges(state, "replace_resident_order", current.offers[0].id, "ECONOMY_ORDER_PRICE_CHANGED", 0);
  failWithoutChanges(state, "replace_resident_order", current.offers[0].id, "ECONOMY_ORDER_PRICE_CHANGED", 9);
  apply(state, "replace_resident_order", current.offers[0].id, now, 10);
  assert.equal(state.wallet.pearls, 30); assert.equal(state.residentOrders.freeReplacementsUsed, 3);
  current = board(state); state.wallet.pearls = 9;
  failWithoutChanges(state, "replace_resident_order", current.offers[0].id, "ECONOMY_PEARLS", 10);
  state.wallet.pearls = 30;
  apply(state, "replace_resident_order", current.offers[0].id, now, 100);
  assert.equal(state.wallet.pearls, 20, "the server charges the actual 10, never the accepted maximum 100");
});

test("a reduced catalogue cannot charge a free or paid replacement for the same request", () => {
  const original = catalog.food.orders.templates;
  try {
    catalog.food.orders.templates = [original.find(template => template.residentId === "plesk" && template.requiredHomeLevel === 1 && !Object.keys(template.requiredBuildings).length)];
    for (const freeUsed of [0, 3]) {
      const state = fresh(); state.wallet.pearls = 40;
      state.residentOrders = food.normalizedResidentOrders(state, now); state.residentOrders.freeReplacementsUsed = freeUsed;
      const offer = board(state).offers[0];
      failWithoutChanges(state, "replace_resident_order", offer.id, "ECONOMY_ORDER_NO_ALTERNATIVE", freeUsed ? 10 : 0);
      state.inventory = { ...offer.items };
      apply(state, "complete_resident_order", offer.id);
      assert.equal(state.residentOrders.completed, 1, "fulfilment still works if only one request is available");
      assert.equal(state.wallet.pearls, 40); assert.equal(state.residentOrders.freeReplacementsUsed, freeUsed);
    }
  } finally { catalog.food.orders.templates = original; }
});

test("completion is immediately repeatable with new goods and never consumes replacement allowance or pearls", () => {
  const state = fresh(); state.wallet.pearls = 10;
  const templates = [];
  for (let index = 0; index < 12; index++) {
    const offer = board(state).offers[index % 3]; templates.push(offer.templateId);
    const neighbours = board(state).offers.filter(entry => entry.slot !== offer.slot);
    state.inventory = { ...offer.items };
    const beforeCoins = state.wallet.coins;
    apply(state, "complete_resident_order", offer.id);
    assert.equal(state.wallet.coins, beforeCoins + offer.coins); assert.equal(state.wallet.pearls, 10);
    assert.equal(board(state).freeReplacementsRemaining, 3); assert.equal(state.residentOrders.completed, index + 1);
    assert.deepEqual(board(state).offers.filter(entry => entry.slot !== offer.slot), neighbours);
    assert.ok(board(state).offers.every(entry => Date.parse(entry.availableAt) <= now));
    failWithoutChanges(state, "complete_resident_order", offer.id, "ECONOMY_ORDER_CHANGED");
  }
  assert.ok(new Set(templates).size > 3);
});

test("quota resets exactly at twelve hours and stays independent of a different board interval", () => {
  const fixture = synthetic(); fixture.food.orders.refreshSeconds = 21600;
  const state = { ...fresh(), catalog: fixture };
  const beforeBoundary = now + 21600000 - 1;
  state.residentOrders = food.normalizedResidentOrders(state, beforeBoundary, fixture);
  state.residentOrders.freeReplacementsUsed = 3;
  const copy = structuredClone(state);
  assert.equal(food.residentOrderBoard(state, beforeBoundary + 1, fixture).freeReplacementsRemaining, 0, "six-hour board refresh grants no extra replacements");
  assert.equal(food.residentOrderBoard(state, now + 43200000 - 1, fixture).freeReplacementsRemaining, 0);
  assert.equal(food.residentOrderBoard(state, now + 43200000, fixture).freeReplacementsRemaining, 3);
  assert.deepEqual(state, copy);
  const real = fresh(); real.wallet.pearls = 25;
  real.residentOrders = food.normalizedResidentOrders(real, now); real.residentOrders.freeReplacementsUsed = 3;
  real.residentOrders.replacementCycle--;
  apply(real, "replace_resident_order", board(real).offers[0].id, now, 10);
  assert.equal(real.wallet.pearls, 25, "a formerly approved paid ceiling cannot force spending in a free window");
  assert.equal(real.residentOrders.freeReplacementsUsed, 1);
});

test("legacy cooldowns migrate without spending or state writes and old offer IDs cannot execute", () => {
  const state = fresh(); state.residentOrders = { cycle: Math.floor(now / 21600000), slots: [0, 1, 2].map(sequence => ({ sequence,
    readyAt: new Date(now + 3600000).toISOString() })), completed: 7, earnedCoins: 1234 };
  const previous = structuredClone(state), actual = board(state);
  assert.equal(actual.completed, 7); assert.equal(actual.earnedCoins, 1234);
  assert.equal(actual.freeReplacementsRemaining, 3); assert.ok(actual.offers.every(offer => Date.parse(offer.availableAt) <= now));
  assert.deepEqual(state, previous);
  failWithoutChanges(state, "complete_resident_order", "order_82934_0_0_plesk_river_catch", "ECONOMY_ORDER_CHANGED");
  apply(state, "replace_resident_order", actual.offers[0].id);
  assert.equal(state.residentOrders.version, 2); assert.equal(state.residentOrders.completed, 7); assert.equal(state.residentOrders.earnedCoins, 1234);
});

test("unlocking a building does not reroll initial cards even before the first order command", () => {
  const state = fresh(), before = board(state);
  state.jobs.push({ id: crypto.randomUUID(), kind: "construction", targetId: "home", recipeId: null, targetLevel: 5,
    startedAt: new Date(now - 1000).toISOString(), finishesAt: new Date(now).toISOString(), rewards: {}, cost: { coins: 0, items: {} }, catalogVersion: 3 });
  apply(state, "claim_job", state.jobs[0].id);
  assert.equal(state.buildings.home, 5); assert.equal(state.residentOrders.version, 2);
  assert.deepEqual(board(state).offers, before.offers);
});

test("fingerprints cover goods and payout while pinned cards survive catalog edits", () => {
  const fixture = synthetic(), state = { ...fresh(), catalog: fixture };
  state.residentOrders = food.normalizedResidentOrders(state, now, fixture);
  const before = food.residentOrderBoard(state, now, fixture), template = fixture.food.orders.templates.find(template => template.id === before.offers[0].templateId);
  const fingerprint = food.residentOrderFingerprint(template);
  assert.equal(food.residentOrderFingerprint({ ...template, name: "Другое название", description: "Новый рассказ", items: Object.fromEntries(Object.entries(template.items).reverse()) }), fingerprint);
  assert.notEqual(food.residentOrderFingerprint({ ...template, coins: template.coins + 1 }), fingerprint);
  template.items.fish++;
  const changed = food.residentOrderBoard(state, now, fixture);
  assert.deepEqual(changed.offers[0], before.offers[0], "issued terms survive catalog edits");
  assert.deepEqual(changed.offers.slice(1), before.offers.slice(1));
  const duplicate = structuredClone(catalog); duplicate.food.orders.templates.push({ ...duplicate.food.orders.templates[0], id: "disguised_duplicate", name: "Чужая подпись" });
  assert.equal(model.economyCatalogSchema.safeParse(duplicate).success, false);
});

test("paid replacement receipts replay once, reject altered quotes, and fence concurrent stale revisions", () => {
  const p = player(), saved = row(p); saved.state.wallet.pearls = 50;
  saved.state.residentOrders = food.normalizedResidentOrders(saved.state, now); saved.state.residentOrders.freeReplacementsUsed = 3;
  const before = read(p), offer = board(before).offers[0];
  const payload = request(p, "replace_resident_order", offer.id, 10);
  const first = api.commandDevEconomy(p.token, payload, now);
  assert.equal(first.state.wallet.pearls, 40);
  const replay = api.commandDevEconomy(p.token, payload, now + 1000);
  assert.equal(replay.replayed, true); assert.equal(replay.state.wallet.pearls, 40); assert.equal(replay.acceptedRevision, first.acceptedRevision);
  assert.deepEqual(replay.state.residentOrders, first.state.residentOrders);
  assert.throws(() => api.commandDevEconomy(p.token, { ...payload, totalPrice: 100 }, now), { code: "ECONOMY_REQUEST_CONFLICT" });
  assert.throws(() => api.commandDevEconomy(p.token, { ...payload, requestId: crypto.randomUUID(), targetId: board(first.state).offers[1].id }, now), { code: "ECONOMY_REVISION_CONFLICT" });
  const stateAfter = read(p); assert.equal(stateAfter.wallet.pearls, 40); assert.equal(stateAfter.residentOrders.freeReplacementsUsed, 3);
});

test("all six meal tiers shorten one job by their own speed and old saved jobs keep their paid timing", () => {
  assert.deepEqual(catalog.food.meals.map(meal => [meal.heroSpeedBps, meal.builderSpeedBps]), [[1000,1000],[2500,2000],[4000,3500],[6000,5000],[8000,7000],[10000,9000]]);
  for (const meal of catalog.food.meals) {
    const state = fresh(); state.inventory = { [meal.itemId]: 1 };
    apply(state, "eat_food", meal.itemId); apply(state, "start_exploration", "forest");
    const route = catalog.explorations.find(route => route.id === "forest");
    assert.equal(Date.parse(state.jobs[0].finishesAt) - now, Math.ceil(route.seconds * 10000 / (10000 + meal.heroSpeedBps)) * 1000);
    assert.equal(state.jobs[0].meal.speedBps, meal.heroSpeedBps);
    const builder = fresh(), target = catalog.buildings.find(building => building.id === "workshop").levels[0];
    builder.wallet.coins = target.cost.coins; builder.inventory = { ...target.cost.items, [meal.itemId]: 1 }; Object.assign(builder.buildings, target.requiredBuildings);
    apply(builder, "feed_builder", meal.itemId); apply(builder, "start_construction", "workshop");
    assert.equal(Date.parse(builder.jobs[0].finishesAt) - now, Math.ceil(target.seconds * 10000 / (10000 + meal.builderSpeedBps)) * 1000);
    assert.equal(builder.jobs[0].meal.speedBps, meal.builderSpeedBps);
    assert.equal(model.economyJobSchema.safeParse(builder.jobs[0]).success, true);
  }
  const state = fresh(); apply(state, "start_exploration", "forest");
  state.jobs[0].meal = { itemId: "hearty_fish", consumer: "hero", speedBps: 2500 };
  const previous = structuredClone(state.jobs[0]);
  assert.deepEqual(model.economyJobSchema.parse(previous), previous);
  assert.equal(model.economyJobSchema.safeParse({ ...previous, meal: { ...previous.meal, speedBps: 10001 } }).success, false);
  assert.throws(() => food.mealDuration(100, 10001), RangeError);
  const maximum = Number.MAX_SAFE_INTEGER;
  assert.equal(food.mealDuration(maximum, 10000), Number((BigInt(maximum) + 1n) / 2n));
});
