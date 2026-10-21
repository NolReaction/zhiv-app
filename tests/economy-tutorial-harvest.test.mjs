import assert from "node:assert/strict";
import test, { after, beforeEach } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root,
  resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false } });
after(() => vite.close());
const identity = await vite.ssrLoadModule("/lib/dev/api-store.ts");
const api = await vite.ssrLoadModule("/lib/dev/economy-store.ts");
const { economyCatalog } = await vite.ssrLoadModule("/features/economy/domain/model.ts");
const { canPrepareTutorialHarvest } = await vite.ssrLoadModule("/features/economy/domain/tutorial-order.ts");
const { transitionWorldOnboarding } = await vite.ssrLoadModule("/features/world/domain/world-onboarding.ts");
const now = Date.parse("2026-10-21T12:00:00Z"), seconds = economyCatalog.recipes.find(recipe => recipe.id === "grow_berries").seconds;
beforeEach(() => { identity.resetDevStoreForTests(); api.resetDevEconomyStoreForTests(); });
const player = () => identity.createDevIdentity("Ученик", crypto.randomUUID());
const read = (p, at = now) => api.getDevEconomy(p.token, at);
const row = p => globalThis.__zhivDevEconomyStore.profiles.get(p.me.user.publicId);
const request = (p, action, targetId = "grow_berries", at = now, extra = {}) => ({ requestId: crypto.randomUUID(),
  ownerPublicId: p.me.user.publicId, expectedRevision: read(p, at).revision, action, targetId, quantity: 1, totalPrice: 0, ...extra });
const send = (p, action, targetId = "grow_berries", at = now, extra) => api.commandDevEconomy(p.token, request(p, action, targetId, at, extra), at);
const interval = job => Date.parse(job.finishesAt) - Date.parse(job.startedAt);
const reload = p => { row(p).state = JSON.parse(JSON.stringify(row(p).state)); };

test("ordinary raspberry production has the catalog timer before, during and after a paused or skipped lesson", () => {
  const p = player(), before = read(p);
  assert.equal(canPrepareTutorialHarvest(before, "grow_berries"), true);
  const ordinary = send(p, "start_production").state;
  assert.equal(interval(ordinary.jobs[0]), seconds * 1000);
  assert.equal(ordinary.tutorialOrder.firstHarvestPrepared, false);
  const job = ordinary.jobs[0];
  send(p, "cancel_production", job.id, now + 1000);
  reload(p);
  assert.equal(canPrepareTutorialHarvest(read(p), "grow_berries"), true, "cancelling ordinary work does not consume the teaching aid");
  const skipped = transitionWorldOnboarding({ version: 2, status: "started", stepId: "grow" }, { type: "skip", now });
  assert.equal(skipped.status, "skipped");
  assert.equal(interval(send(p, "start_production", "grow_berries", now + 2000).state.jobs[0]), seconds * 1000);
});

