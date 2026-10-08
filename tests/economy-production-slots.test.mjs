import assert from "node:assert/strict";
import test, { after, beforeEach } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false } });
const identities = await vite.ssrLoadModule("/lib/dev/api-store.ts");
const economy = await vite.ssrLoadModule("/lib/dev/economy-store.ts");
const model = await vite.ssrLoadModule("/features/economy/domain/model.ts");
const slots = await vite.ssrLoadModule("/features/economy/domain/production-slots.ts");
const now = Date.parse("2026-10-06T00:00:00Z");
beforeEach(() => { identities.resetDevStoreForTests(); economy.resetDevEconomyStoreForTests(); });
after(() => vite.close());
function player(home = 4, pearls = 50_000) {
  const p = identities.createDevIdentity("Мастер", crypto.randomUUID());
  economy.getDevEconomy(p.token, now);
  p.row = globalThis.__zhivDevEconomyStore.profiles.get(p.me.user.publicId);
  Object.assign(p.row.state, {
    wallet: { coins: 100_000, pearls }, inventory: { wood: 50, fiber: 40, stone: 20 },
    buildings: { home, garden: 1, woodlot: 1, workshop: 1, kiln: 1, dryer: 1, warehouse: 5, quarry: 1 },
  });
  return p;
}
const read = (p, time = now) => economy.getDevEconomy(p.token, time);
const command = (p, action, targetId, extra = {}, time = now) => ({ requestId: crypto.randomUUID(), ownerPublicId: p.me.user.publicId,
  expectedRevision: read(p, time).revision, action, targetId, quantity: 1, totalPrice: 0, ...extra });
const issue = (p, action, target, time = now) => economy.commandDevEconomy(p.token, command(p, action, target, {}, time), time);

test("old saves and snapshots default to one slot and expose only the five real production stations", () => {
  const p = player(); const view = read(p);
  assert.deepEqual(view.productionSlots, {});
  const oldView = { ...view };
  delete oldView.productionSlots;
  assert.deepEqual(model.economyViewSchema.parse(oldView).productionSlots, {});
  const expected = ["dryer", "garden", "kiln", "woodlot", "workshop"];
  assert.deepEqual(model.economyCatalog.buildings.filter(b => slots.productionStationSupported(b.id)).map(b => b.id).sort(), expected);
  for (const station of expected) {
    assert.equal(slots.productionSlotCount({}, station), 1);
    assert.deepEqual(slots.productionSlotOffer({}, station), { slots: 2, requiredHomeLevel: 2, pricePearls: 1500 });
  }
  for (const station of ["quarry", "home", "warehouse", "unknown"]) assert.equal(slots.productionSlotOffer({}, station), null);
  assert.equal(slots.productionSlotCount({ productionSlots: { workshop: 999 } }, "workshop"), 3);
});

test("slot purchase follows house gates, debits pearls only and persists independently per station", () => {
  const p = player(1); const before = read(p);
  assert.throws(() => issue(p, "buy_production_slot", "workshop"), { code: "ECONOMY_HOME_REQUIRED" });
  assert.deepEqual(read(p), before);
  p.row.state.buildings.home = 2;
  const second = issue(p, "buy_production_slot", "workshop").state;
  assert.deepEqual(second.productionSlots, { workshop: 2 });
  assert.deepEqual(second.wallet, { coins: 100_000, pearls: 48_500 });
  assert.deepEqual(second.inventory, before.inventory);
  assert.throws(() => issue(p, "buy_production_slot", "workshop"), { code: "ECONOMY_HOME_REQUIRED" });
  p.row.state.buildings.home = 4;
  const third = issue(p, "buy_production_slot", "workshop").state;
  assert.equal(third.productionSlots.workshop, 3); assert.equal(third.wallet.pearls, 43_500);
  assert.equal(slots.productionSlotCount(third, "kiln"), 1);
  assert.throws(() => issue(p, "buy_production_slot", "workshop"), { code: "ECONOMY_PRODUCTION_SLOTS_MAX" });
  assert.equal(slots.productionSlotOffer(third, "workshop"), null);
});

test("invalid stations, missing buildings, insufficient pearls and forged batch or price cannot buy capacity", () => {
  const p = player(4, 1499);
  for (const station of ["quarry", "home", "warehouse", "unknown"]) {
    const before = read(p);
    assert.throws(() => issue(p, "buy_production_slot", station), { code: "ECONOMY_PRODUCTION_STATION" });
    assert.deepEqual(read(p), before);
  }
  assert.throws(() => issue(p, "buy_production_slot", "workshop"), { code: "ECONOMY_PEARLS" });
  p.row.state.buildings.dryer = 0;
  assert.throws(() => issue(p, "buy_production_slot", "dryer"), { code: "ECONOMY_BUILDING_REQUIRED" });
  for (const extra of [{ quantity: 2 }, { totalPrice: 1 }, { totalPrice: 1500 }]) {
    const before = read(p);
    assert.throws(() => economy.commandDevEconomy(p.token, command(p, "buy_production_slot", "workshop", extra), now), { code: "INVALID_ECONOMY_COMMAND" });
    assert.deepEqual(read(p), before);
  }
});

