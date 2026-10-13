import assert from "node:assert/strict";
import test, { after, beforeEach } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, resolve: { alias: { "@": root } },
  server: { middlewareMode: true, hmr: false, ws: false } });
const identities = await vite.ssrLoadModule("/lib/dev/api-store.ts");
const economy = await vite.ssrLoadModule("/lib/dev/economy-store.ts");
const model = await vite.ssrLoadModule("/features/economy/domain/model.ts");
const starter = await vite.ssrLoadModule("/features/economy/domain/workshop-starter.ts");
const now = Date.parse("2026-10-13T20:00:00Z");
beforeEach(() => { identities.resetDevStoreForTests(); economy.resetDevEconomyStoreForTests(); });
after(() => vite.close());
const player = () => identities.createDevIdentity("Ученик", crypto.randomUUID());
const read = (p, at = now) => economy.getDevEconomy(p.token, at);
const command = (p, overrides = {}) => ({ requestId: crypto.randomUUID(), ownerPublicId: p.me.user.publicId,
  expectedRevision: read(p).revision, action: "claim_workshop_starter", targetId: "workshop", quantity: 1, totalPrice: 0, ...overrides });
const issue = (p, overrides = {}, at = now) => economy.commandDevEconomy(p.token, command(p, overrides), at);
const row = p => { read(p); return globalThis.__zhivDevEconomyStore.profiles.get(p.me.user.publicId); };

test("historical workshop quote follows the current construction cost and cannot mutate the catalog", () => {
  const catalog = structuredClone(model.economyCatalog);
  const level = catalog.buildings.find(building => building.id === "workshop").levels.find(level => level.level === 1);
  assert.deepEqual(starter.workshopStarterCost(), { coins: 60, items: { wood: 2, stone: 1 } });
  level.cost = { coins: 70, items: { wood: 3, stone: 2 } };
  const quote = starter.workshopStarterCost(catalog); assert.deepEqual(quote, level.cost);
  quote.items.wood = 999; assert.equal(level.cost.items.wood, 3);
});

test("new and legacy accounts cannot receive another free workshop budget at any completion marker", () => {
  for (const marker of [false, true, undefined]) {
    const p = player(), saved = row(p); saved.state.workshopStarterClaimed = marker;
    saved.state.wallet = { coins: 350, pearls: 7 }; saved.state.inventory = { wood: 2, berries: 4 };
    const before = read(p), rejected = command(p);
    assert.equal(starter.canClaimWorkshopStarter(before), false);
    assert.throws(() => economy.commandDevEconomy(p.token, rejected, now), { code: "ECONOMY_WORKSHOP_STARTER_UNAVAILABLE" });
    assert.deepEqual(read(p), before); assert.equal(saved.receipts.has(rejected.requestId), false);
    assert.throws(() => issue(p), { code: "ECONOMY_WORKSHOP_STARTER_UNAVAILABLE" }); assert.deepEqual(read(p), before);
  }
});

test("saved funded workshop jobs keep their paid cost and timing without granting or charging again", () => {
  const p = player(), saved = row(p);
  saved.state.workshopStarterClaimed = true;
  saved.state.wallet = { coins: 350, pearls: 7 }; saved.state.inventory = { wood: 2, berries: 4 };
  const oldCost = { coins: 1200, items: { wood: 10, stone: 8 } };
  const job = model.economyJobSchema.parse({ id: crypto.randomUUID(), kind: "construction", targetId: "workshop", recipeId: null,
    targetLevel: 1, startedAt: new Date(now).toISOString(), finishesAt: new Date(now + 1200 * 1000).toISOString(),
    rewards: {}, cost: oldCost, catalogVersion: 5 }); saved.state.jobs = [job];
  const before = read(p); assert.deepEqual(before.jobs[0].cost, oldCost);
  assert.throws(() => issue(p), { code: "ECONOMY_WORKSHOP_STARTER_UNAVAILABLE" });
  assert.throws(() => issue(p, { action: "claim_job", targetId: job.id }), { code: "ECONOMY_JOB_NOT_READY" });
  const cmd = command(p, { action: "claim_job", targetId: job.id }), end = Date.parse(job.finishesAt);
  const complete = economy.commandDevEconomy(p.token, cmd, end).state;
  assert.equal(complete.buildings.workshop, 1); assert.equal(complete.workshopStarterClaimed, true);
  assert.deepEqual(complete.wallet, before.wallet); assert.deepEqual(complete.inventory, before.inventory);
  assert.equal(economy.commandDevEconomy(p.token, cmd, end).replayed, true); assert.deepEqual(read(p, end), complete);
});

test("old persisted markers and API snapshots remain readable without re-enabling the gift", () => {
  const p = player(), saved = row(p); delete saved.state.workshopStarterClaimed;
  const old = read(p); assert.equal(old.workshopStarterClaimed, false); delete old.workshopStarterClaimed;
  assert.equal(model.economyViewSchema.parse(old).workshopStarterClaimed, false);
  assert.equal(starter.canClaimWorkshopStarter(old), false);
  assert.throws(() => issue(p), { code: "ECONOMY_WORKSHOP_STARTER_UNAVAILABLE" });
});

test("the obsolete command still validates its workshop target, single quantity and zero supplied price", () => {
  const p = player(), before = read(p);
  for (const overrides of [{ targetId: "home" }, { quantity: 2 }, { totalPrice: 1 }]) {
    assert.throws(() => issue(p, overrides), { code: "INVALID_ECONOMY_COMMAND" }); assert.deepEqual(read(p), before);
  }
});

test("full inventory and capped wallets remain intact when obsolete starter commands are rejected", () => {
  const p = player(), saved = row(p); saved.state.wallet.coins = model.ECONOMY_MAX_BALANCE;
  saved.state.inventory = { wood: model.ECONOMY_MAX_ITEMS }; const before = read(p);
  assert.throws(() => issue(p), { code: "ECONOMY_WORKSHOP_STARTER_UNAVAILABLE" }); assert.deepEqual(read(p), before);
});
