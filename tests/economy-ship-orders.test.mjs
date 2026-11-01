import assert from "node:assert/strict";
import test, { after, beforeEach } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false } });
after(() => vite.close());
const model = await vite.ssrLoadModule("/features/economy/domain/model.ts");
const money = await vite.ssrLoadModule("/features/economy/domain/money.ts");
const ship = await vite.ssrLoadModule("/features/economy/domain/ship-orders.ts");
const schema = await vite.ssrLoadModule("/features/economy/domain/ship-model.ts");
const rules = await vite.ssrLoadModule("/features/economy/domain/rules.ts");
const identities = await vite.ssrLoadModule("/lib/dev/api-store.ts");
const api = await vite.ssrLoadModule("/lib/dev/economy-store.ts");
const now = Date.parse("2026-11-01T10:00:00Z");
const voyageId = "11111111-1111-4111-8111-111111111111";
const sixHours = 21600000;
function fresh() {
  const state = rules.newEconomyState({ resources: { sparks: 0, wood: 0, stone: 0 }, houseLevel: 3, workshopLevel: 3 });
  Object.assign(state.buildings, { bridge: 1, lighthouse: 1, kiln: 3, woodlot: 3, quarry: 3, dryer: 1 });
  return state;
}
const command = (action, targetId) => ({ action, targetId, requestId: crypto.randomUUID(), ownerPublicId: "0123-4567-89AB", expectedRevision: 0, quantity: 1, totalPrice: 0 });
const apply = (state, action, targetId, at = now, extra = {}) => rules.applyEconomyCommand(state, { ...command(action, targetId), ...extra }, at, () => voyageId);
const open = state => apply(state, "open_ship_voyage", "port");
function load(state, order, itemId, quantity, at = now, extra = {}) {
  return apply(state, "load_ship_cargo", order.id, at, { voyageId: state.ship.voyage.id, orderId: order.id, itemId, quantity, ...extra });
}
function stock(state, order) { for (const [id, count] of Object.entries(order.items)) state.inventory[id] = (state.inventory[id] ?? 0) + count; }
function unchangedFailure(state, action, target, code, at = now, extra = {}) {
  const before = structuredClone(state);
  assert.throws(() => apply(state, action, target, at, extra), { code });
  assert.deepEqual(state, before);
}
beforeEach(() => identities.resetDevStoreForTests());

test("legacy accounts read empty state without silently creating commands", () => {
  assert.deepEqual(ship.shipOrdersState({}), { voyage: null, nextAvailableAt: null, completedVoyages: 0 });
  const player = identities.createDevIdentity("Корабль", crypto.randomUUID());
  const first = api.getDevEconomy(player.token, now), second = api.getDevEconomy(player.token, now + 1000);
  assert.deepEqual(first.ship, second.ship); assert.equal(first.revision, second.revision);
  assert.equal(model.economyViewSchema.safeParse(first).success, true);
});

test("only a claimed lighthouse unlocks orders", () => {
  const state = fresh(); state.buildings.lighthouse = 0;
  state.jobs.push({ id: crypto.randomUUID(), kind: "construction", targetId: "lighthouse", targetLevel: 1,
    recipeId: null, startedAt: new Date(now - 5000).toISOString(), finishesAt: new Date(now - 1000).toISOString(), rewards: {}, cost: { coins: 0, items: {} }, catalogVersion: 15 });
  unchangedFailure(state, "open_ship_voyage", "port", "ECONOMY_SHIP_LOCKED");
  unchangedFailure(fresh(), "open_ship_voyage", "lighthouse", "INVALID_ECONOMY_COMMAND");
});

test("manifest contains one obtainable cargo per difficulty, ten visible pearls and no departure countdown", () => {
  const state = fresh(); open(state);
  assert.deepEqual(state.ship.voyage.orders.map(order => order.difficulty), ["easy", "medium", "hard"]);
  assert.equal(state.ship.voyage.rewardPearls, 20);
  assert.equal(money.formatPearls(state.ship.voyage.rewardPearls), "10");
  assert.equal(state.ship.nextAvailableAt, null);
  assert.equal(schema.economyShipSchema.safeParse(state.ship).success, true);
  assert.equal(new Set(state.ship.voyage.orders.map(order => order.id)).size, 3);
  for (const order of state.ship.voyage.orders) assert.deepEqual(order.loadedItems, {});
  unchangedFailure(state, "open_ship_voyage", "port", "ECONOMY_SHIP_ACTIVE", now + sixHours);
});

