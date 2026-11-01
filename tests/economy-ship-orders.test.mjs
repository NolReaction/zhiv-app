import assert from "node:assert/strict";
import test, { after, beforeEach } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false } });
after(() => vite.close());
const model = await vite.ssrLoadModule("/features/economy/domain/model.ts");
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
function stock(state, order) { for (const [id, count] of Object.entries(order.items)) state.inventory[id] = (state.inventory[id] ?? 0) + count; }
function deliverAll(state) { for (const order of state.ship.voyage.orders) { stock(state, order); apply(state, "complete_ship_order", order.id); } }
function unchangedFailure(state, action, target, code, at = now, extra = {}) {
  const before = structuredClone(state);
  assert.throws(() => apply(state, action, target, at, extra), { code });
  assert.deepEqual(state, before);
}
beforeEach(() => identities.resetDevStoreForTests());

test("legacy accounts receive an empty port without creating orders on reads", () => {
  assert.deepEqual(ship.shipOrdersState({}), { voyage: null, nextAvailableAt: null, completedVoyages: 0 });
  const player = identities.createDevIdentity("Порт", crypto.randomUUID());
  const first = api.getDevEconomy(player.token, now), second = api.getDevEconomy(player.token, now + 1000);
  assert.deepEqual(first.ship, second.ship); assert.equal(first.ship.voyage, null);
  assert.equal(first.revision, second.revision);
  assert.equal(model.economyViewSchema.safeParse(first).success, true);
});

test("only a claimed lighthouse unlocks orders, not a pending construction or client target", () => {
  const state = fresh(); state.buildings.lighthouse = 0;
  state.jobs.push({ id: crypto.randomUUID(), kind: "construction", targetId: "lighthouse", targetLevel: 1,
    recipeId: null, startedAt: new Date(now - 5000).toISOString(), finishesAt: new Date(now - 1000).toISOString(), rewards: {}, cost: { coins: 0, items: {} }, catalogVersion: 15 });
  unchangedFailure(state, "open_ship_voyage", "port", "ECONOMY_SHIP_LOCKED");
  unchangedFailure(fresh(), "open_ship_voyage", "lighthouse", "INVALID_ECONOMY_COMMAND");
});

test("shared FNV selection freezes exactly three attainable personal cargoes at house three", () => {
  const state = fresh(); open(state);
  assert.deepEqual(state.ship.voyage.orders.map(order => [order.templateId, order.rewardCoins]),
    [["rigging", 1050], ["berry_provisions", 1554], ["sailmakers", 1575]]);
  assert.equal(state.ship.voyage.rewardPearls, 8);
  assert.equal(state.ship.nextAvailableAt, new Date(now + sixHours).toISOString());
  assert.equal(schema.economyShipSchema.safeParse(state.ship).success, true);
  assert.equal(new Set(state.ship.voyage.orders.map(order => order.id)).size, 3);
  const eligible = ship.eligibleShipTemplates(state);
  assert.ok(eligible.every(template => template.requiredHomeLevel <= 3));
  const changed = ship.createShipVoyage(state, now, "22222222-2222-4222-8222-222222222222");
  assert.notDeepEqual(changed.orders.map(order => order.templateId), state.ship.voyage.orders.map(order => order.templateId));
  unchangedFailure(state, "open_ship_voyage", "port", "ECONOMY_SHIP_ACTIVE", now + sixHours);
});

test("gifted advanced goods never unlock an unavailable production chain", () => {
  const state = fresh(); state.inventory.field_kit = 100; state.inventory.cranberry_glaze = 100;
  const eligible = ship.eligibleShipTemplates(state);
  assert.ok(!eligible.some(template => ["field_research", "festive_provisions"].includes(template.id)));
  state.buildings.home = 5; state.buildings.workshop = 4; state.buildings.quarry = 4;
  assert.ok(ship.eligibleShipTemplates(state).some(template => template.id === "field_research"));
});

test("personal selection mixes all three categories independently instead of repeating four linked sets", () => {
  const state = fresh(); state.buildings.dryer = 3; state.buildings.garden = 3;
  state.progression.recipes = Object.fromEntries(model.economyCatalog.recipes.map(recipe => [recipe.id, 100]));
  const combinations = new Set();
  for (let index = 0; index < 512; index++) {
    const id = `${index.toString(16).padStart(8, "0")}-1111-4111-8111-111111111111`;
    const voyage = ship.createShipVoyage(state, now, id);
    combinations.add(voyage.orders.map(order => order.templateId).join(":"));
  }
  assert.ok(combinations.size >= 55, `Expected most of 64 combinations, received ${combinations.size}`);
});

