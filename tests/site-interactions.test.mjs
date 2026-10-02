import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root,
  resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false } });
after(() => vite.close());
const { sitePlace, interactiveSites } = await vite.ssrLoadModule("/features/world/site-interactions.ts");
const { economyBuildingDestination } = await vite.ssrLoadModule("/features/economy/world-adapter.ts");
const { economyCatalog } = await vite.ssrLoadModule("/features/economy/model.ts");
const { newEconomyState, applyEconomyCommand } = await vite.ssrLoadModule("/features/economy/rules.ts");
const { accountSceneLevels } = await vite.ssrLoadModule("/features/world/economy-scene-state.ts");
const { initialPreviewLevels, previewSiteVisual } = await vite.ssrLoadModule("/features/world/tiled/preview-state.ts");

const freshState = () => newEconomyState({ resources: { sparks: 0, wood: 0, stone: 0 }, houseLevel: 1, workshopLevel: 0 });
const issue = (state, action, targetId, now) => applyEconomyCommand(state, {
  requestId: crypto.randomUUID(), ownerPublicId: "test-player", expectedRevision: 0,
  action, targetId, quantity: 1, totalPrice: 0,
}, now, () => crypto.randomUUID());
const clickDestination = (id, state) => economyBuildingDestination(sitePlace(id), { ...state, catalog: economyCatalog });

test("only implemented economic sites receive map shortcuts, including the forest shelter", () => {
  const sites = ["home", "woodlot", "workshop", "quarry", "bridge", "lighthouse"].map(id => ({ id }));
  assert.deepEqual(interactiveSites({ sites }).map(({ site, place }) => [site.id, place]), [
    ["home", "house"], ["woodlot", "woodlot"], ["workshop", "workshop"], ["quarry", "quarry"],
  ]);
  for (const id of ["bridge", "lighthouse", "unknown", "constructor", null, undefined]) assert.equal(sitePlace(id), null);
});

test("shelter clicks follow actual construction and production progress without confirming elapsed jobs", () => {
  const state = freshState(), now = Date.UTC(2026, 9, 2);
  const building = economyCatalog.buildings.find(entry => entry.id === "woodlot"), first = building.levels[0];
  const unbuilt = structuredClone(state);
  assert.deepEqual(clickDestination("woodlot", state), { tab: "buildings", focusId: "woodlot" });
  assert.deepEqual(state, unbuilt, "a map click cannot build the forest site or mint materials");

  state.wallet.coins = first.cost.coins;
  state.inventory = { ...first.cost.items };
  issue(state, "start_construction", "woodlot", now);
  const construction = state.jobs[0], finish = Date.parse(construction.finishesAt);
  assert.equal(state.buildings.woodlot, 0);
  assert.deepEqual(clickDestination("woodlot", state), { tab: "buildings", focusId: "woodlot" });
  assert.throws(() => issue(state, "claim_job", construction.id, finish - 1), { code: "ECONOMY_JOB_NOT_READY" });
  assert.deepEqual(economyBuildingDestination(sitePlace("woodlot"), {
    ...state, catalog: economyCatalog, serverTime: new Date(finish + 1000).toISOString(),
  }), { tab: "buildings", focusId: "woodlot" },
    "the wall-clock deadline alone does not confirm the building level");
  issue(state, "claim_job", construction.id, finish);
  assert.equal(state.buildings.woodlot, 1);
  assert.deepEqual(clickDestination("woodlot", state), { tab: "production", focusId: "woodlot" });

  const recipe = economyCatalog.recipes.find(entry => entry.buildingId === "woodlot" && entry.buildingLevel === 1);
  issue(state, "start_production", recipe.id, finish);
  const production = state.jobs[0];
  assert.deepEqual(clickDestination("woodlot", state), { tab: "production", focusId: "woodlot" },
    "an active production order stays in its own production panel");
  issue(state, "claim_job", production.id, Date.parse(production.finishesAt));
  for (const [id, amount] of Object.entries(recipe.rewards)) assert.equal(state.inventory[id], amount);

  const second = building.levels[1];
  state.buildings.home = second.requiredHomeLevel;
  Object.assign(state.buildings, second.requiredBuildings);
  state.wallet.coins = second.cost.coins;
  state.inventory = { ...second.cost.items };
  issue(state, "start_construction", "woodlot", Date.parse(production.finishesAt));
  const upgrade = state.jobs[0];
  assert.equal(state.buildings.woodlot, 1);
  assert.deepEqual(clickDestination("woodlot", state), { tab: "buildings", focusId: "woodlot" },
    "an upgrade opens its construction timer rather than production");
  issue(state, "claim_job", upgrade.id, Date.parse(upgrade.finishesAt));
  assert.equal(state.buildings.woodlot, 2);
  assert.deepEqual(clickDestination("woodlot", state), { tab: "production", focusId: "woodlot" });
});

test("forest and quarry artwork supports all economic levels while DEV never unlocks production", () => {
  const scene = { sites: [
    { id: "woodlot", initialLevel: 0, states: [0, 1].map(level => ({ level, image: "/shelter.png" })) },
    { id: "quarry", initialLevel: 0, states: [0, 1].map(level => ({ level, image: `/quarry-${level}.png` })) },
  ] };
  const original = structuredClone(scene), preview = { levels: initialPreviewLevels(scene), previewBuildings: false };
  for (let level = 0; level <= 5; level++) {
    const state = freshState();
    state.buildings.woodlot = level; state.buildings.quarry = level;
    const selected = accountSceneLevels(scene, 1, preview, state.buildings);
    assert.deepEqual(selected, { woodlot: Math.min(level, 1), quarry: Math.min(level, 1) });
    assert.equal(previewSiteVisual(scene.sites[0], selected).image, "/shelter.png");
    assert.equal(previewSiteVisual(scene.sites[1], selected).image, `/quarry-${Math.min(level, 1)}.png`);
    assert.equal(state.buildings.woodlot, level, "missing advanced art must preserve forest progression");
    assert.equal(state.buildings.quarry, level, "missing advanced art must preserve quarry progression");
    for (const id of ["woodlot", "quarry"]) assert.deepEqual(clickDestination(id, state),
      { tab: level ? "production" : "buildings", focusId: id });
  }
  const state = freshState();
  assert.deepEqual(accountSceneLevels(scene, 1, { levels: { woodlot: 1, quarry: 1 }, previewBuildings: true }, state.buildings),
    { woodlot: 1, quarry: 1 });
  for (const id of ["woodlot", "quarry"]) assert.deepEqual(clickDestination(id, state), { tab: "buildings", focusId: id },
    "trying a working visual in DEV must not grant construction or production rights");
  assert.deepEqual(accountSceneLevels(scene, 1, preview, { woodlot: 5, quarry: 5 }), { woodlot: 1, quarry: 1 },
    "returning from DEV uses the nearest available account artwork");
  assert.deepEqual(scene, original);
});
