import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root,
  resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false } });
after(() => vite.close());
const { syncForestConstruction, forestConstructionJob } = await vite.ssrLoadModule("/features/world/state/economy/economy-construction-state.ts");
const { economySceneConstruction } = await vite.ssrLoadModule("/features/economy/integration/world-adapter.ts");
const start = Date.parse("2026-10-06T12:00:00Z"), owner = "builder-owner";
const job = (id = "home") => ({ id, stationId: "home", targetLevel: 2,
  startedAt: new Date(start).toISOString(), finishesAt: new Date(start + 3600_000).toISOString() });
const snapshot = (jobs = [job()], revision = 1) => ({ ownerPublicId: owner, revision, jobs });

test("construction snapshots fence old/foreign cameras and retain newer empty completion", () => {
  const holder = {}, incoming = snapshot();
  assert.equal(syncForestConstruction(holder, incoming, owner), true);
  incoming.jobs[0].stationId = "changed-outside";
  assert.equal(holder.economyConstruction.jobs[0].stationId, "home", "snapshot jobs are copied");
  assert.equal(syncForestConstruction(holder, snapshot([], 2), owner), true);
  assert.equal(syncForestConstruction(holder, snapshot(), owner), false);
  assert.equal(syncForestConstruction(holder, snapshot([job()], 2), owner), false);
  assert.equal(syncForestConstruction(holder, { ...snapshot(), ownerPublicId: "foreign", revision: 99 }, owner), false);
  for (const value of [null, undefined, snapshot([], -1), snapshot([], NaN), snapshot([], 1.2)])
    assert.equal(syncForestConstruction(holder, value, owner), false);
  assert.deepEqual(holder.economyConstruction, snapshot([], 2));
});

test("owner replacement requires an explicit owner fence; no account inherits another builder job", () => {
  const holder = { economyConstruction: snapshot() }, next = { ...snapshot([], 0), ownerPublicId: "new-owner" };
  assert.equal(syncForestConstruction(holder, next), false);
  assert.equal(syncForestConstruction(holder, next, "new-owner"), true);
  assert.deepEqual(holder.economyConstruction, next);
});

test("ready legacy jobs retain deterministic priority until removed, without changing the array", () => {
  const later = { ...job("c"), startedAt: new Date(start + 1000).toISOString() };
  const ready = { ...job("a"), finishesAt: new Date(start + 1).toISOString() };
  const construction = snapshot([later, job("b"), ready]), before = structuredClone(construction);
  assert.equal(forestConstructionJob(construction, start + 2000).id, "a");
  assert.equal(forestConstructionJob(construction, start + 7200_000).id, "a");
  assert.deepEqual(construction, before);
  assert.equal(forestConstructionJob(snapshot([later]), start), null);
  assert.equal(forestConstructionJob(construction, NaN), null);
});

test("invalid job dates/levels cannot animate imaginary construction", () => {
  const bad = [
    { ...job(), startedAt: "bad" }, { ...job(), finishesAt: "bad" },
    { ...job(), finishesAt: new Date(start - 1).toISOString() },
    { ...job(), targetLevel: 0 }, { ...job(), targetLevel: 1.5 }, { ...job(), stationId: "" },
  ];
  assert.equal(forestConstructionJob(snapshot(bad), start), null);
  assert.equal(forestConstructionJob(snapshot([...bad, job("valid")]), start).id, "valid");
});

test("economy projection includes only confirmed construction, including ready jobs, without reward or command data", () => {
  const { stationId, ...base } = job();
  const construction = { ...base, kind: "construction", targetId: stationId,
    rewards: { gold: 500 }, cost: { pearls: 50 }, recipeId: "private-test-recipe" };
  const ready = { ...construction, id: "ready", targetId: "workshop", finishesAt: new Date(start + 1).toISOString(), ready: true };
  const jobs = [construction, ready,
    { ...construction, id: "producing", kind: "production" },
    { ...construction, id: "away", kind: "exploration" },
    { ...construction, id: "invalid", targetLevel: undefined }];
  for (const entry of jobs) Object.freeze(entry);
  Object.freeze(jobs);
  const economy = { ownerPublicId: owner, revision: 27, jobs, wallet: { coins: 900, pearls: 55 }, inventory: { plank: 8 } };
  const before = structuredClone(economy), projected = economySceneConstruction(economy);
  assert.deepEqual(projected, { ownerPublicId: owner, revision: 27, jobs: [job(), {
    ...job("ready"), stationId: "workshop", finishesAt: ready.finishesAt,
  }] });
  assert.deepEqual(economy, before);
  assert.notEqual(projected.jobs, jobs);
  projected.jobs[0].stationId = "scene-only-change";
  assert.equal(economy.jobs[0].targetId, "home", "projected jobs never alias account objects");
  assert.equal(economySceneConstruction(null), null);
  assert.equal(economySceneConstruction(undefined), null);
});