test("gifted advanced goods do not unlock inaccessible cargo or rewards", () => {
  const state = fresh(); state.inventory.field_kit = 100; state.inventory.cranberry_glaze = 100;
  assert.ok(!ship.eligibleShipTemplates(state).some(template => ["field_research", "festive_provisions"].includes(template.id)));
  const config = structuredClone(ship.shipOrdersConfig);
  config.templates[0].rewardItems = { field_kit: 1 };
  assert.ok(!ship.eligibleShipTemplates(state, model.economyCatalog, config).some(template => template.id === config.templates[0].id));
});

test("difficulty selection varies across voyages and maintains attainable ingredient chains", () => {
  const state = fresh(); state.buildings.dryer = 3; state.buildings.garden = 3;
  state.progression.recipes = Object.fromEntries(model.economyCatalog.recipes.map(recipe => [recipe.id, 100]));
  const combinations = new Set();
  for (let index = 0; index < 128; index++) {
    const id = `${index.toString(16).padStart(8, "0")}-1111-4111-8111-111111111111`;
    const voyage = ship.createShipVoyage(state, now, id);
    assert.deepEqual(voyage.orders.map(order => order.difficulty), ["easy", "medium", "hard"]);
    assert.equal(voyage.rewardPearls, 20);
    combinations.add(voyage.orders.map(order => order.templateId).join(":"));
  }
  assert.ok(combinations.size > 15);
});

test("an incomplete settlement cannot create an impossible manifest", () => {
  const state = fresh(); state.buildings = { home: 3, lighthouse: 1, warehouse: 1 };
  unchangedFailure(state, "open_ship_voyage", "port", "ECONOMY_SHIP_UNAVAILABLE");
});

test("loading one item preserves progress across serialization and pays only after the full cargo", () => {
  const state = fresh(); open(state); const order = state.ship.voyage.orders[0];
  const [itemId, count] = Object.entries(order.items)[0];
  state.inventory[itemId] = count;
  const coins = state.wallet.coins;
  load(state, order, itemId, 1);
  assert.equal(state.inventory[itemId], count - 1);
  assert.equal(state.ship.voyage.orders[0].loadedItems[itemId], 1);
  assert.equal(state.wallet.coins, coins);
  state.ship = schema.economyShipSchema.parse(JSON.parse(JSON.stringify(state.ship)));
  assert.equal(state.ship.voyage.orders[0].loadedItems[itemId], 1);
  if (count > 1) load(state, order, itemId, count - 1);
  for (const [id, quantity] of Object.entries(order.items).slice(1)) { state.inventory[id] = quantity; load(state, order, id, quantity); }
  assert.equal(state.wallet.coins, coins + order.rewardCoins);
  assert.equal(state.ship.voyage.orders[0].deliveredAt, new Date(now).toISOString());
  unchangedFailure(state, "complete_ship_order", order.id, "ECONOMY_SHIP_CHANGED");
});

test("invalid or excessive cargo and a stale voyage leave inventory and progress unchanged", () => {
  const state = fresh(); open(state); const order = state.ship.voyage.orders[0]; stock(state, order);
  const [itemId, amount] = Object.entries(order.items)[0];
  const base = { voyageId: state.ship.voyage.id, orderId: order.id, itemId };
  for (const quantity of [0, -1, 0.5, amount + 1, 10001])
    unchangedFailure(state, "load_ship_cargo", order.id, "INVALID_ECONOMY_COMMAND", now, { ...base, quantity });
  unchangedFailure(state, "load_ship_cargo", order.id, "INVALID_ECONOMY_COMMAND", now, { ...base, itemId: "field_kit" });
  unchangedFailure(state, "load_ship_cargo", order.id, "ECONOMY_SHIP_CHANGED", now, { ...base, voyageId: crypto.randomUUID() });
  delete state.inventory[itemId];
  unchangedFailure(state, "load_ship_cargo", order.id, "ECONOMY_RESOURCES", now, base);
});

test("optional gifts are frozen, credited once and do not require a separate claim", () => {
  const state = fresh(); open(state);
  const order = state.ship.voyage.orders[1]; order.rewardItems = { planks: 2 };
  stock(state, order); const before = state.inventory.planks ?? 0;
  apply(state, "complete_ship_order", order.id);
  assert.equal(state.inventory.planks, before - (order.items.planks ?? 0) + 2);
  unchangedFailure(state, "complete_ship_order", order.id, "ECONOMY_SHIP_CHANGED");
});