test("explicit aid is consumed atomically, survives reload and still needs the normal server collection before a single claim", () => {
  const p = player(), before = read(p), start = request(p, "start_tutorial_harvest");
  const started = api.commandDevEconomy(p.token, start, now).state, job = started.jobs[0];
  assert.equal(interval(job), 1); assert.equal(started.tutorialOrder.firstHarvestPrepared, true);
  assert.deepEqual(started.wallet, before.wallet); assert.deepEqual(started.inventory, before.inventory);
  assert.deepEqual(started.progression, before.progression, "preparing a crop never credits output or recipe progress");
  assert.equal(api.commandDevEconomy(p.token, start, now + 10).replayed, true);
  assert.throws(() => api.commandDevEconomy(p.token, { ...start, requestId: crypto.randomUUID() }, now + 10), { code: "ECONOMY_REVISION_CONFLICT" });
  reload(p);
  assert.equal(read(p).tutorialOrder.firstHarvestPrepared, true);
  assert.throws(() => send(p, "start_tutorial_harvest", "grow_berries", now + 1), { code: "ECONOMY_TUTORIAL_HARVEST_UNAVAILABLE" });
  const collection = request(p, "start_garden_collection", job.id, now + 1);
  api.commandDevEconomy(p.token, collection, now + 1);
  reload(p);
  const collecting = read(p, now + 1), saved = collecting.jobs[0].collection;
  assert.equal(Date.parse(saved.finishesAt) - Date.parse(saved.startedAt), 8000);
  assert.throws(() => send(p, "claim_garden_collection", collection.requestId, now + 8000), { code: "ECONOMY_COLLECTION_NOT_READY" });
  const claim = request(p, "claim_garden_collection", collection.requestId, now + 8001);
  const delivered = api.commandDevEconomy(p.token, claim, now + 8001).state;
  assert.equal(delivered.inventory.berries, 1); assert.equal(delivered.progression.recipes.grow_berries, 1);
  assert.equal(api.commandDevEconomy(p.token, claim, now + 9000).replayed, true);
  assert.equal(read(p).inventory.berries, 1);
  assert.throws(() => send(p, "claim_garden_collection", collection.requestId, now + 9000), { code: "ECONOMY_JOB_GONE" });
  send(p, "sell", "berries", now + 9000);
  reload(p);
  assert.throws(() => send(p, "start_tutorial_harvest", "grow_berries", now + 9001), { code: "ECONOMY_TUTORIAL_HARVEST_UNAVAILABLE" });
  const replay = transitionWorldOnboarding({ version: 2, status: "completed", harvested: true }, { type: "replay" });
  assert.equal(replay.harvested, undefined);
  assert.equal(interval(send(p, "start_production", "grow_berries", now + 9001).state.jobs[0]), seconds * 1000);
  assert.equal(read(p).tutorialOrder.firstHarvestPrepared, true);
  assert.equal(api.commandDevEconomy(p.token, start, now + 9002).state.jobs.length, 1, "an old start receipt cannot recreate its delivered crop");
});

test("cancelling the accepted one millisecond crop cannot refund its aid marker", () => {
  const p = player(), started = send(p, "start_tutorial_harvest").state;
  send(p, "cancel_production", started.jobs[0].id, now);
  reload(p);
  assert.equal(read(p).jobs.length, 0); assert.equal(read(p).tutorialOrder.firstHarvestPrepared, true);
  assert.throws(() => send(p, "start_tutorial_harvest"), { code: "ECONOMY_TUTORIAL_HARVEST_UNAVAILABLE" });
  assert.equal(interval(send(p, "start_production").state.jobs[0]), seconds * 1000);
});

test("forged, ineligible and capacity-failed assistance changes no saved state or receipt", () => {
  const p = player(); read(p);
  for (const [target, extra] of [["grow_blueberries", {}], ["grow_berries@fish_common", {}], ["grow_berries", { quantity: 2 }], ["grow_berries", { totalPrice: 1 }]]) {
    const before = read(p);
    assert.throws(() => send(p, "start_tutorial_harvest", target, now, extra), { code: "INVALID_ECONOMY_COMMAND" });
    assert.deepEqual(read(p), before);
  }
  row(p).state.jobs = Array.from({ length: 18 }, () => ({ id: crypto.randomUUID(), kind: "production", targetId: "workshop", recipeId: "make_planks",
    startedAt: new Date(now).toISOString(), finishesAt: new Date(now + 60000).toISOString(), rewards: { planks: 1 }, cost: { coins: 0, items: {} }, catalogVersion: economyCatalog.version }));
  const full = read(p);
  assert.throws(() => send(p, "start_tutorial_harvest"), { code: "ECONOMY_JOBS_CAPACITY" });
  assert.deepEqual(read(p), full); assert.equal(row(p).receipts.size, 0);
  for (const tutorialOrder of [undefined, { ...full.tutorialOrder, completed: true }, { ...full.tutorialOrder, firstHarvestPrepared: true }]) {
    row(p).state.jobs = []; row(p).state.tutorialOrder = tutorialOrder;
    const before = read(p);
    assert.throws(() => send(p, "start_tutorial_harvest"), { code: "ECONOMY_TUTORIAL_HARVEST_UNAVAILABLE" });
    assert.deepEqual(read(p), before);
    const ordinary = send(p, "start_production").state;
    assert.equal(interval(ordinary.jobs[0]), seconds * 1000); row(p).state.jobs = [];
  }
});
