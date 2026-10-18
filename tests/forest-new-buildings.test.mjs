import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { compileTiledWorld } from "../scripts/lib/tiled-world.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const mapPath = path.join(root, "world/tiled/forest.tmj");
const map = JSON.parse(await readFile(mapPath, "utf8"));
// Geometry checks must use the current authoring source even when its runtime
// export was accidentally left behind after a Tiled save.
const TILED_WORLD = await compileTiledWorld(map, { mapPath, publicDir: path.join(root, "public") });
const vite = await createServer({ appType: "custom", configFile: false, root,
  resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false } });
after(() => vite.close());
const { TILED_WORLD: exportedWorld } = await vite.ssrLoadModule("/features/world/scene/presentation.ts");
const { initialPreviewLevels, previewWorldScene, previewSiteVisual, previewPointInPolygon, previewSiteAt }
  = await vite.ssrLoadModule("/features/world/tiled/preview-state.ts");
const { createWorldNavigation, isWalkable, canTraverse, findWorldPath }
  = await vite.ssrLoadModule("/features/world/navigation/navigation.ts");
const { accountSceneLevels } = await vite.ssrLoadModule("/features/world/state/economy/economy-scene-state.ts");
const { forestProductionFrames } = await vite.ssrLoadModule("/features/world/state/economy/economy-production-state.ts");

const expectedSites = {
  market: [1], "leaftail-caravan": [1], "bulletin-board": [1], "lopukh-home": [1, 2], "plesk-shop": [1], "builder-home": [1],
};
const authoredImages = [
  { objectId: 485, siteId: "market", level: 1, file: "market.png" },
  { objectId: 488, siteId: "leaftail-caravan", level: 1, file: "leaftail-caravan.png" },
  { objectId: 491, siteId: "bulletin-board", level: 1, file: "bulletin-board.png" },
  { objectId: 495, siteId: "lopukh-home", level: 1, file: "lopukh-house-lvl-1.png" },
  { objectId: 497, siteId: "lopukh-home", level: 2, file: "lopukh-house-lvl-2.png" },
  { objectId: 422, siteId: "plesk-shop", level: 1, file: "pleska-market.png" },
  { objectId: 440, siteId: "builder-home", level: 1, file: "Shishkolap_House.png" },
];
const objects = (layers, offset = { x: 0, y: 0 }) => layers.flatMap(layer => {
  const shifted = { x: offset.x + (layer.offsetx ?? 0), y: offset.y + (layer.offsety ?? 0) };
  return layer.layers ? objects(layer.layers, shifted)
    : (layer.objects ?? []).map(object => ({ ...object, x: object.x + shifted.x, y: object.y + shifted.y }));
});
const sourceObjects = objects(map.layers);
const imagePath = image => decodeURIComponent(new URL(image, "https://world.invalid").pathname);
const siteAtLevel = (siteId, level) => previewWorldScene(TILED_WORLD,
  { ...initialPreviewLevels(TILED_WORLD), [siteId]: level }).sites.find(site => site.id === siteId);
const close = (actual, expected, label) => assert.ok(Math.abs(actual - expected) < 1e-8,
  `${label}: ${actual} should equal ${expected}`);
const rectangle = (x, y, width, height) => [
  { x, y }, { x: x + width, y }, { x: x + width, y: y + height }, { x, y: y + height },
];
function interiorPoint(polygon) {
  const xs = polygon.map(point => point.x), ys = polygon.map(point => point.y);
  const left = Math.min(...xs), top = Math.min(...ys), width = Math.max(...xs) - left, height = Math.max(...ys) - top;
  // Avoid assuming that a possibly concave authored polygon contains its centroid.
  for (let row = 1; row < 10; row++) for (let column = 1; column < 10; column++) {
    const point = { x: left + width * column / 10, y: top + height * row / 10 };
    if (previewPointInPolygon(point, polygon)) return point;
  }
  assert.fail("authored footprint needs a non-empty interior");
}

test("the runtime world export matches the current Tiled source", () => {
  assert.deepEqual(exportedWorld, TILED_WORLD, "Run npm run world:export after saving the Tiled map");
});

