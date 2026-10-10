import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root,
  resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false } });
after(() => vite.close());
const { initialPhaserOptions, transformKey, getSiteTransform, sanitizePhaserTransform,
  applyPhaserOptions, createPhaserDraft, readPhaserDraft, serializePhaserDraft, phaserMapFingerprint,
  PHASER_LEGACY_GROUND_OWNERS,
} = await vite.ssrLoadModule("/features/world/phaser/model.ts");
const { createWorldNavigation, isWalkable } = await vite.ssrLoadModule("/features/world/navigation/navigation.ts");
const p = (x, y) => ({ x, y });
const rect = (x, y, width, height) => [p(x, y), p(x + width, y), p(x + width, y + height), p(x, y + height)];
function geometry() {
  return {
    bounds: { x: 30, y: 20, width: 10, height: 20 },
    imagePlacement: { x: 40, y: 20, width: 20, height: 10, rotation: 90 },
    anchor: p(35, 40), entry: p(35, 45), doorway: p(35, 38),
    collision: rect(31, 34, 8, 6), hitArea: rect(30, 20, 10, 20),
    light: p(36, 30), chimney: p(35, 21), window: rect(32, 26, 3, 4),
  };
}
function source() {
  const when = { siteId: "workshop", level: 1 };
  const polygon = (id, linked = true) => ({ id, points: rect(32, 34, 6, 5), ...(linked ? { when } : {}) });
  return {
    schemaVersion: 1, id: "phaser-test", width: 300, height: 240,
    focus: { x: 0, y: 0, width: 100, height: 100 }, actor: { spawn: p(10, 50), size: 10 },
    terrain: [
      { id: "world", image: "/world.png", bounds: { x: 0, y: 0, width: 300, height: 240 } },
      { id: "plate", image: "/plate.png", bounds: geometry().bounds, imagePlacement: geometry().imagePlacement, when },
    ],
    sites: [{ id: "workshop", label: "Мастерская", initialLevel: 1, ...geometry(), states: [
      { level: 1, label: "Первый", image: "/first.png", geometry: geometry() },
      { level: 2, label: "Второй", image: "/second.png", geometry: {
        bounds: { x: 80, y: 70, width: 50, height: 50 }, anchor: p(100, 120), entry: p(100, 125),
        collision: rect(90, 105, 25, 15), hitArea: rect(80, 70, 50, 50),
      } },
    ] }],
    paths: [{ id: "approach", siteId: "workshop", points: [p(35, 60), p(35, 45)] }, { id: "forest", points: [p(10, 50), p(20, 50)] }],
    navigation: { version: 1, cellSize: 3, areas: [{ id: "world", points: rect(0, 0, 300, 240) }, polygon("local")],
      obstacles: [polygon("attached"), polygon("world-obstacle", false)], interests: [{ id: "look", position: p(10, 20), activity: "look" }] },
    occluders: [{ ...polygon("silhouette"), frontY: 39 }, { ...polygon("world-tree", false), frontY: 39 }],
    destinations: [{ id: "work", siteId: "workshop", position: p(35, 45), pauseSeconds: 2 },
      { id: "forest", position: p(90, 90), pauseSeconds: 2 }],
    lights: [{ id: "world-light", position: p(10, 20), kind: "lantern", radius: 30, intensity: 1, color: "#ffddaa", flicker: 0 }],
    audio: {
      emitters: [{ id: "work", siteId: "workshop", profileId: "work", position: p(35, 35),
        activation: "always", innerRadius: 10, outerRadius: 50, gainDb: 0 },
      { id: "world", profileId: "forest", position: p(10, 20), activation: "always", innerRadius: 10, outerRadius: 50, gainDb: 0 }],
      zones: [{ ...polygon("zone"), profileId: "work", fadeDistance: 20, gainDb: -3 }],
    },
  };
}
function deepFreeze(value) {
  if (value && typeof value === "object") { Object.freeze(value); Object.values(value).forEach(deepFreeze); }
  return value;
}
const edit = (scene, transform = { dx: 5, dy: -3, scale: 2 }, level = 1) => ({
  ...initialPhaserOptions(scene), levels: { workshop: level }, transforms: { [transformKey("workshop", level)]: transform },
});

