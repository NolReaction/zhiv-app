import assert from "node:assert/strict";
import test, { after, beforeEach } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root,
  resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false } });
after(() => vite.close());
const { economySceneProduction } = await vite.ssrLoadModule("/features/economy/integration/world-adapter.ts");
const { forestProductionFrames, syncForestProduction } = await vite.ssrLoadModule("/features/world/state/economy/economy-production-state.ts");
const { drawForestProductionStation } = await vite.ssrLoadModule("/features/world/scene/forest-production-painter.ts");
const { drawForestProductionCooking } = await vite.ssrLoadModule("/features/world/activities/cooking/forest-cooking-painter.ts");
const { TILED_WORLD } = await vite.ssrLoadModule("/features/world/scene/presentation.ts");
const { previewWorldScene, previewSiteVisual } = await vite.ssrLoadModule("/features/world/tiled/preview-state.ts");
const { economyCatalog } = await vite.ssrLoadModule("/features/economy/domain/model.ts");
const identities = await vite.ssrLoadModule("/lib/dev/api-store.ts");
const economy = await vite.ssrLoadModule("/lib/dev/economy-store.ts");
beforeEach(() => identities.resetDevStoreForTests());
const start = Date.parse("2026-10-05T12:00:00Z"), finish = start + 7200_000;
const owner = "1234-5678-ABCD";
const job = (stationId, id = stationId) => ({ id, stationId, stationLevel: 1, recipeId: `recipe-${stationId}`,
  startedAt: new Date(start).toISOString(), finishesAt: new Date(finish).toISOString() });
const snapshot = (jobs = [job("dryer")], revision = 1) => ({ ownerPublicId: owner, revision, jobs });
const levels = Object.fromEntries(TILED_WORLD.sites.map(site => [site.id, Math.max(1, site.initialLevel)]));
const actual = previewWorldScene(TILED_WORLD, levels);
const visuals = Object.fromEntries(TILED_WORLD.sites.map(site => [site.id, previewSiteVisual(site, levels)]));

test("ready slots do not stop another order's workshop and cooking animation", () => {
  const jobs = ["dryer", "workshop", "woodlot"].flatMap(station => [
    { ...job(station, `${station}-ready`), finishesAt: new Date(start + 1000).toISOString() },
    job(station, `${station}-working`), job(station, `${station}-also-working`),
  ]);
  const saved = snapshot(jobs), before = structuredClone(saved);
  const frames = forestProductionFrames(saved, actual, visuals, start + 2000, 3);
  assert.equal(frames.length, 3, "one physical station, regardless of the number of concurrent jobs");
  assert.ok(frames.every(frame => frame.phase === "working" && frame.jobId.endsWith("-working")));
  assert.ok(forestProductionFrames(saved, actual, visuals, finish, 4).every(frame => frame.phase === "ready"));
  assert.deepEqual(saved, before);
});