test("wallet and reward storage limits are atomic for the final loading operation", () => {
  const state = fresh(); open(state); const order = state.ship.voyage.orders[0]; stock(state, order);
  state.wallet.coins = model.ECONOMY_MAX_BALANCE;
  unchangedFailure(state, "complete_ship_order", order.id, "ECONOMY_CAPACITY");
  state.wallet.coins = 0;
  order.rewardItems = { stone: model.ECONOMY_MAX_ITEMS };
  state.inventory.stone = 1;
  unchangedFailure(state, "complete_ship_order", order.id, "ECONOMY_CAPACITY");
});

test("last cargo at 5h55 grants ten visible pearls and starts a fresh six hour return time", () => {
  const state = fresh(); open(state); const voyage = state.ship.voyage;
  const pearls = state.wallet.pearls;
  const completedAt = now + sixHours - 5 * 60000;
  for (const order of voyage.orders.slice(0, 2)) { stock(state, order); apply(state, "complete_ship_order", order.id); }
  const last = voyage.orders[2]; stock(state, last);
  const entries = Object.entries(last.items);
  for (const [id, amount] of entries.slice(0, -1)) load(state, last, id, amount, completedAt);
  const [itemId, quantity] = entries.at(-1);
  state.wallet.pearls = model.ECONOMY_MAX_PEARLS;
  unchangedFailure(state, "load_ship_cargo", last.id, "ECONOMY_CAPACITY", completedAt,
    { voyageId: voyage.id, orderId: last.id, itemId, quantity });
  state.wallet.pearls = pearls;
  load(state, last, itemId, quantity, completedAt);
  assert.equal(state.wallet.pearls, pearls + 20); assert.equal(state.ship.completedVoyages, 1); assert.equal(state.ship.voyage, null);
  assert.equal(state.ship.nextAvailableAt, new Date(completedAt + sixHours).toISOString());
  unchangedFailure(state, "claim_ship_voyage", voyage.id, "ECONOMY_SHIP_CHANGED");
  unchangedFailure(state, "open_ship_voyage", "port", "ECONOMY_SHIP_WAIT", now + sixHours);
  unchangedFailure(state, "open_ship_voyage", "port", "ECONOMY_SHIP_WAIT", completedAt + sixHours - 1);
  apply(state, "open_ship_voyage", "port", completedAt + sixHours);
  assert.equal(state.ship.voyage.number, 2); assert.equal(state.ship.nextAvailableAt, null);
});

test("abandoning either an untouched or partially loaded ship is forbidden", () => {
  const state = fresh(); open(state);
  unchangedFailure(state, "skip_ship_voyage", state.ship.voyage.id, "ECONOMY_SHIP_CANNOT_SKIP");
  const order = state.ship.voyage.orders[0], item = Object.keys(order.items)[0]; state.inventory[item] = 1; load(state, order, item, 1);
  unchangedFailure(state, "skip_ship_voyage", state.ship.voyage.id, "ECONOMY_SHIP_CANNOT_SKIP");
});

test("old saved completed voyages settle once for ten visible pearls and a new cooldown", () => {
  const state = fresh(); open(state); const id = state.ship.voyage.id;
  state.ship.voyage.rewardPearls = 8;
  for (const order of state.ship.voyage.orders) {
    order.deliveredAt = new Date(now).toISOString(); delete order.loadedItems; delete order.difficulty; delete order.rewardItems;
  }
  const normalized = ship.shipOrdersState(state);
  assert.equal(normalized.voyage.rewardPearls, 20);
  assert.deepEqual(normalized.voyage.orders[0].loadedItems, normalized.voyage.orders[0].items);
  const pearls = state.wallet.pearls;
  apply(state, "claim_ship_voyage", id, now + sixHours);
  assert.equal(state.wallet.pearls, pearls + 20);
  assert.equal(state.ship.nextAvailableAt, new Date(now + 2 * sixHours).toISOString());
  unchangedFailure(state, "claim_ship_voyage", id, "ECONOMY_SHIP_CHANGED");
});

test("ship actions reject irrelevant prices, fields and fish selection", () => {
  for (const extra of [{ totalPrice: 1 }, { quantity: 2 }, { fishSelection: {} }, { itemId: "rope" }])
    unchangedFailure(fresh(), "open_ship_voyage", "port", "INVALID_ECONOMY_COMMAND", now, extra);
});

