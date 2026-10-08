import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root,
  resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false } });
after(() => vite.close());
const { sitePlace, interactiveSites, interactiveMapObjects, mapObjectAt } = await vite.ssrLoadModule("/features/world/scene/site-interactions.ts");
const { economyBuildingDestination } = await vite.ssrLoadModule("/features/economy/integration/world-adapter.ts");
const { economyCatalog } = await vite.ssrLoadModule("/features/economy/domain/model.ts");
const { newEconomyState, applyEconomyCommand } = await vite.ssrLoadModule("/features/economy/domain/rules.ts");
const { accountSceneLevels } = await vite.ssrLoadModule("/features/world/state/economy/economy-scene-state.ts");
const { initialPreviewLevels, previewSiteVisual, previewWorldScene } = await vite.ssrLoadModule("/features/world/tiled/preview-state.ts");
const { default: authoredWorld } = await vite.ssrLoadModule("/features/world/tiled/forest.generated.json");

const freshState = () => newEconomyState({ resources: { sparks: 0, wood: 0, stone: 0 }, houseLevel: 1, workshopLevel: 0 });
const issue = (state, action, targetId, now) => applyEconomyCommand(state, {
  requestId: crypto.randomUUID(), ownerPublicId: "test-player", expectedRevision: 0,
  action, targetId, quantity: 1, totalPrice: 0,
}, now, () => crypto.randomUUID());
const clickDestination = (id, state) => economyBuildingDestination(sitePlace(id), { ...state, catalog: economyCatalog });

test("only implemented economic sites receive map shortcuts, including the forest shelter", () => {
  const sites = ["home", "woodlot", "workshop", "quarry", "bridge", "lighthouse", "plesk-shop"].map(id => ({ id }));
  assert.deepEqual(interactiveSites({ sites }).map(({ site, place }) => [site.id, place]), [
    ["home", "house"], ["woodlot", "woodlot"], ["workshop", "workshop"], ["quarry", "quarry"],
  ]);
  for (const id of ["bridge", "lighthouse", "plesk-shop", "unknown", "constructor", null, undefined]) assert.equal(sitePlace(id), null);
});

test("object menus use the existing authored polygons and anchors for every map station", () => {
  const world = previewWorldScene(authoredWorld, initialPreviewLevels(authoredWorld));
  const source = structuredClone(authoredWorld), objects = interactiveMapObjects(world);
  assert.deepEqual(objects.map(object => [object.id, object.place]), [
    ...world.sites.map(site => [site.id, site.id === "home" ? "house" : site.id]),
    ["clearing-bush", "garden"], ["clearing-campfire", "campfire"],
  ]);
  for (const site of world.sites) {
    const object = objects.find(object => object.id === site.id);
    assert.equal(object.anchor, site.anchor, `${site.id} follows the committed level's anchor`);
    assert.equal(object.hitArea, site.hitArea, `${site.id} uses its contour rather than the PNG bounds`);
    assert.equal(mapObjectAt([object], site.hitArea[0]), object, "polygon edges remain clickable");
  }
  const garden = objects.find(object => object.place === "garden");
  assert.equal(garden.hitArea, world.bushes[0].points);
  assert.equal(garden.anchor, world.bushes[0].hide);
  const fire = world.campfires[0], hearth = objects.find(object => object.place === "campfire");
  assert.equal(hearth.anchor, fire.position);
  assert.equal(mapObjectAt([hearth], fire.position), hearth);
  assert.equal(mapObjectAt([hearth], { x: fire.position.x, y: fire.position.y - fire.radius }), hearth,
    "the visible flame remains a touch target above the ground anchor");
  assert.equal(mapObjectAt(objects, { x: 0, y: 0 }), null, "blank ground has no invented station");
  assert.equal(mapObjectAt(objects, { x: NaN, y: 600 }), null);
  assert.deepEqual(authoredWorld, source, "building registry reads preserve source placement");
});

test("hidden buildings remove their menus while garden and campfire remain on the map", () => {
  const world = previewWorldScene(authoredWorld, initialPreviewLevels(authoredWorld));
  const objects = interactiveMapObjects(world), visibleAgain = interactiveMapObjects(world);
  assert.equal(visibleAgain, objects, "the immutable committed scene reuses its registry");
  assert.deepEqual(interactiveMapObjects(world, { showBuildings: false }).map(object => object.place), ["garden", "campfire"]);
  assert.equal(interactiveMapObjects(world), objects, "DEV visibility cannot mutate the saved registry");
  for (const place of ["bridge", "lighthouse", "quarry"]) assert.ok(objects.some(object => object.place === place),
    "planned and locked objects stay visible and can explain their requirements");
});

test("pending or misplaced explicit bush artwork cannot create a garden on empty ground", () => {
  const points = [{ x: 20, y: 20 }, { x: 40, y: 20 }, { x: 40, y: 40 }, { x: 20, y: 40 }];
  const bush = { id: "garden", imageId: "garden-art", points, hide: { x: 30, y: 30 }, entry: { x: 30, y: 45 } };
  const scene = { sites: [], terrain: [], bushes: [bush] };
  assert.deepEqual(interactiveMapObjects(scene), []);
  const misplaced = { ...scene, terrain: [{ id: "garden-art", bounds: { x: 200, y: 200, width: 50, height: 50 } }] };
  assert.deepEqual(interactiveMapObjects(misplaced), []);
  const placed = { ...scene, terrain: [{ id: "garden-art", bounds: { x: 10, y: 10, width: 50, height: 50 } }] };
  assert.equal(mapObjectAt(interactiveMapObjects(placed), bush.hide)?.place, "garden");
  assert.equal(interactiveMapObjects({ ...scene, bushes: [{ ...bush, imageId: undefined }] })[0].place, "garden",
    "older baked foliage remains usable without requiring duplicate artwork");
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
      { tab: level && id !== "quarry" ? "production" : "buildings", focusId: id });
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