test("initial lab choices are independent and respect authored levels", () => {
  const scene = source(), first = initialPhaserOptions(scene), second = initialPhaserOptions(scene);
  assert.equal(first.selectedSiteId, "workshop"); assert.equal(first.mode, "inspect");
  assert.equal(first.gridSize, 32); assert.equal(first.shadows, true); assert.equal(first.snap, true);
  assert.equal(first.night, false); assert.equal(first.grid, false); assert.equal(first.geometry, false);
  first.levels.workshop = 2; first.transforms.custom = { dx: 1, dy: 2, scale: 1 };
  assert.deepEqual(second.levels, { workshop: 1 }); assert.deepEqual(second.transforms, {});
  assert.equal(initialPhaserOptions({ ...scene, sites: [] }).selectedSiteId, null);
});

test("one anchor transform preserves authored rotation and moves all geometry without changing source", () => {
  const scene = deepFreeze(source()), before = JSON.stringify(scene), options = deepFreeze(edit(scene));
  const world = applyPhaserOptions(scene, options), site = world.sites[0];
  assert.deepEqual(site.bounds, { x: 30, y: -3, width: 20, height: 40 });
  assert.deepEqual(site.imagePlacement, { x: 50, y: -3, width: 40, height: 20, rotation: 90 });
  assert.deepEqual(site.anchor, p(40, 37)); assert.deepEqual(site.entry, p(40, 47)); assert.deepEqual(site.doorway, p(40, 33));
  assert.deepEqual(site.hitArea, rect(30, -3, 20, 40)); assert.deepEqual(site.collision, rect(32, 25, 16, 12));
  assert.deepEqual(site.light, p(42, 17)); assert.deepEqual(site.chimney, p(40, -1)); assert.deepEqual(site.window, rect(34, 9, 6, 8));
  assert.equal(site.states, scene.sites[0].states, "level definitions remain authored input");
  assert.equal(JSON.stringify(scene), before);
  assert.deepEqual(applyPhaserOptions(scene, options), world, "edits do not accumulate on repeated application");
});

test("per-level edits use that level's anchor and optional geometry never leaks between levels", () => {
  const scene = source(), options = edit(scene, { dx: 7, dy: 11, scale: 0.5 }, 2);
  options.transforms[transformKey("workshop", 1)] = { dx: 100, dy: 200, scale: 3 };
  const site = applyPhaserOptions(scene, options).sites[0];
  assert.deepEqual(site.anchor, p(107, 131)); assert.deepEqual(site.bounds, { x: 97, y: 106, width: 25, height: 25 });
  assert.deepEqual(site.entry, p(107, 133.5));
  for (const key of ["imagePlacement", "doorway", "light", "chimney", "window"]) assert.equal(site[key], undefined);
  assert.equal(applyPhaserOptions(scene, options).terrain.length, 1, "other-level plates are filtered first");
  const resetLevelTwo = applyPhaserOptions(scene, { ...options, transforms: { [transformKey("workshop", 1)]: options.transforms[transformKey("workshop", 1)] } });
  assert.deepEqual(resetLevelTwo.sites[0].anchor, p(100, 120));
});

test("explicit attachments, radii and occluder depth move together; world objects stay fixed", () => {
  const scene = source(), world = applyPhaserOptions(scene, edit(scene));
  assert.deepEqual(world.terrain[1].bounds, world.sites[0].bounds);
  assert.deepEqual(world.terrain[1].imagePlacement, world.sites[0].imagePlacement);
  assert.deepEqual(world.navigation.areas[1].points, rect(34, 25, 12, 10));
  assert.deepEqual(world.navigation.obstacles[0].points, rect(34, 25, 12, 10));
  assert.deepEqual(world.occluders[0].points, rect(34, 25, 12, 10)); assert.equal(world.occluders[0].frontY, 35);
  assert.deepEqual(world.paths[0].points, [p(40, 77), p(40, 47)]); assert.deepEqual(world.destinations[0].position, p(40, 47));
  assert.deepEqual(world.audio.emitters[0].position, p(40, 27));
  assert.equal(world.audio.emitters[0].innerRadius, 20); assert.equal(world.audio.emitters[0].outerRadius, 100);
  assert.deepEqual(world.audio.zones[0].points, rect(34, 25, 12, 10)); assert.equal(world.audio.zones[0].fadeDistance, 40);
  for (const [left, right] of [[world.terrain[0], scene.terrain[0]], [world.paths[1], scene.paths[1]],
    [world.navigation.obstacles[1], scene.navigation.obstacles[1]], [world.navigation.interests, scene.navigation.interests],
    [world.occluders[1], scene.occluders[1]], [world.destinations[1], scene.destinations[1]],
    [world.lights, scene.lights], [world.audio.emitters[1], scene.audio.emitters[1]], [world.actor, scene.actor], [world.focus, scene.focus]]) assert.equal(left, right);
});