test("larger cargo earns a larger frozen pearl bonus with a strict ceiling", () => {
  const state = fresh();
  state.buildings = Object.fromEntries(model.economyCatalog.buildings.map(building => [building.id, building.levels.at(-1).level]));
  state.progression.recipes = Object.fromEntries(model.economyCatalog.recipes.map(recipe => [recipe.id, 100]));
  const bonuses = new Set();
  for (let index = 0; index < 96; index++) {
    const voyage = ship.createShipVoyage(state, now, `${index.toString(16).padStart(8, "0")}-1111-4111-8111-111111111111`);
    const value = voyage.orders.reduce((sum, order) => sum + Object.entries(order.items).reduce((subtotal, [id, count]) =>
      subtotal + model.economyCatalog.localBuyer.unitPrices[id] * count, 0), 0);
    assert.equal(voyage.rewardPearls, Math.max(8, Math.min(16, Math.ceil(value / 2000) * 2)));
    bonuses.add(voyage.rewardPearls);
  }
  assert.ok(bonuses.size >= 3); assert.ok(Math.max(...bonuses) > 8);
});

test("an incomplete settlement cannot create an impossible manifest or start a cooldown", () => {
  const state = fresh(); state.buildings.dryer = 0;
  unchangedFailure(state, "open_ship_voyage", "port", "ECONOMY_SHIP_UNAVAILABLE");
});

test("cargo is consumed as a whole and paid once; missing inventory and wallet cap preserve everything", () => {
  const state = fresh(); open(state); const order = state.ship.voyage.orders[0];
  unchangedFailure(state, "complete_ship_order", order.id, "ECONOMY_RESOURCES");
  stock(state, order); state.wallet.coins = model.ECONOMY_MAX_BALANCE;
  unchangedFailure(state, "complete_ship_order", order.id, "ECONOMY_CAPACITY");
  state.wallet.coins = 0; const before = { ...state.inventory };
  apply(state, "complete_ship_order", order.id);
  assert.equal(state.wallet.coins, order.rewardCoins);
  for (const [id, count] of Object.entries(order.items)) assert.equal(state.inventory[id] ?? 0, before[id] - count);
  assert.equal(state.ship.voyage.orders[0].deliveredAt, new Date(now).toISOString());
  unchangedFailure(state, "complete_ship_order", order.id, "ECONOMY_SHIP_CHANGED");
  unchangedFailure(state, "complete_ship_order", "22222222-2222-4222-8222-222222222222:0", "ECONOMY_SHIP_CHANGED");
});

test("saved cargo and rewards remain unchanged across catalog edits and a month offline", () => {
  const state = fresh(); open(state); const order = state.ship.voyage.orders[0]; stock(state, order);
  const template = ship.shipOrdersConfig.templates.find(entry => entry.id === order.templateId);
  const previous = structuredClone(template), payout = ship.shipOrdersConfig.payoutBps;
  try {
    template.items = { field_kit: 500 }; template.title = "Changed"; ship.shipOrdersConfig.payoutBps = 10000;
    const coins = state.wallet.coins;
    apply(state, "complete_ship_order", order.id, now + 30 * 86400000);
    assert.equal(state.wallet.coins, coins + order.rewardCoins);
    assert.equal(state.ship.voyage.orders[0].title, order.title);
    assert.deepEqual(state.ship.voyage.orders[0].items, order.items);
  } finally { Object.assign(template, previous); ship.shipOrdersConfig.payoutBps = payout; }
});

test("full bonus has a separate claim, never consumes stock or storage, and cannot be claimed twice", () => {
  const state = fresh(); open(state); const id = state.ship.voyage.id;
  unchangedFailure(state, "claim_ship_voyage", id, "ECONOMY_SHIP_INCOMPLETE");
  deliverAll(state);
  unchangedFailure(state, "skip_ship_voyage", id, "ECONOMY_SHIP_COMPLETE");
  state.wallet.pearls = model.ECONOMY_MAX_PEARLS;
  unchangedFailure(state, "claim_ship_voyage", id, "ECONOMY_CAPACITY");
  state.wallet.pearls = 0; state.inventory.wood = 1000;
  const inventory = structuredClone(state.inventory);
  apply(state, "claim_ship_voyage", id);
  assert.equal(state.wallet.pearls, 8); assert.equal(state.ship.completedVoyages, 1);
  assert.equal(state.ship.voyage, null); assert.deepEqual(state.inventory, inventory);
  unchangedFailure(state, "claim_ship_voyage", id, "ECONOMY_SHIP_CHANGED");
  unchangedFailure(state, "open_ship_voyage", "port", "ECONOMY_SHIP_WAIT", now + sixHours - 1);
  apply(state, "open_ship_voyage", "port", now + sixHours);
  assert.equal(state.ship.voyage.number, 2);
});

