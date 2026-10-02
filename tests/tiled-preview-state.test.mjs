import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false } });
after(() => vite.close());
const { initialPreviewLevels, previewSiteVisual, previewWorldScene, setPreviewLevel, upgradePreviewSite, previewSiteAt } = await vite.ssrLoadModule("/features/world/tiled/preview-state.ts");

const site = (id, x, levels) => ({
  id, label: id, bounds: { x, y: 10, width: 20, height: 20 }, anchor: { x: x + 10, y: 30 },
  entry: { x: x + 10, y: 35 }, hitArea: [{ x, y: 10 }, { x: x + 20, y: 10 }, { x: x + 20, y: 30 }, { x, y: 30 }],
  collision: [], initialLevel: levels[0], states: levels.map(level => ({ level, label: String(level), image: `/${id}-${level}.webp` })),
});
const scene = { schemaVersion: 1, id: "test", width: 100, height: 100, terrain: [], focus: { x: 0, y: 0, width: 50, height: 50 },
  sites: [site("home", 10, [1, 2]), site("workshop", 60, [0, 1, 2])], paths: [] };

test("level geometry selects the complete placement without altering other buildings or authoring data", () => {
  const authored = structuredClone(scene), home = authored.sites[0];
  home.doorway = { x: 20, y: 25 };
  home.light = { x: 20, y: 20 };
  const geometry = { bounds: { x: 35, y: 40, width: 20, height: 30 }, anchor: { x: 45, y: 65 },
    entry: { x: 45, y: 75 }, hitArea: [{ x: 35, y: 40 }, { x: 55, y: 40 }, { x: 55, y: 70 }, { x: 35, y: 70 }],
    collision: [{ x: 35, y: 60 }, { x: 55, y: 60 }, { x: 55, y: 70 }] };
  home.states[1].geometry = geometry;
  const original = structuredClone(authored), upgraded = previewWorldScene(authored, { home: 2 });
  assert.equal(previewSiteAt(upgraded, { x: 20, y: 20 }), null);
  assert.equal(previewSiteAt(upgraded, { x: 45, y: 55 })?.id, "home");
  for (const field of Object.keys(geometry)) assert.deepEqual(upgraded.sites[0][field], geometry[field]);
  assert.equal(upgraded.sites[0].doorway, undefined);
  assert.equal(upgraded.sites[0].light, undefined);
  assert.equal(upgraded.sites[1], authored.sites[1]);
  assert.equal(previewWorldScene(authored, { home: 2, workshop: 0 }), upgraded);
  assert.equal(previewWorldScene(authored, { home: 99 }), authored);
  assert.deepEqual(authored, original);
  assert.equal(previewWorldScene(scene, { home: 2 }), scene, "legacy visual levels keep shared geometry");
});

test("conditional debris, walkways and blockers follow selected visuals even without variant geometry", () => {
  const bridge = site("bridge", 10, [0, 1]);
  const image = (id, when) => ({ id, image: `/${id}.png`, bounds: { x: 0, y: 0, width: 5, height: 5 }, ...(when ? { when } : {}) });
  const polygon = (id, when) => ({ id, points: [{ x: 0, y: 0 }, { x: 5, y: 0 }, { x: 0, y: 5 }], ...(when ? { when } : {}) });
  const when = level => ({ siteId: "bridge", level });
  const authored = { ...scene, sites: [bridge], terrain: [image("ground"), image("beams", when(0)), image("deck-detail", when(1))],
    navigation: { version: 1, cellSize: 6, areas: [polygon("shore"), polygon("bridge-walk", when(1))],
      obstacles: [polygon("rock"), polygon("bridge-debris", when(0))], interests: [] } };
  const original = structuredClone(authored);
  const ruins = previewWorldScene(authored, { bridge: 0 });
  assert.deepEqual(ruins.terrain.map(value => value.id), ["ground", "beams"]);
  assert.deepEqual(ruins.navigation.areas.map(value => value.id), ["shore"]);
  assert.deepEqual(ruins.navigation.obstacles.map(value => value.id), ["rock", "bridge-debris"]);
  const restored = previewWorldScene(authored, { bridge: 1 });
  assert.deepEqual(restored.terrain.map(value => value.id), ["ground", "deck-detail"]);
  assert.deepEqual(restored.navigation.areas.map(value => value.id), ["shore", "bridge-walk"]);
  assert.deepEqual(restored.navigation.obstacles.map(value => value.id), ["rock"]);
  assert.equal(restored.sites, authored.sites, "a visibility-only change does not replace site geometry");
  assert.equal(restored.terrain[0], authored.terrain[0]);
  assert.equal(restored.navigation.areas[0], authored.navigation.areas[0]);
  assert.equal(restored.navigation.obstacles[0], authored.navigation.obstacles[0]);
  assert.equal(restored.navigation.interests, authored.navigation.interests);
  assert.equal(previewWorldScene(authored, { bridge: 1 }), restored);
  for (const levels of [{}, { bridge: 99 }, { bridge: NaN }, { bridge: 0, unrelated: 1 }]) {
    assert.equal(previewWorldScene(authored, levels), ruins, "unknown levels use the same fallback and cache as the site image");
  }
  const terrainOnly = { ...authored, navigation: undefined };
  assert.deepEqual(previewWorldScene(terrainOnly, { bridge: 1 }).terrain.map(value => value.id), ["ground", "deck-detail"]);
  const navigationOnly = { ...authored, terrain: [] };
  assert.deepEqual(previewWorldScene(navigationOnly, { bridge: 1 }).navigation.obstacles.map(value => value.id), ["rock"]);
  assert.deepEqual(authored, original);
});

