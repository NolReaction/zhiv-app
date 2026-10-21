import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root,
  resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false } });
after(() => vite.close());
const { economySceneResidents, economySceneJourney } = await vite.ssrLoadModule("/features/economy/integration/world-adapter.ts");
const { syncForestResidentAccess } = await vite.ssrLoadModule("/features/world/state/economy/economy-residents-state.ts");
const now = Date.parse("2026-10-16T18:00:00Z");
const job = (id, kind, targetId, actorId) => ({ id, kind, targetId, actorId, recipeId: `${targetId}_recipe`,
  startedAt: new Date(now).toISOString(), finishesAt: new Date(now + 60000).toISOString(), rewards: { wood: 5 }, cost: { coins: 100 } });
function snapshot() {
  return { ownerPublicId: "owner", revision: 2, buildings: { home: 2, quarry: 1, woodlot: 1 },
    catalog: { recipes: [{ id: "woodlot_recipe", buildingId: "woodlot" }], explorations: [] }, jobs: [
      job("timber", "production", "woodlot"), job("miner", "exploration", "quarry_stone", "miner"),
      job("hero", "exploration", "forest", "mochlik"), job("build", "construction", "home"),
    ] };
}

test("resident access requires a confirmed owner and projects miner work separately from Mochlik", () => {
  const state = snapshot(), before = structuredClone(state);
  assert.equal(economySceneResidents(state, false, "owner"), null);
  assert.equal(economySceneResidents(state, true, "foreign"), null);
  assert.equal(economySceneResidents(null, true), null);
  const projection = economySceneResidents(state, true, "owner");
  assert.deepEqual(projection.production.jobs.map(job => [job.id, job.stationId]), [["timber", "woodlot"], ["miner", "quarry"]]);
  assert.equal(economySceneJourney(state).id, "hero");
  assert.equal("rewards" in projection.production.jobs[1], false);
  assert.equal("cost" in projection.production.jobs[1], false);
  projection.buildings.quarry = 99; projection.production.jobs[0].id = "outside";
  assert.deepEqual(state, before, "scene consumers cannot change the accepted profile");
});

test("resident revision fence preserves claimed access, empty work and owner isolation across cameras", () => {
  const holder = {}, projection = economySceneResidents(snapshot(), true, "owner");
  assert.equal(syncForestResidentAccess(holder, projection, "owner"), true);
  projection.buildings.quarry = 99; projection.production.jobs.length = 0;
  assert.equal(holder.economyResidents.buildings.quarry, 1);
  assert.equal(holder.economyResidents.production.jobs.length, 2);
  const next = { ...snapshot(), revision: 3, jobs: [] };
  assert.equal(syncForestResidentAccess(holder, economySceneResidents(next, true), "owner"), true);
  assert.equal(syncForestResidentAccess(holder, economySceneResidents(snapshot(), true), "owner"), false);
  assert.equal(syncForestResidentAccess(holder, null, "owner"), false);
  const foreign = economySceneResidents({ ...next, ownerPublicId: "foreign" }, true);
  assert.equal(syncForestResidentAccess(holder, foreign, "owner"), false);
  assert.equal(syncForestResidentAccess(holder, foreign), false);
  assert.equal(syncForestResidentAccess(holder, foreign, "foreign"), true);
});

test("mismatched worker ownership and malformed revisions cannot borrow the outer account access", () => {
  const projection = economySceneResidents(snapshot(), true), holder = {};
  for (const revision of [-1, NaN, Infinity, 1.5]) assert.equal(syncForestResidentAccess(holder, { ...projection, revision }), false);
  assert.equal(syncForestResidentAccess(holder, { ...projection, production: { ...projection.production, ownerPublicId: "foreign" } }, "owner"), false);
  assert.equal(syncForestResidentAccess(holder, { ...projection, production: { ...projection.production, revision: 1 } }, "owner"), false);
  assert.equal(holder.economyResidents, undefined);
});