test("production projection uses accepted jobs only and rendering cannot advance or award their goods", () => {
  const p = identities.createDevIdentity("Повар", crypto.randomUUID());
  economy.getDevEconomy(p.token, start);
  const row = globalThis.__zhivDevEconomyStore.profiles.get(p.me.user.publicId);
  const recipe = economyCatalog.recipes.find(recipe => recipe.buildingId === "dryer");
  row.state.buildings.dryer = recipe.buildingLevel; row.state.buildings.home = recipe.requiredHomeLevel;
  Object.assign(row.state.buildings, recipe.requiredBuildings);
  row.state.wallet.coins = recipe.cost.coins; row.state.inventory = { ...recipe.cost.items };
  assert.deepEqual(economySceneProduction(economy.getDevEconomy(p.token, start)).jobs, []);
  const request = { requestId: crypto.randomUUID(), ownerPublicId: p.me.user.publicId,
    expectedRevision: row.revision, action: "start_production", targetId: recipe.id, quantity: 1, totalPrice: 0 };
  const accepted = economy.commandDevEconomy(p.token, request, start).state;
  const before = structuredClone(row.state);
  const projection = economySceneProduction(accepted);
  assert.equal(projection.jobs[0].stationId, "dryer");
  const extra = { ...accepted, jobs: [...accepted.jobs,
    { ...accepted.jobs[0], id: "construction", kind: "construction" },
    { ...accepted.jobs[0], id: "exploration", kind: "exploration" },
    { ...accepted.jobs[0], id: "wrong-recipe-site", targetId: "workshop" }] };
  assert.equal(economySceneProduction(extra).jobs.length, 1, "other jobs and mismatched recipe stations cannot trigger cooking");
  const deadline = Date.parse(accepted.jobs[0].finishesAt);
  assert.equal(forestProductionFrames(projection, actual, visuals, deadline - 1, 3)[0].phase, "working");
  const painted = [];
  const ctx = new Proxy({ globalAlpha: 1, createLinearGradient: () => ({ addColorStop() {} }), createRadialGradient: () => ({ addColorStop() {} }) },
    { get(target, key) { return key in target ? target[key] : (...args) => painted.push([key, ...args]); } });
  drawForestProductionCooking(ctx, forestProductionFrames(projection, actual, visuals, deadline - 1, 3)[0], false);
  assert.ok(painted.some(call => call[0] === "fill"), "a real dryer job reaches the cooking painter");
  assert.equal(forestProductionFrames(projection, actual, visuals, deadline + 86400_000, 4)[0].phase, "ready");
  assert.deepEqual(row.state, before, "busy and ready painting never claims a job or credits food");
  economy.commandDevEconomy(p.token, { ...request, requestId: crypto.randomUUID(), expectedRevision: row.revision,
    action: "claim_job", targetId: accepted.jobs[0].id }, deadline);
  assert.deepEqual(economySceneProduction(economy.getDevEconomy(p.token, deadline)).jobs, []);
});

test("server date correction and time absence change readiness without replaying a production action", () => {
  const state = snapshot(), original = structuredClone(state);
  assert.deepEqual(forestProductionFrames(state, actual, visuals, start - 1, 2), []);
  assert.equal(forestProductionFrames(state, actual, visuals, finish + 1, 2)[0].phase, "ready");
  assert.equal(forestProductionFrames(state, actual, visuals, start + 1000, 2)[0].phase, "working");
  assert.equal(forestProductionFrames(state, actual, visuals, finish - 1, 2)[0].phase, "working");
  assert.equal(forestProductionFrames(state, actual, visuals, finish, 2)[0].phase, "ready");
  assert.deepEqual(state, original);
  assert.deepEqual(forestProductionFrames(state, actual, visuals, NaN, 2), []);
});

test("actual loaded geometry owns effects and moved or removed markers do not leave fallback props", () => {
  const state = snapshot([job("dryer"), job("workshop"), job("quarry"), job("woodlot"), job("kiln")]);
  const frames = forestProductionFrames(state, actual, visuals, start, 3);
  const kitchen = frames.find(frame => frame.stationId === "dryer"), fire = actual.campfires.find(fire => fire.id === kitchen.fireId);
  assert.deepEqual([kitchen.x, kitchen.y, kitchen.size], [fire.position.x, fire.position.y, fire.radius * 4]);
  assert.ok(frames.every(frame => frame.stationId !== "kiln"), "no invented site for absent art");
  for (const frame of frames.filter(frame => frame.stationId !== "dryer")) {
    const site = actual.sites.find(site => site.id === frame.stationId);
    assert.deepEqual([frame.x, frame.y], [site.entry.x, site.entry.y]);
  }
  assert.deepEqual(forestProductionFrames(state, actual, visuals, start, 3, false), []);
  const moved = structuredClone(actual); moved.campfires[0].position.x += 70;
  assert.equal(forestProductionFrames(snapshot(), moved, visuals, start, 3)[0].x, moved.campfires[0].position.x);
  assert.deepEqual(forestProductionFrames(snapshot(), { ...actual, campfires: [] }, visuals, start, 3), []);
  const hidden = Object.fromEntries(Object.keys(visuals).map(id => [id, { level: 0 }]));
  assert.deepEqual(forestProductionFrames(snapshot([job("workshop"), job("quarry"), job("woodlot")]), actual, hidden, start, 3), []);
  assert.deepEqual(forestProductionFrames(snapshot([{ ...job("dryer"), stationLevel: 0 }]), actual, visuals, start, 3), []);
});