test("navigation consumes relocated collision, not the original building footprint", () => {
  const scene = source(); scene.navigation.obstacles = [];
  const options = edit(scene, { dx: 100, dy: 0, scale: 1 });
  const nav = createWorldNavigation(applyPhaserOptions(scene, options), 0.5);
  assert.ok(nav); assert.equal(isWalkable(nav, p(35, 37)), true); assert.equal(isWalkable(nav, p(135, 37)), false);
});

test("all Tiled building ground groups and reviewed resident plates follow their owners", async () => {
  const scene = JSON.parse(await readFile(new URL("../features/world/tiled/forest.generated.json", import.meta.url), "utf8"));
  const tiled = JSON.parse(await readFile(new URL("../world/tiled/forest.tmj", import.meta.url), "utf8"));
  const expected = { "builder-home-ground": "builder-home", "plesk-shop-ground": "plesk-shop" };
  function walk(layers, parents = []) {
    for (const layer of layers) {
      const path = [...parents, layer.name];
      if (path[0] === "Buildings" && path.some(name => name.endsWith("-ground"))) {
        for (const object of layer.objects ?? []) if (object.gid) expected[object.name || "terrain-" + object.id] = path[1].toLowerCase();
      }
      if (layer.layers) walk(layer.layers, path);
    }
  }
  walk(tiled.layers);
  assert.deepEqual(PHASER_LEGACY_GROUND_OWNERS, expected, "keep registry aligned with the authored Tiled parent groups");
  for (const [plateId, siteId] of Object.entries(expected)) {
    const options = initialPhaserOptions(scene);
    const site = applyPhaserOptions(scene, options).sites.find(value => value.id === siteId);
    options.transforms[transformKey(siteId, options.levels[siteId])] = { dx: 10, dy: 20, scale: 1.25 };
    const world = applyPhaserOptions(scene, options), plate = scene.terrain.find(value => value.id === plateId);
    assert.ok(plate, plateId);
    const moved = world.terrain.find(value => value.id === plate.id);
    assert.equal(moved.bounds.x, site.anchor.x + (plate.bounds.x - site.anchor.x) * 1.25 + 10);
    assert.equal(moved.bounds.y, site.anchor.y + (plate.bounds.y - site.anchor.y) * 1.25 + 20);
    assert.equal(moved.bounds.width, plate.bounds.width * 1.25); assert.equal(moved.bounds.height, plate.bounds.height * 1.25);
    assert.equal(world.sites.find(value => value.id === siteId).anchor.x, site.anchor.x + 10);
    assert.equal(world.terrain[0], scene.terrain[0], "whole background never follows a building");
  }
  const fake = source(); fake.terrain.push({ ...fake.terrain[0], id: "workshop-ground" });
  assert.equal(applyPhaserOptions(fake, edit(fake)).terrain[2], fake.terrain[2], "similar IDs are not ownership evidence");
});

test("conditional terrain ownership wins over legacy association and is transformed once", () => {
  const scene = source(); scene.terrain[1].id = "lighthouse-ground";
  const world = applyPhaserOptions(scene, edit(scene));
  assert.deepEqual(world.terrain[1].bounds, { x: 30, y: -3, width: 20, height: 40 });
  assert.deepEqual(world.terrain[1].imagePlacement, { x: 50, y: -3, width: 40, height: 20, rotation: 90 });
});