test("receipt replay spends once while stale revisions and cross-account commands cannot buy another tier", () => {
  const p = player(), stranger = player();
  const buy = command(p, "buy_production_slot", "workshop");
  const first = economy.commandDevEconomy(p.token, buy, now);
  const replay = economy.commandDevEconomy(p.token, buy, now);
  assert.equal(replay.replayed, true); assert.deepEqual(replay.state, first.state);
  assert.throws(() => economy.commandDevEconomy(p.token, { ...buy, requestId: crypto.randomUUID() }, now), { code: "ECONOMY_REVISION_CONFLICT" });
  assert.throws(() => economy.commandDevEconomy(stranger.token, buy, now), { code: "ECONOMY_OWNER_CHANGED" });
  assert.throws(() => economy.commandDevEconomy(p.token, { ...buy, targetId: "kiln" }, now), { code: "ECONOMY_REQUEST_CONFLICT" });
  assert.equal(read(p).wallet.pearls, 48_500);
});

test("three slots run distinct or repeated recipes in parallel and only a successful claim frees capacity", () => {
  const p = player(); issue(p, "buy_production_slot", "workshop"); issue(p, "buy_production_slot", "workshop");
  issue(p, "start_production", "make_planks"); issue(p, "start_production", "make_rope");
  const full = issue(p, "start_production", "make_planks").state;
  assert.equal(full.jobs.length, 3);
  assert.equal(new Set(full.jobs.map(j => j.startedAt)).size, 1);
  assert.equal(new Set(full.jobs.map(j => j.id)).size, 3);
  const ready = Math.max(...full.jobs.map(j => Date.parse(j.finishesAt)));
  assert.throws(() => issue(p, "start_production", "make_rope", ready), { code: "ECONOMY_BUILDING_BUSY" });
  const emptyMaterials = { ...p.row.state.inventory };
  p.row.state.inventory = { stone: full.storage.capacity };
  assert.throws(() => issue(p, "claim_job", full.jobs[0].id, ready), { code: "ECONOMY_STORAGE_FULL" });
  assert.equal(read(p, ready).jobs.length, 3);
  p.row.state.inventory = emptyMaterials;
  issue(p, "claim_job", full.jobs[0].id, ready);
  assert.equal(issue(p, "start_production", "make_rope", ready).state.jobs.length, 3);
});

test("construction blocks production and slot purchases while live production still blocks upgrading", () => {
  const p = player(); issue(p, "buy_production_slot", "workshop");
  Object.assign(p.row.state.buildings, { woodlot: 2, kiln: 2 });
  issue(p, "start_production", "make_planks");
  assert.throws(() => issue(p, "start_construction", "workshop"), { code: "ECONOMY_BUILDING_BUSY" });
  p.row.state.jobs = [{ ...p.row.state.jobs[0], kind: "construction", recipeId: null, targetLevel: 2, rewards: {} }];
  const before = read(p);
  assert.throws(() => issue(p, "start_production", "make_rope"), { code: "ECONOMY_BUILDING_BUSY" });
  assert.throws(() => issue(p, "buy_production_slot", "workshop"), { code: "ECONOMY_BUILDING_BUSY" });
  assert.deepEqual(read(p), before);
});

test("several growing crops still share one collecting hero and quarry expeditions never gain extra actors", () => {
  const p = player(); issue(p, "buy_production_slot", "garden");
  issue(p, "start_production", "grow_berries");
  const growing = issue(p, "start_production", "grow_berries").state;
  const ripe = Math.max(...growing.jobs.map(j => Date.parse(j.finishesAt)));
  const first = issue(p, "start_collection", growing.jobs[0].id, ripe).state.jobs[0];
  assert.throws(() => issue(p, "start_collection", growing.jobs[1].id, ripe), { code: "ECONOMY_COLLECTOR_BUSY" });
  assert.throws(() => issue(p, "start_exploration", "cave", ripe), { code: "ECONOMY_COLLECTOR_BUSY" });
  const done = Date.parse(first.collection.finishesAt);
  issue(p, "claim_job", first.id, done);
  assert.ok(issue(p, "start_collection", growing.jobs[1].id, done).state.jobs[0].collection.startedAt);
});