test("skipping a partial delivery keeps its payment and unused goods, but grants no bonus or free reroll", () => {
  const state = fresh(); open(state); const voyage = state.ship.voyage;
  stock(state, voyage.orders[0]); apply(state, "complete_ship_order", voyage.orders[0].id);
  stock(state, voyage.orders[1]); const wallet = { ...state.wallet }, inventory = { ...state.inventory };
  apply(state, "skip_ship_voyage", voyage.id);
  assert.deepEqual(state.wallet, wallet); assert.deepEqual(state.inventory, inventory);
  assert.equal(state.ship.completedVoyages, 0); assert.equal(state.ship.voyage, null);
  unchangedFailure(state, "open_ship_voyage", "port", "ECONOMY_SHIP_WAIT");
  unchangedFailure(state, "complete_ship_order", voyage.orders[1].id, "ECONOMY_SHIP_CHANGED");
});

test("ship actions reject client price, quantities and irrelevant fish selection", () => {
  for (const extra of [{ totalPrice: 1 }, { quantity: 2 }, { fishSelection: {} }]) {
    unchangedFailure(fresh(), "open_ship_voyage", "port", "INVALID_ECONOMY_COMMAND", now, extra);
  }
});

test("local API receipts survive lost responses; stale revisions and a foreign owner cannot pay twice", () => {
  const player = identities.createDevIdentity("Капитан", crypto.randomUUID());
  api.getDevEconomy(player.token, now);
  const row = globalThis.__zhivDevEconomyStore.profiles.get(player.me.user.publicId);
  row.state = fresh();
  const read = () => api.getDevEconomy(player.token, now);
  const payload = (action, targetId) => ({ ...command(action, targetId), ownerPublicId: player.me.user.publicId, expectedRevision: read().revision });
  const opened = api.commandDevEconomy(player.token, payload("open_ship_voyage", "port"), now);
  const order = opened.state.ship.voyage.orders[0]; stock(row.state, order);
  const delivery = payload("complete_ship_order", order.id), first = api.commandDevEconomy(player.token, delivery, now);
  const replay = api.commandDevEconomy(player.token, delivery, now + 1000);
  assert.equal(replay.replayed, true); assert.equal(replay.acceptedRevision, first.acceptedRevision);
  assert.deepEqual(replay.state.wallet, first.state.wallet);
  assert.throws(() => api.commandDevEconomy(player.token, { ...delivery, requestId: crypto.randomUUID() }, now), { code: "ECONOMY_REVISION_CONFLICT" });
  assert.throws(() => api.commandDevEconomy(player.token, payload("complete_ship_order", order.id), now), { code: "ECONOMY_SHIP_CHANGED" });
  assert.throws(() => api.commandDevEconomy(player.token, { ...payload("claim_ship_voyage", opened.state.ship.voyage.id), ownerPublicId: "0123-4567-89AB" }, now), { code: "ECONOMY_OWNER_CHANGED" });
  for (const remaining of row.state.ship.voyage.orders.filter(entry => !entry.deliveredAt)) {
    stock(row.state, remaining); api.commandDevEconomy(player.token, payload("complete_ship_order", remaining.id), now);
  }
  const claim = payload("claim_ship_voyage", opened.state.ship.voyage.id);
  const claimed = api.commandDevEconomy(player.token, claim, now);
  const retried = api.commandDevEconomy(player.token, claim, now + 1000);
  assert.equal(retried.replayed, true); assert.equal(retried.state.wallet.pearls, claimed.state.wallet.pearls);
  assert.equal(retried.state.ship.completedVoyages, 1);
});

test("a client request UUID cannot predetermine the server's personal manifest", () => {
  const player = identities.createDevIdentity("Серверный порт", crypto.randomUUID());
  const before = api.getDevEconomy(player.token, now);
  globalThis.__zhivDevEconomyStore.profiles.get(player.me.user.publicId).state = fresh();
  const input = { ...command("open_ship_voyage", "port"), ownerPublicId: player.me.user.publicId, expectedRevision: before.revision };
  const result = api.commandDevEconomy(player.token, input, now);
  assert.notEqual(result.state.ship.voyage.id, input.requestId);
});
