import assert from "node:assert/strict";
import test, { after, beforeEach } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root,
  resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false } });
const identities = await vite.ssrLoadModule("/lib/dev/api-store.ts");
const economy = await vite.ssrLoadModule("/lib/dev/economy-store.ts");
const { economyViewSchema, economyCatalog } = await vite.ssrLoadModule("/features/economy/domain/model.ts");
const { canPrepareTutorialHarvest } = await vite.ssrLoadModule("/features/economy/domain/tutorial-order.ts");
const { economyGardenCrop } = await vite.ssrLoadModule("/features/economy/integration/garden-collection.ts");
const { economyGardenGrowth } = await vite.ssrLoadModule("/features/world/state/economy/economy-garden-state.ts");
const { mapProductionGroups } = await vite.ssrLoadModule("/features/world/ui/hud/world-production-state.ts");
const now = Date.parse("2026-10-18T12:00:00Z");
const player = () => identities.createDevIdentity("Первый урожай", crypto.randomUUID());
const read = (p, at = now) => economy.getDevEconomy(p.token, at);
const row = p => { read(p); return globalThis.__zhivDevEconomyStore.profiles.get(p.me.user.publicId); };
const request = (p, action = "start_production", targetId = "grow_berries", extra = {}, at = now) => ({ requestId: crypto.randomUUID(),
  ownerPublicId: p.me.user.publicId, expectedRevision: read(p, at).revision, action, targetId, quantity: 1, totalPrice: 0, ...extra });
const send = (p, action, targetId, at = now) => economy.commandDevEconomy(p.token, request(p, action, targetId, {}, at), at).state;
beforeEach(() => { identities.resetDevStoreForTests(); economy.resetDevEconomyStoreForTests(); });
after(() => vite.close());

test("first raspberry is immediately ripe on the map but needs real collection and an accepted delivery", () => {
  const p = player(), before = read(p), started = send(p, "start_production", "grow_berries");
  const job = started.jobs[0], ripeAt = now + 1;
  assert.equal(Date.parse(job.finishesAt) - Date.parse(job.startedAt), 1);
  assert.equal(started.tutorialOrder.firstHarvestPrepared, true);
  assert.deepEqual(started.inventory, before.inventory); assert.deepEqual(started.wallet, before.wallet);
  assert.ok(economyViewSchema.safeParse(started).success);
  assert.equal(economyGardenGrowth(economyGardenCrop(started), ripeAt), 1);
  assert.equal(mapProductionGroups(started, ripeAt)[0].entries[0].phase, "awaiting-gather");
  assert.throws(() => send(p, "claim_job", job.id, ripeAt), { code: "ECONOMY_COLLECTION_REQUIRED" });
  send(p, "start_collection", job.id, ripeAt);
  assert.throws(() => send(p, "claim_job", job.id, ripeAt + 7999), { code: "ECONOMY_COLLECTION_NOT_READY" });
  const delivered = send(p, "claim_job", job.id, ripeAt + 8000);
  assert.equal(delivered.inventory.berries, 1); assert.equal(delivered.progression.recipes.grow_berries, 1);
  const next = send(p, "start_production", "grow_berries", ripeAt + 8001);
  assert.equal(Date.parse(next.jobs[0].finishesAt) - Date.parse(next.jobs[0].startedAt), 60_000);
});

test("same UUID replays and different UUIDs cannot renew the first aid or cancel it for another grant", () => {
  const p = player(), cmd = request(p), result = economy.commandDevEconomy(p.token, cmd, now), job = result.state.jobs[0];
  assert.equal(economy.commandDevEconomy(p.token, cmd, now + 1).replayed, true);
  assert.throws(() => economy.commandDevEconomy(p.token, { ...cmd, requestId: crypto.randomUUID() }, now + 1), { code: "ECONOMY_REVISION_CONFLICT" });
  assert.throws(() => send(p, "cancel_production", job.id, now + 1), { code: "ECONOMY_CANCEL_READY" });
  row(p).state = JSON.parse(JSON.stringify(row(p).state));
  assert.equal(canPrepareTutorialHarvest(read(p), "grow_berries"), false, "reload or a fresh local lesson cannot reopen server aid");
  assert.equal(read(p).jobs.length, 1);
  // A frozen server clock can still be in the positive first millisecond.
  // Cancelling there also consumes the help and refunds no spendable aid.
  const cancelled = send(p, "cancel_production", job.id, now);
  assert.equal(cancelled.jobs.length, 0); assert.equal(cancelled.tutorialOrder.firstHarvestPrepared, true);
  assert.deepEqual(cancelled.wallet, result.state.wallet); assert.deepEqual(cancelled.inventory, result.state.inventory);
  const next = send(p, "start_production", "grow_berries", now + 2);
  assert.equal(Date.parse(next.jobs[0].finishesAt) - Date.parse(next.jobs[0].startedAt), 60_000);
});

test("older progress, legacy terms, already owned fruit and other crops retain ordinary production", () => {
  const changes = [state => { state.tutorialOrder.completed = true; state.tutorialOrder.step = 1; },
    state => { state.tutorialOrder.version = 1; }, state => { state.tutorialOrder.terms.items = { berries: 3 }; },
    state => { state.inventory.berries = 1; }, state => { state.progression.recipes.grow_berries = 1; },
    state => { state.buildings.home = 2; }, state => { state.tutorialOrder.firstHarvestPrepared = true; }];
  for (const change of changes) {
    const p = player(); change(row(p).state);
    const started = send(p, "start_production", "grow_berries"), job = started.jobs[0];
    assert.equal(Date.parse(job.finishesAt) - Date.parse(job.startedAt), 60_000);
  }
  const p = player(), saved = row(p).state;
  saved.buildings.garden = 2; saved.buildings.home = 3;
  const started = send(p, "start_production", "grow_berries_large"), job = started.jobs[0];
  assert.equal(Date.parse(job.finishesAt) - Date.parse(job.startedAt), 45_000);
  assert.equal(started.tutorialOrder.firstHarvestPrepared, false);
});

test("malformed or refused starts never consume first-harvest help", () => {
  for (const extra of [{ targetId: "grow_berries@trout" }, { quantity: 2 }, { totalPrice: 1 }, { targetId: "unknown" }]) {
    const p = player(), before = read(p);
    assert.throws(() => economy.commandDevEconomy(p.token, request(p, "start_production", "grow_berries", extra), now));
    assert.deepEqual(read(p), before); assert.equal(canPrepareTutorialHarvest(read(p), "grow_berries"), true);
  }
  const p = player(), saved = row(p).state;
  saved.jobs = Array.from({ length: 18 }, (_, index) => ({ id: crypto.randomUUID(), kind: "production", targetId: "woodlot", recipeId: "make_wood",
    startedAt: new Date(now).toISOString(), finishesAt: new Date(now + index + 60_000).toISOString(), rewards: { wood: 1 }, cost: { coins: 0, items: {} }, catalogVersion: economyCatalog.version }));
  const before = read(p);
  assert.throws(() => send(p, "start_production", "grow_berries"), { code: "ECONOMY_JOBS_CAPACITY" });
  assert.deepEqual(read(p), before); assert.equal(before.tutorialOrder.firstHarvestPrepared, false);
});
