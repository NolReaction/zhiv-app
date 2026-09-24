import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false } });
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