test("new buildings are registered once with their intended independent visual levels", () => {
  for (const [id, levels] of Object.entries(expectedSites)) {
    const matches = TILED_WORLD.sites.filter(site => site.id === id);
    assert.equal(matches.length, 1, `${id} is one physical site`);
    assert.deepEqual(matches[0].states.map(state => state.level), levels, `${id} levels`);
    assert.equal(matches[0].initialLevel, 1, `${id} starts at level 1`);
    for (const level of levels) {
      const site = siteAtLevel(id, level);
      assert.ok(site.collision.length >= 3, `${id} level ${level} has a physical footprint`);
      assert.ok(site.hitArea.length >= 3, `${id} level ${level} has a touch region`);
      for (const point of [site.anchor, site.entry]) assert.ok(Number.isFinite(point.x) && Number.isFinite(point.y));
    }
  }
  const lopukh = TILED_WORLD.sites.find(site => site.id === "lopukh-home");
  const first = previewSiteVisual(lopukh, { "lopukh-home": 1 });
  const second = previewSiteVisual(lopukh, { "lopukh-home": 2 });
  assert.notEqual(first.image, second.image, "house improvement selects a genuinely different illustration");
  for (const { siteId, file } of authoredImages) {
    assert.equal(TILED_WORLD.terrain.some(image => path.basename(imagePath(image.image)) === file), false,
      `${siteId} artwork must not also render as permanent terrain`);
  }
  assert.equal(TILED_WORLD.sites.some(site => /lopukh.*(?:workbench|workshop)|(?:workbench|workshop).*lopukh/.test(site.id)), false,
    "Lopukh's animated workbench remains deferred; the existing economy workshop stays separate");
  assert.equal(TILED_WORLD.sites.some(site => site.id === "woodlot"), false,
    "the original woodlot raster stays removed; its economic station is hosted by the rabbit home");
  assert.equal(TILED_WORLD.terrain.some(image => /woodlot/i.test(imagePath(image.image))), false,
    "the removed work plot does not reappear as a permanent terrain image");
});

test("the closed woodlot keeps its footprint and selects rabbit home 2 only from its third claimed tier", () => {
  const initial = initialPreviewLevels(TILED_WORLD), rabbit = TILED_WORLD.sites.find(site => site.id === "lopukh-home");
  for (const level of [0, 1, 2, 3, 4, 5]) {
    const buildings = { home: 5, woodlot: level }, before = structuredClone(buildings);
    const levels = accountSceneLevels(TILED_WORLD, 5, { levels: initial }, buildings);
    const wanted = level === 0 ? 0 : level >= 3 ? 2 : 1;
    assert.equal(levels["lopukh-home"], wanted, `woodlot ${level}`);
    const visual = previewSiteVisual(rabbit, levels);
    assert.equal(visual.level, wanted);
    if (level === 0) assert.equal(visual.image, "", "the locked home waits for its authored closed exterior");
    else assert.ok(visual.image, "a claimed woodlot selects the corresponding home illustration");
    const selected = previewWorldScene(TILED_WORLD, levels).sites.find(site => site.id === "lopukh-home");
    const authored = wanted === 0 ? rabbit : rabbit.states.find(state => state.level === wanted).geometry;
    assert.deepEqual(selected.collision, authored.collision);
    assert.deepEqual(selected.entry, authored.entry);
    assert.deepEqual(selected.hitArea, authored.hitArea);
    assert.deepEqual(selected.doorway, authored.doorway);
    assert.deepEqual(buildings, before, "visual projection does not upgrade, rename or downgrade account stations");
  }
  const dev = { levels: { ...initial, "lopukh-home": 1 }, previewBuildings: true };
  assert.equal(accountSceneLevels(TILED_WORLD, 5, dev, { woodlot: 5 })["lopukh-home"], 1);
  const scene = previewWorldScene(TILED_WORLD, initial), now = Date.parse("2026-10-17T00:00:00Z");
  const jobs = { ownerPublicId: "woodcutter", revision: 1, jobs: [{ id: "saved-woodlot-order", stationId: "woodlot", stationLevel: 1,
    recipeId: "gather_wood", startedAt: new Date(now - 1000).toISOString(), finishesAt: new Date(now + 1000).toISOString() }] };
  const frames = forestProductionFrames(jobs, scene, { "lopukh-home": { level: 1 } }, now, 1);
  assert.equal(frames.length, 1); assert.equal(frames[0].stationId, "woodlot");
  assert.equal(frames[0].jobId, "saved-woodlot-order"); assert.equal(frames[0].phase, "working");
  assert.deepEqual({ x: frames[0].x, y: frames[0].y }, scene.sites.find(site => site.id === "lopukh-home").entry);
});