test("bad transient values cannot introduce non-finite or unlimited transforms", () => {
  assert.deepEqual(sanitizePhaserTransform({ dx: Infinity, dy: NaN, scale: -5 }), { dx: 0, dy: 0, scale: 0.25 });
  assert.deepEqual(sanitizePhaserTransform({ dx: 9000, dy: -9000, scale: 10 }), { dx: 4096, dy: -4096, scale: 3 });
  assert.deepEqual(sanitizePhaserTransform({ scale: NaN }), { dx: 0, dy: 0, scale: 1 });
  const transforms = Object.create({ [transformKey("workshop", 1)]: { dx: 5, dy: 6, scale: 2 } });
  assert.deepEqual(getSiteTransform(transforms, "workshop", 1), { dx: 0, dy: 0, scale: 1 });
  assert.notEqual(transformKey("a:1", 2), transformKey("a", 1));
});

test("draft round-trip keeps every level's edit and never persists runtime or player data", () => {
  const scene = source(), options = edit(scene);
  options.transforms[transformKey("workshop", 2)] = { dx: 10, dy: 20, scale: 0.7 };
  const draft = createPhaserDraft(scene, options), restored = readPhaserDraft(scene, serializePhaserDraft(scene, options));
  assert.deepEqual(restored, { levels: options.levels, transforms: options.transforms });
  assert.deepEqual(Object.keys(draft).sort(), ["kind", "levels", "map", "transforms", "version"]);
  restored.transforms[transformKey("workshop", 1)].dx = 100;
  assert.equal(options.transforms[transformKey("workshop", 1)].dx, 5);
});

test("draft map fingerprint ignores object key order but rejects geometry and asset changes", () => {
  const scene = source(), draft = serializePhaserDraft(scene, edit(scene));
  const reordered = Object.fromEntries(Object.entries(scene).reverse());
  assert.equal(phaserMapFingerprint(scene), phaserMapFingerprint(reordered));
  assert.doesNotThrow(() => readPhaserDraft(reordered, draft));
  for (const change of [value => { value.sites[0].states[0].geometry.anchor.x++; },
    value => { value.terrain[0].image = "/new-ground.png"; }, value => { value.width++; },
    value => { value.audio.emitters[0].outerRadius++; }]) {
    const changed = structuredClone(scene); change(changed);
    assert.throws(() => readPhaserDraft(changed, draft), /другой версии карты/);
  }
});

test("invalid drafts cannot load unknown levels, assets, script fields or poisoned transforms", () => {
  const scene = source(), valid = createPhaserDraft(scene, edit(scene)), key = transformKey("workshop", 1);
  for (const modify of [value => { value.version = 2; }, value => { value.image = "https://invalid/script.js"; },
    value => { value.levels.workshop = 999; }, value => { value.levels.missing = 1; },
    value => { value.transforms.missing = { dx: 1, dy: 1, scale: 1 }; },
    value => { value.transforms[key].image = "javascript:alert(1)"; },
    value => { value.transforms[key].dx = Infinity; }, value => { value.transforms[key].dy = "3"; },
    value => { value.transforms[key].scale = 0; }, value => { value.transforms[key].scale = 10; },
    value => { value.transforms[key].dx = 4097; }, value => { value.transforms[key] = null; },
    value => { value.transforms = []; }, value => { value.map.fingerprint = "stale"; }]) {
    const invalid = structuredClone(valid); modify(invalid);
    assert.throws(() => readPhaserDraft(scene, invalid), Error);
  }
  assert.throws(() => readPhaserDraft(scene, "{"), /JSON/);
  assert.throws(() => readPhaserDraft(scene, " ".repeat(65537)), /слишком большой/);
  assert.throws(() => readPhaserDraft(scene, "я".repeat(32769)), /слишком большой/, "UTF-8 bytes, not character count");
  assert.throws(() => readPhaserDraft(scene, JSON.stringify(valid).replace('"levels":{', '"levels":{"__proto__":1,')), /неизвестный/);
  assert.equal({}.polluted, undefined);
});