test("conditional visibility and geometry switch together and caches are isolated by source scene", () => {
  const authored = structuredClone(scene), home = authored.sites[0];
  home.states[1].geometry = { bounds: { x: 30, y: 30, width: 20, height: 20 }, anchor: { x: 40, y: 50 },
    entry: { x: 40, y: 55 }, hitArea: [{ x: 30, y: 30 }, { x: 50, y: 30 }, { x: 50, y: 50 }], collision: [] };
  const debris = { id: "home-debris", image: "/debris.png", bounds: { x: 10, y: 10, width: 5, height: 5 }, when: { siteId: "home", level: 1 } };
  authored.terrain = [debris];
  const original = structuredClone(authored), upgraded = previewWorldScene(authored, { home: 2 });
  assert.deepEqual(upgraded.terrain, []);
  assert.equal(previewSiteAt(upgraded, { x: 35, y: 35 })?.id, "home");
  assert.equal(previewWorldScene(authored, { home: 99 }).terrain[0], debris);
  const otherScene = structuredClone(authored);
  assert.notEqual(previewWorldScene(otherScene, { home: 2 }), upgraded);
  assert.deepEqual(authored, original);
});

test("terrain-only preview has no selectable or upgradable site", () => {
  const terrainOnly = { ...scene, sites: [] };
  const levels = initialPreviewLevels(terrainOnly);
  assert.deepEqual(levels, {});
  assert.equal(previewSiteAt(terrainOnly, { x: 20, y: 20 }), null);
  assert.equal(setPreviewLevel(terrainOnly, levels, "home", 1), levels);
  assert.equal(upgradePreviewSite(terrainOnly, levels, "home"), levels);
});

test("upgrading each fixed site leaves the other site and all authored geometry unchanged", () => {
  const original = structuredClone(scene), start = initialPreviewLevels(scene);
  const house = upgradePreviewSite(scene, start, "home");
  assert.deepEqual(start, { home: 1, workshop: 0 });
  assert.deepEqual(house, { home: 2, workshop: 0 });
  const workshop = upgradePreviewSite(scene, house, "workshop");
  assert.deepEqual(workshop, { home: 2, workshop: 1 });
  assert.deepEqual(upgradePreviewSite(scene, workshop, "workshop"), { home: 2, workshop: 2 });
  assert.deepEqual(scene, original);
  assert.equal(upgradePreviewSite(scene, house, "home"), house);
});

test("the preview accepts only authored site IDs and visual levels", () => {
  const levels = initialPreviewLevels(scene);
  for (const invalid of [-1, 3, NaN, Infinity, 1.5]) assert.equal(setPreviewLevel(scene, levels, "home", invalid), levels);
  assert.equal(setPreviewLevel(scene, levels, "new-building", 1), levels);
  assert.equal(upgradePreviewSite(scene, levels, "new-building"), levels);
  assert.equal(previewSiteVisual(scene.sites[0], { home: 99 }).level, 1);
  const other = initialPreviewLevels(scene); other.home = 2;
  assert.equal(levels.home, 1, "preview resets produce independent state objects");
});

test("hit polygons include edges but never select neighbouring ground", () => {
  assert.equal(previewSiteAt(scene, { x: 10, y: 10 })?.id, "home");
  assert.equal(previewSiteAt(scene, { x: 70, y: 20 })?.id, "workshop");
  assert.equal(previewSiteAt(scene, { x: 31, y: 20 }), null);
  assert.equal(previewSiteAt(scene, { x: NaN, y: 20 }), null);
});

test("overlapping hits follow authored Tiled index order rather than anchor height", () => {
  const back = site("back", 10, [1]), front = site("front", 10, [1]);
  back.anchor.y = 40; front.anchor.y = 20;
  assert.equal(previewSiteAt({ ...scene, sites: [back, front] }, { x: 20, y: 20 })?.id, "front");
  assert.equal(previewSiteAt({ ...scene, sites: [front, back] }, { x: 20, y: 20 })?.id, "back");
});