test("registered artwork keeps the author's exact tile placement and rotations", () => {
  for (const { objectId, siteId, level, file } of authoredImages) {
    const authored = sourceObjects.find(object => object.id === objectId);
    assert.ok(authored, `${siteId} source tile ${objectId} exists`);
    const effective = siteAtLevel(siteId, level), placement = effective.imagePlacement ?? { ...effective.bounds, rotation: 0 };
    for (const [key, expected] of Object.entries({ x: authored.x, y: authored.y, width: authored.width,
      height: authored.height, rotation: authored.rotation ?? 0 })) close(placement[key], expected, `${siteId} ${level}.${key}`);
    const site = TILED_WORLD.sites.find(item => item.id === siteId);
    assert.equal(path.basename(imagePath(previewSiteVisual(site, { [siteId]: level }).image)), file);
    const angle = placement.rotation * Math.PI / 180;
    const corners = [[0, 0], [placement.width, 0], [placement.width, placement.height], [0, placement.height]]
      .map(([x, y]) => ({ x: placement.x + x * Math.cos(angle) - y * Math.sin(angle),
        y: placement.y + x * Math.sin(angle) + y * Math.cos(angle) }));
    close(effective.bounds.x, Math.min(...corners.map(point => point.x)), `${siteId} envelope.x`);
    close(effective.bounds.y, Math.min(...corners.map(point => point.y)), `${siteId} envelope.y`);
    close(effective.bounds.width, Math.max(...corners.map(point => point.x)) - effective.bounds.x, `${siteId} envelope.width`);
    close(effective.bounds.height, Math.max(...corners.map(point => point.y)) - effective.bounds.y, `${siteId} envelope.height`);
  }
});

test("every new visual footprint blocks actual navigation and remains a building touch target", () => {
  for (const [id, levels] of Object.entries(expectedSites)) for (const level of levels) {
    const selected = previewWorldScene(TILED_WORLD, { ...initialPreviewLevels(TILED_WORLD), [id]: level });
    const site = selected.sites.find(item => item.id === id), point = interiorPoint(site.collision);
    const { x, y, width, height } = site.bounds;
    const isolated = { ...selected, actor: { spawn: point, size: 20 }, sites: [site], campfires: [], water: undefined,
      navigation: { version: 1, cellSize: 4, areas: [{ id: "footprint-test", points: rectangle(x - 40, y - 40, width + 80, height + 80) }],
        obstacles: [], interests: [] } };
    const open = createWorldNavigation({ ...isolated, sites: [] }), blocked = createWorldNavigation(isolated);
    assert.ok(isWalkable(open, point), `${id} ${level} ground is otherwise walkable`);
    assert.equal(isWalkable(blocked, point), false, `${id} ${level} cannot be walked through`);
    assert.ok(blocked.debug.blockers.some(polygon => JSON.stringify(polygon) === JSON.stringify(site.collision)),
      `${id} ${level} uses its authored polygon as a real navigation blocker`);
    assert.equal(previewSiteAt({ ...selected, sites: [site] }, interiorPoint(site.hitArea))?.id, id,
      `${id} ${level} receives taps on its actual shape`);
    assert.equal(previewSiteAt({ ...selected, sites: [site] }, { x: x - 10, y: y - 10 }), null,
      `${id} transparent surroundings do not become an oversized button`);
  }
});