test("shared revision fence keeps removals across background cameras and does not mix owners", () => {
  const holder = {}, active = snapshot(), removed = snapshot([], 2);
  assert.equal(syncForestProduction(holder, active, owner), true);
  active.jobs[0].stationId = "quarry";
  assert.equal(holder.economyProduction.jobs[0].stationId, "dryer", "the scene does not retain a mutable React snapshot array");
  assert.equal(syncForestProduction(holder, removed, owner), true);
  assert.equal(syncForestProduction(holder, snapshot(), owner), false);
  assert.deepEqual(holder.economyProduction.jobs, []);
  assert.equal(syncForestProduction(holder, { ...snapshot(), ownerPublicId: "someone-else", revision: 99 }, owner), false);
  assert.equal(syncForestProduction(holder, undefined, owner), false);
  assert.equal(holder.economyProduction.revision, 2);
});

test("a station stays bounded to one verified job and rejects malformed dates instead of NaN props", () => {
  const state = snapshot([job("dryer", "first"), { ...job("dryer", "second"), finishesAt: new Date(finish + 5000).toISOString() },
    { ...job("quarry"), finishesAt: "bad" }, { ...job("woodlot"), finishesAt: new Date(start).toISOString() }]);
  const frames = forestProductionFrames(state, actual, visuals, start, NaN);
  assert.equal(frames.length, 1); assert.equal(frames[0].jobId, "first"); assert.equal(frames[0].elapsed, 0);
  assert.ok([frames[0].x, frames[0].y, frames[0].size].every(Number.isFinite));
});

test("reduced motion and ready station props are static, with no retained particles or context alpha leak", () => {
  function paint(elapsed, still, phase = "working") {
    const calls = [], states = [];
    const context = new Proxy({ globalAlpha: .7, save() { states.push(this.globalAlpha); }, restore() { this.globalAlpha = states.pop(); } },
      { get(target, key) { return key in target ? target[key] : (...args) => calls.push([key, ...args]); } });
    drawForestProductionStation(context, { jobId: "wood", recipeId: "cut_planks", stationId: "woodlot", phase, x: 10, y: 20, size: 25, elapsed }, still);
    assert.equal(context.globalAlpha, .7); return calls;
  }
  assert.deepEqual(paint(1, true), paint(90, true));
  assert.deepEqual(paint(1, false, "ready"), paint(90, false, "ready"));
  assert.notDeepEqual(paint(1, false), paint(2, false));
  assert.equal(paint(1, true).filter(call => call[0] === "stroke").length, 0);
});

test("retired quarry jobs retain their own production projection until delivered", () => {
  const saved = { id: "legacy-quarry", kind: "production", targetId: "quarry", recipeId: "retired-quarry-recipe",
    startedAt: new Date(start).toISOString(), finishesAt: new Date(finish).toISOString() };
  const state = { ownerPublicId: owner, revision: 4, catalog: economyCatalog, buildings: { quarry: 2 }, jobs: [saved] };
  assert.equal(economyCatalog.recipes.some(recipe => recipe.buildingId === "quarry"), false);
  assert.deepEqual(economySceneProduction(state).jobs, [{ id: saved.id, stationId: "quarry", stationLevel: 2,
    recipeId: saved.recipeId, startedAt: saved.startedAt, finishesAt: saved.finishesAt }]);
  assert.deepEqual(economySceneProduction({ ...state, jobs: [] }).jobs, []);
});