test("local API partial-load receipts survive lost responses without double consumption or rewards", () => {
  const player = identities.createDevIdentity("Капитан", crypto.randomUUID());
  api.getDevEconomy(player.token, now);
  const row = globalThis.__zhivDevEconomyStore.profiles.get(player.me.user.publicId); row.state = fresh();
  const read = () => api.getDevEconomy(player.token, now);
  const payload = (action, targetId, extra = {}) => ({ ...command(action, targetId), ownerPublicId: player.me.user.publicId, expectedRevision: read().revision, ...extra });
  const opened = api.commandDevEconomy(player.token, payload("open_ship_voyage", "port"), now);
  const order = opened.state.ship.voyage.orders[0], itemId = Object.keys(order.items)[0]; stock(row.state, order);
  const delivery = payload("load_ship_cargo", order.id, { voyageId: opened.state.ship.voyage.id, orderId: order.id, itemId, quantity: 1 });
  const first = api.commandDevEconomy(player.token, delivery, now), replay = api.commandDevEconomy(player.token, delivery, now + 1000);
  assert.equal(replay.replayed, true); assert.equal(replay.acceptedRevision, first.acceptedRevision);
  assert.deepEqual(replay.state.inventory, first.state.inventory); assert.deepEqual(replay.state.ship, first.state.ship);
  for (const changed of [{ itemId: "another-item" }, { voyageId: crypto.randomUUID() }, { orderId: `${delivery.voyageId}:2` }])
    assert.throws(() => api.commandDevEconomy(player.token, { ...delivery, ...changed }, now), { code: "ECONOMY_REQUEST_CONFLICT" });
  assert.throws(() => api.commandDevEconomy(player.token, { ...delivery, requestId: crypto.randomUUID() }, now), { code: "ECONOMY_REVISION_CONFLICT" });
  assert.throws(() => api.commandDevEconomy(player.token, { ...delivery, requestId: crypto.randomUUID(), ownerPublicId: "0123-4567-89AB" }, now), { code: "ECONOMY_OWNER_CHANGED" });
});

test("a request UUID cannot predetermine the server's manifest", () => {
  const player = identities.createDevIdentity("Корабль", crypto.randomUUID());
  const before = api.getDevEconomy(player.token, now);
  globalThis.__zhivDevEconomyStore.profiles.get(player.me.user.publicId).state = fresh();
  const input = { ...command("open_ship_voyage", "port"), ownerPublicId: player.me.user.publicId, expectedRevision: before.revision };
  assert.notEqual(api.commandDevEconomy(player.token, input, now).state.ship.voyage.id, input.requestId);
});

test("the final partial-load receipt replays the departure and pearl reward exactly once", () => {
  const player = identities.createDevIdentity("Последний груз", crypto.randomUUID());
  api.getDevEconomy(player.token, now);
  const row = globalThis.__zhivDevEconomyStore.profiles.get(player.me.user.publicId); row.state = fresh();
  const payload = (action, targetId, extra = {}) => ({ ...command(action, targetId), ownerPublicId: player.me.user.publicId,
    expectedRevision: api.getDevEconomy(player.token, now).revision, ...extra });
  api.commandDevEconomy(player.token, payload("open_ship_voyage", "port"), now);
  const voyage = row.state.ship.voyage;
  for (const order of voyage.orders.slice(0, 2)) {
    stock(row.state, order); api.commandDevEconomy(player.token, payload("complete_ship_order", order.id), now);
  }
  const order = voyage.orders[2]; stock(row.state, order);
  const entries = Object.entries(order.items);
  for (const [itemId, quantity] of entries.slice(0, -1))
    api.commandDevEconomy(player.token, payload("load_ship_cargo", order.id, { voyageId: voyage.id, orderId: order.id, itemId, quantity }), now);
  const [itemId, quantity] = entries.at(-1);
  const delivery = payload("load_ship_cargo", order.id, { voyageId: voyage.id, orderId: order.id, itemId, quantity });
  const first = api.commandDevEconomy(player.token, delivery, now), replay = api.commandDevEconomy(player.token, delivery, now + 1000);
  assert.equal(first.state.ship.voyage, null); assert.equal(first.state.ship.completedVoyages, 1);
  assert.equal(replay.replayed, true); assert.deepEqual(replay.state.wallet, first.state.wallet);
  assert.deepEqual(replay.state.inventory, first.state.inventory); assert.deepEqual(replay.state.ship, first.state.ship);
});