test("all five mainland entrances remain connected through every existing building state", () => {
  for (let stage = 0; stage <= 5; stage++) for (const houseLevel of [1, 2]) {
    const levels = Object.fromEntries(TILED_WORLD.sites.map(site => [site.id,
      Math.max(...site.states.map(state => state.level).filter(level => level <= Math.max(stage, site.initialLevel)))]));
    levels.bridge = 1;
    levels["lopukh-home"] = houseLevel;
    const scene = previewWorldScene(TILED_WORLD, levels), navigation = createWorldNavigation(scene);
    assert.ok(navigation, `navigation compiles at stage ${stage}, Lopukh ${houseLevel}`);
    for (const id of Object.keys(expectedSites).filter(id => id !== "market")) {
      const site = scene.sites.find(item => item.id === id), detail = `${id}, stage ${stage}, Lopukh ${houseLevel}`;
      assert.ok(isWalkable(navigation, site.entry), `${detail} has safe feet outside the building`);
      const route = findWorldPath(navigation, scene.actor.spawn, site.entry);
      assert.ok(route?.length >= 2, `${detail} has a route from the home clearing: ${navigation.stats.lastSearch?.reason}`);
      assert.deepEqual(route[0], scene.actor.spawn);
      assert.deepEqual(route.at(-1), site.entry, `${detail} reaches the authored point without snapping`);
      for (let index = 1; index < route.length; index++) assert.ok(canTraverse(navigation, route[index - 1], route[index]),
        `${detail} segment ${index} stays on land and avoids every collision`);
    }
  }
});

test("the market has a safe local road while bridge restoration preserves the existing river barrier", () => {
  // docs/game/building-workbench.md: restoring bridge art unlocks the trading UI;
  // walking across the river remains a separate feature, including at level 1.
  const landing = { x: 560, y: 1055 };
  for (const bridge of [0, 1]) {
    const scene = previewWorldScene(TILED_WORLD, { ...initialPreviewLevels(TILED_WORLD), bridge });
    const navigation = createWorldNavigation(scene), market = scene.sites.find(site => site.id === "market");
    assert.ok(isWalkable(navigation, landing), `bridge ${bridge} leaves the western landing safe`);
    assert.ok(isWalkable(navigation, market.entry), `bridge ${bridge} leaves the market entrance safe`);
    const local = findWorldPath(navigation, landing, market.entry);
    assert.ok(local?.length >= 2, `bridge ${bridge} connects the market's own road and courtyard`);
    assert.deepEqual(local[0], landing);
    assert.deepEqual(local.at(-1), market.entry);
    for (let index = 1; index < local.length; index++) assert.ok(canTraverse(navigation, local[index - 1], local[index]));
    assert.equal(findWorldPath(navigation, scene.actor.spawn, market.entry), null,
      `bridge ${bridge} must not silently enable a physical crossing of the river`);
    assert.equal(findWorldPath(navigation, scene.actor.spawn, landing), null,
      `bridge ${bridge} cannot connect the banks by walking beside the bridge`);
    const riverPoint = { x: 635, y: 1028 };
    assert.ok(scene.water.surfaces.some(surface => previewPointInPolygon(riverPoint, surface.points)),
      "water beneath the bridge remains part of the actual river");
    assert.equal(isWalkable(navigation, riverPoint), false);
  }
});

test("map artwork references resolve to real public files, including all upgrade variants", async () => {
  const references = new Set([...TILED_WORLD.terrain.map(image => image.image),
    ...TILED_WORLD.sites.flatMap(site => site.states.map(state => state.image))]);
  for (const image of references) await assert.doesNotReject(access(path.join(root, "public", imagePath(image))),
    `exported artwork is present: ${image}`);
  for (const tileset of map.tilesets) for (const tile of tileset.tiles ?? []) if (tile.image) {
    await assert.doesNotReject(access(path.resolve(path.dirname(mapPath), tile.image)),
      `Tiled tile ${tile.id} still resolves, including unused tiles`);
  }
});
