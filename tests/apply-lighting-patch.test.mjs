import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import sharp from "sharp";
import { applyLightingPatch } from "../scripts/apply-lighting-patch.mjs";
import { compileTiledWorld, readTiledWorld } from "../scripts/lib/tiled-world.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const run = promisify(execFile);
const clone = value => structuredClone(value);
const props = values => Object.entries(values).map(([name, value]) => ({ name,
  type: typeof value === "boolean" ? "bool" : typeof value === "number" ? name === "level" ? "int" : "float" : "string", value }));
const group = (id, name, layers, extra = {}) => ({ id, name, type: "group", layers, ...extra });
const layer = (id, name, objects) => ({ id, name, type: "objectgroup", draworder: "index", objects });
const square = size => [{ x: 0, y: 0 }, { x: size, y: 0 }, { x: size, y: size }, { x: 0, y: size }];
const point = (id, role, x, y) => ({ id, name: role, x, y, width: 0, height: 0, point: true,
  properties: props({ role, siteId: "home" }) });
const polygon = (id, name, x, y, extra = {}) => ({ id, name, x, y, width: 0, height: 0, rotation: 0, polygon: square(10), ...extra });

async function fixture(t, { lights = false, emptyLightGroup = false } = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), "lighting-patch-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const publicDir = path.join(directory, "public");
  const mapPath = path.join(directory, "world", "forest.tmj");
  const patchPath = path.join(directory, "lighting-patch.json");
  await mkdir(publicDir);
  await mkdir(path.dirname(mapPath));
  await sharp({ create: { width: 8, height: 8, channels: 4, background: "#447754" } }).webp().toFile(path.join(publicDir, "tile.webp"));
  const tile = (id, values) => ({ id, image: "../public/tile.webp", imagewidth: 8, imageheight: 8, properties: props(values) });
  const oak = polygon(8, "oak", 40, 40, { rotation: 32, class: "ShadowCaster", visible: false,
    properties: props({ height: 20, opacity: 0.7 }) });
  const house = polygon(9, "home-shadow-1", 60, 40, { type: "ShadowCaster",
    properties: props({ height: 35, baseHeight: 2, softness: 3, siteId: "home", level: 1 }) });
  const lamp = { id: 13, name: "path-lamp", x: 25, y: 30, point: true, width: 0, height: 0,
    rotation: 27, visible: false, class: "LightMarker", properties: props({ height: 18, radius: 85 }) };
  const removedLamp = { id: 14, name: "Факел у моста", x: 70, y: 55, point: true, properties: props({ kind: "torch" }) };
  const map = {
    type: "map", orientation: "orthogonal", infinite: false, width: 100, height: 100, tilewidth: 1, tileheight: 1,
    properties: props({ worldId: "test-forest" }),
    tilesets: [{ firstgid: 1, name: "Images", columns: 0, tilecount: 3, tilewidth: 8, tileheight: 8, objectalignment: "topleft", tiles: [
      tile(0, { role: "terrain" }), tile(1, { role: "siteState", siteId: "home", level: 0, label: "Plot" }),
      tile(2, { role: "siteState", siteId: "home", level: 1, label: "Home" }),
    ] }],
    layers: [
      layer(1, "World", [{ id: 1, name: "ground", x: 0, y: 0, width: 100, height: 100, gid: 1, properties: props({ role: "terrain" }) },
        { id: 2, name: "home", x: 10, y: 10, width: 10, height: 10, gid: 2, properties: props({ role: "site", siteId: "home" }) },
        point(3, "anchor", 15, 15), point(4, "entry", 15, 22),
        polygon(5, "home-hit", 10, 10, { properties: props({ role: "hitArea", siteId: "home" }) }),
        polygon(6, "home-collision", 10, 10, { properties: props({ role: "collision", siteId: "home" }) }),
        { id: 11, name: "oak", x: 72, y: 72, width: 8, height: 8, gid: 1, properties: props({ role: "terrain" }) },
        { id: 12, name: "focus", x: 20, y: 20, width: 50, height: 50, properties: props({ role: "focus" }) }]),
      layer(2, "Occluders", [polygon(7, "oak-canopy", 70, 40, { properties: props({ role: "occluder", frontY: 10 }) })]),
      group(3, "Authoring", [group(4, "Lighting", [
        group(5, "ShadowCasters", [layer(6, "Trees and homes", [oak, house])]),
        layer(7, "ShadowReceivers", [polygon(10, "ground-receiver", 30, 60, { type: "ShadowReceiver", properties: [] })]),
      ], { offsetx: -2, offsety: 4, locked: false })], { offsetx: 3, offsety: 2 }),
    ],
  };
  if (lights) {
    map.layers[2].layers[0].layers.push(layer(8, "Lights", [lamp, removedLamp]));
    map.nextobjectid = 41;
    map.nextlayerid = 20;
  } else if (emptyLightGroup) map.layers[2].layers[0].layers.push(group(8, "Lights", []));
  const options = { mapPath, publicDir };
  const scene = await compileTiledWorld(map, options);
  await writeFile(mapPath, `${JSON.stringify(map, null, 2)}\n`);
  const makePatch = (id = "oak", changes = {}) => {
    const before = clone(scene.shadowCasters.find(caster => caster.id === id));
    return { schemaVersion: 1, sceneId: scene.id, casters: [{ id, before, after: { ...clone(before), ...changes } }] };
  };
  const apply = async (patch, extra = {}) => {
    await writeFile(patchPath, JSON.stringify(patch));
    return applyLightingPatch({ patchPath, ...options, ...extra });
  };
  const makeLightPatch = (id = "path-lamp", changes = {}) => {
    const before = clone(scene.lights.find(light => light.id === id));
    return { schemaVersion: 2, sceneId: scene.id, casters: [], lights: [{ id, before, after: { ...clone(before), ...changes } }] };
  };
  return { directory, map, mapPath, patchPath, options, scene, makePatch, makeLightPatch, apply, oak, house, lamp, removedLamp };
}

test("lighting patch reverses nested offsets and arbitrary polygon rotation while preserving all unrelated Tiled authoring", async t => {
  const { map, mapPath, options, scene, makePatch, apply, oak } = await fixture(t);
  const patch = makePatch("oak", { height: 21.25, baseHeight: 8.75, opacity: 0.6, softness: 4.5 });
  patch.casters[0].after.points = patch.casters[0].after.points.map(({ x, y }) => ({ x: x + 2.125, y: y - 1.75 }));
  const result = await apply(patch);
  assert.equal(result.changed, 1);
  const changed = JSON.parse(await readFile(mapPath, "utf8"));
  const actualObject = changed.layers[2].layers[0].layers[0].layers[0].objects[0];
  assert.equal(actualObject.id, oak.id);
  assert.equal(actualObject.name, oak.name);
  assert.equal(actualObject.rotation, oak.rotation);
  assert.equal(actualObject.x, oak.x);
  assert.equal(actualObject.y, oak.y);
  assert.equal(actualObject.class, oak.class);
  assert.equal(actualObject.visible, oak.visible);
  assert.equal(actualObject.properties.find(value => value.name === "height").value, 21.25);
  assert.equal(actualObject.properties.find(value => value.name === "baseHeight").value, 8.75);
  const copyWithoutTarget = clone(changed);
  copyWithoutTarget.layers[2].layers[0].layers[0].layers[0].objects[0] = clone(oak);
  assert.deepEqual(copyWithoutTarget, map, "Occluders, receivers, art, properties, layer transforms and other casters stay intact");
  const compiled = await readTiledWorld(mapPath, options.publicDir);
  const actual = compiled.shadowCasters.find(caster => caster.id === "oak"), expected = patch.casters[0].after;
  actual.points.forEach((point, index) => {
    assert.ok(Math.abs(point.x - expected.points[index].x) < 1e-9);
    assert.ok(Math.abs(point.y - expected.points[index].y) < 1e-9);
  });
  assert.deepEqual(compiled.occluders, scene.occluders);
  assert.deepEqual(compiled.terrain, scene.terrain);
});

test("matching conditional home-level patch updates only that caster and keeps its immutable condition", async t => {
  const { map, mapPath, options, scene, makePatch, apply, house } = await fixture(t);
  const patch = makePatch("home-shadow-1", { height: 48.125, baseHeight: 0 });
  await apply(patch);
  const changed = JSON.parse(await readFile(mapPath, "utf8"));
  const actual = changed.layers[2].layers[0].layers[0].layers[0].objects[1];
  assert.deepEqual(actual.polygon, house.polygon, "numeric-only edits do not introduce coordinate roundoff");
  assert.deepEqual(actual.properties.filter(value => ["siteId", "level"].includes(value.name)), house.properties.filter(value => ["siteId", "level"].includes(value.name)));
  changed.layers[2].layers[0].layers[0].layers[0].objects[1] = clone(house);
  assert.deepEqual(changed, map);
  const result = await readTiledWorld(mapPath, options.publicDir);
  assert.deepEqual(result.shadowCasters[0], scene.shadowCasters[0]);
  assert.deepEqual(result.shadowCasters[1], patch.casters[0].after);
});

test("check and unchanged patches leave source bytes and filesystem contents untouched", async t => {
  const { mapPath, makePatch, apply } = await fixture(t);
  const source = await readFile(mapPath, "utf8"), files = await readdir(path.dirname(mapPath));
  const checked = await apply(makePatch("oak", { height: 80 }), { check: true });
  assert.equal(checked.checked, true);
  assert.equal(checked.changed, 1);
  assert.equal(await readFile(mapPath, "utf8"), source);
  const unchanged = await apply(makePatch());
  assert.equal(unchanged.changed, 0);
  assert.equal(unchanged.unchanged, 1);
  assert.equal(await readFile(mapPath, "utf8"), source);
  assert.deepEqual(await readdir(path.dirname(mapPath)), files);
});

test("stale, unknown, duplicate and immutable-condition edits reject the entire patch without writes", async t => {
  const { mapPath, makePatch, apply } = await fixture(t);
  const cases = [
    [patch => { patch.casters[0].before.height++; }, /stale caster oak/],
    [patch => { patch.casters[0].id = patch.casters[0].before.id = patch.casters[0].after.id = "missing"; }, /unknown caster missing/],
    [patch => { patch.casters.push(clone(patch.casters[0])); }, /duplicate caster oak/],
    [patch => { patch.casters[0].after.id = "changed"; }, /id cannot change/],
    [patch => { patch.casters[0].after.when = { siteId: "home", level: 1 }; }, /condition cannot change/],
    [patch => { patch.sceneId = "different-world"; }, /expected current scene/],
  ];
  const source = await readFile(mapPath, "utf8");
  for (const [mutate, expected] of cases) {
    const patch = makePatch("oak", { height: 30 });
    mutate(patch);
    await assert.rejects(apply(patch), expected);
    assert.equal(await readFile(mapPath, "utf8"), source);
  }
});

test("unsafe JSON fields, numeric limits, bounds and intersecting polygons fail without partial edits", async t => {
  const { mapPath, makePatch, apply } = await fixture(t);
  const cases = [
    [patch => { patch.schemaVersion = 3; }, /schemaVersion/],
    [patch => { patch.unexpected = true; }, /unknown field unexpected/],
    [patch => { patch.casters[0].after.height = 0; }, /after.height/],
    [patch => { patch.casters[0].after.height = 301; }, /after.height/],
    [patch => { patch.casters[0].after.baseHeight = 400; }, /after.baseHeight/],
    [patch => { patch.casters[0].after.opacity = 1.1; }, /after.opacity/],
    [patch => { patch.casters[0].after.softness = 12.1; }, /after.softness/],
    [patch => { patch.casters[0].after.points[0].x = 101; }, /points\[0\].x/],
    [patch => { patch.casters[0].after.points[0].extra = true; }, /unknown field extra/],
    [patch => { patch.casters[0].after.points = [{ x: 20, y: 20 }, { x: 50, y: 40 }, { x: 20, y: 40 }, { x: 40, y: 20 }]; }, /self-intersect/],
    [patch => { patch.casters[0].after.points = [{ x: 20, y: 20 }, { x: 30, y: 30 }, { x: 40, y: 40 }]; }, /nonzero area/],
    [patch => { patch.casters[0].after.points = [{ x: 20, y: 20 }, { x: 40, y: 20 }, { x: 40, y: 40 }, { x: 20, y: 20 }]; }, /unique/],
    [patch => { patch.casters[0].after.points = Array.from({ length: 65 }, (_, i) => ({ x: i, y: i })); }, /3 to 64 vertices/],
  ];
  const source = await readFile(mapPath, "utf8");
  for (const [mutate, expected] of cases) {
    const patch = makePatch("oak", { height: 30 });
    mutate(patch);
    const validSecond = makePatch("home-shadow-1", { height: 60 }).casters[0];
    patch.casters.unshift(validSecond);
    // The invalid edit follows a valid edit so validation cannot partly commit.
    await assert.rejects(apply(patch), expected);
    assert.equal(await readFile(mapPath, "utf8"), source);
    assert.deepEqual(await readdir(path.dirname(mapPath)), ["forest.tmj"]);
  }
});

test("numeric-property decimals preserve unrelated properties and convert Tiled int types only when needed", async t => {
  const { map, mapPath, makePatch, apply } = await fixture(t);
  const authored = map.layers[2].layers[0].layers[0].layers[0].objects[0];
  authored.properties.find(value => value.name === "height").type = "int";
  await writeFile(mapPath, JSON.stringify(map));
  await apply(makePatch("oak", { height: 30.125 }));
  const result = JSON.parse(await readFile(mapPath, "utf8"));
  const height = result.layers[2].layers[0].layers[0].layers[0].objects[0].properties.find(value => value.name === "height");
  assert.deepEqual(height, { name: "height", type: "float", value: 30.125 });
});

test("casters outside Lighting remain untouched even if the compiler accepts their geometry", async t => {
  const { map, mapPath, makePatch, apply } = await fixture(t);
  map.layers[2].layers[0].name = "Other metadata";
  await writeFile(mapPath, JSON.stringify(map));
  const source = await readFile(mapPath, "utf8");
  await assert.rejects(apply(makePatch("oak", { height: 30 })), /inside Lighting\/ShadowCasters/);
  assert.equal(await readFile(mapPath, "utf8"), source);
});

test("bounded malformed patch reading and CLI argument errors fail without touching maps", async t => {
  const { mapPath, patchPath, options, directory } = await fixture(t);
  const source = await readFile(mapPath, "utf8");
  await writeFile(patchPath, "{broken");
  await assert.rejects(applyLightingPatch({ patchPath, ...options }), /invalid JSON/);
  await writeFile(patchPath, " ".repeat(2 * 1024 * 1024 + 1));
  await assert.rejects(applyLightingPatch({ patchPath, ...options }), /no larger than/);
  const help = await run(process.execPath, [path.join(root, "scripts/apply-lighting-patch.mjs"), "--help"], { cwd: directory });
  assert.match(help.stdout, /--check/);
  await assert.rejects(run(process.execPath, [path.join(root, "scripts/apply-lighting-patch.mjs"), "--check", "--map"], { cwd: directory }), /Usage/);
  assert.equal(await readFile(mapPath, "utf8"), source);
});

const studioLight = (id = "studio-light-1", changes = {}) => ({ id, position: { x: 80, y: 80 }, kind: "glow",
  radius: 90, intensity: 0.8, color: "#77bbcc", flicker: 0.05, height: 12, enabled: true, manualPosition: true, ...changes });

test("v2 atomically applies mixed caster edits and light CRUD while retaining source IDs and all unrelated authoring", async t => {
  const { map, mapPath, options, scene, makePatch, makeLightPatch, apply, lamp, removedLamp, oak } = await fixture(t, { lights: true });
  const patch = makeLightPatch("path-lamp", { position: { x: 38.25, y: 44.5 }, kind: "glow", enabled: false, manualPosition: true });
  patch.casters = makePatch("oak", { height: 45 }).casters;
  const created = studioLight();
  patch.lights.push({ id: created.id, before: null, after: created },
    { id: removedLamp.name, before: clone(scene.lights.find(light => light.id === removedLamp.name)), after: null });
  const result = await apply(patch);
  assert.equal(result.changed, 4);
  const changed = JSON.parse(await readFile(mapPath, "utf8"));
  const objects = changed.layers[2].layers[0].layers[2].objects;
  const edited = objects.find(value => value.name === lamp.name), fresh = objects.find(value => value.name === created.id);
  assert.equal(edited.id, lamp.id);
  assert.equal(edited.x, 37.25); assert.equal(edited.y, 38.5, "nested group offsets are reversed once");
  for (const name of ["rotation", "visible", "class", "point", "width", "height"]) assert.equal(edited[name], lamp[name]);
  assert.equal(fresh.id, 41); assert.equal(changed.nextobjectid, 42); assert.equal(changed.nextlayerid, map.nextlayerid);
  assert.equal(objects.some(value => value.name === removedLamp.name), false);
  const compiled = await readTiledWorld(mapPath, options.publicDir);
  assert.deepEqual(compiled.lights.find(light => light.id === lamp.name), patch.lights[0].after,
    "kind changes preserve the requested color/flicker even when old values were compiler defaults");
  assert.deepEqual(compiled.lights.find(light => light.id === created.id), created);
  assert.deepEqual(compiled.occluders, scene.occluders);
  const restored = clone(changed);
  restored.layers[2].layers[0].layers[0].layers[0].objects[0] = clone(oak);
  restored.layers[2].layers[0].layers[2].objects = [clone(lamp), clone(removedLamp)];
  restored.nextobjectid = map.nextobjectid;
  assert.deepEqual(restored, map, "only specified Lights points, caster and ID counter change");
});

test("new v2 sources create proper Lights points and allocate object IDs without disturbing any existing layers", async t => {
  const { map, mapPath, options, scene, apply } = await fixture(t);
  const after = studioLight("studio-light-1", { position: { x: 0, y: 100 }, radius: 500, intensity: 2, flicker: 1, height: 200 });
  const patch = { schemaVersion: 2, sceneId: scene.id, casters: [], lights: [{ id: after.id, before: null, after }] };
  await apply(patch);
  const changed = JSON.parse(await readFile(mapPath, "utf8"));
  assert.deepEqual(changed.layers.slice(0, -1), map.layers);
  const target = changed.layers.at(-1);
  assert.equal(target.name, "Lights"); assert.equal(target.type, "objectgroup"); assert.equal(target.draworder, "index");
  assert.equal(target.id, 8); assert.equal(target.objects[0].id, 13);
  assert.equal(target.objects[0].point, true);
  assert.equal(changed.nextobjectid, 14); assert.equal(changed.nextlayerid, 9);
  assert.deepEqual((await readTiledWorld(mapPath, options.publicDir)).lights, [after]);
});

test("creation in an empty nested Lights group preserves offsets and repairs a stale nextobjectid without reusing IDs", async t => {
  const { map, mapPath, options, scene, apply } = await fixture(t, { emptyLightGroup: true });
  map.nextobjectid = 1;
  await writeFile(mapPath, JSON.stringify(map));
  const after = studioLight("studio-light-2", { position: { x: 0, y: 0 } });
  await apply({ schemaVersion: 2, sceneId: scene.id, casters: [], lights: [{ id: after.id, before: null, after }] });
  const changed = JSON.parse(await readFile(mapPath, "utf8"));
  assert.equal(changed.layers.length, map.layers.length);
  const fresh = changed.layers[2].layers[0].layers[2].layers[0];
  assert.equal(fresh.id, 9); assert.equal(fresh.objects[0].id, 13);
  assert.equal(fresh.objects[0].x, -1); assert.equal(fresh.objects[0].y, -6);
  assert.equal(changed.nextobjectid, 14);
  assert.deepEqual((await readTiledWorld(mapPath, options.publicDir)).lights, [after]);
});

test("v2 check and explicit no-op retain bytes, and reapplying an already applied patch remains a stale-baseline error", async t => {
  const { mapPath, makeLightPatch, apply } = await fixture(t, { lights: true });
  const source = await readFile(mapPath, "utf8"), files = await readdir(path.dirname(mapPath));
  const patch = makeLightPatch("path-lamp", { intensity: 1.5 });
  const checked = await apply(patch, { check: true });
  assert.equal(checked.changed, 1); assert.equal(checked.checked, true);
  assert.equal(await readFile(mapPath, "utf8"), source);
  const noop = await apply(makeLightPatch());
  assert.equal(noop.changed, 0); assert.equal(noop.unchanged, 1);
  assert.equal(await readFile(mapPath, "utf8"), source);
  assert.deepEqual(await readdir(path.dirname(mapPath)), files);
  await apply(patch);
  const applied = await readFile(mapPath, "utf8");
  await assert.rejects(apply(patch), /stale light path-lamp/);
  assert.equal(await readFile(mapPath, "utf8"), applied);
});

test("light optional property removals preserve authoring values and implicit legacy defaults", async t => {
  const { mapPath, options, makeLightPatch, apply } = await fixture(t, { lights: true });
  const patch = makeLightPatch();
  delete patch.lights[0].after.height;
  patch.lights[0].after.enabled = true;
  patch.lights[0].after.manualPosition = false;
  await apply(patch);
  const source = JSON.parse(await readFile(mapPath, "utf8"));
  const values = source.layers[2].layers[0].layers[2].objects[0].properties;
  assert.equal(values.some(value => value.name === "height"), false);
  assert.deepEqual(values.find(value => value.name === "enabled"), { name: "enabled", type: "bool", value: true });
  assert.deepEqual(values.find(value => value.name === "manualPosition"), { name: "manualPosition", type: "bool", value: false });
  const live = (await readTiledWorld(mapPath, options.publicDir)).lights.find(value => value.id === "path-lamp");
  const reset = { schemaVersion: 2, sceneId: patch.sceneId, casters: [], lights: [{ id: live.id, before: live,
    after: { ...live } }] };
  delete reset.lights[0].after.enabled; delete reset.lights[0].after.manualPosition;
  await apply(reset);
  const implicit = (await readTiledWorld(mapPath, options.publicDir)).lights.find(value => value.id === "path-lamp");
  assert.equal(Object.hasOwn(implicit, "enabled"), false); assert.equal(Object.hasOwn(implicit, "manualPosition"), false);
});

test("invalid v2 light data, stale baselines and collisions reject every caster and light change before any writes", async t => {
  const { mapPath, makePatch, makeLightPatch, scene, apply } = await fixture(t, { lights: true });
  const cases = [
    [patch => { patch.lights[0].before.intensity++; }, /stale light/],
    [patch => { patch.lights.push(clone(patch.lights[0])); }, /duplicate light/],
    [patch => { patch.lights[0].after.id = "other-id"; }, /id cannot change/],
    [patch => { patch.lights[0].id = patch.lights[0].before.id = patch.lights[0].after.id = "automatic-only"; }, /unknown authored light/],
    [patch => { patch.lights[0].before = null; }, /already exists/],
    [patch => { patch.lights[0].after.extra = true; }, /unknown field extra/],
    [patch => { patch.lights[0].after.position.x = 101; }, /position.x/],
    [patch => { patch.lights[0].after.position.y = -1; }, /position.y/],
    [patch => { patch.lights[0].after.position.extra = 1; }, /unknown field extra/],
    [patch => { patch.lights[0].after.radius = 0; }, /after.radius/],
    [patch => { patch.lights[0].after.radius = 501; }, /after.radius/],
    [patch => { patch.lights[0].after.height = 0; }, /after.height/],
    [patch => { patch.lights[0].after.height = 200.01; }, /after.height/],
    [patch => { patch.lights[0].after.intensity = 2.01; }, /after.intensity/],
    [patch => { patch.lights[0].after.flicker = -0.01; }, /after.flicker/],
    [patch => { patch.lights[0].after.kind = "lamp"; }, /after.kind/],
    [patch => { patch.lights[0].after.enabled = 0; }, /after.enabled/],
    [patch => { patch.lights[0].after.manualPosition = "true"; }, /after.manualPosition/],
    [patch => { patch.lights[0].after.color = "#80ffeecc"; }, /after.color/],
    [patch => { patch.lights[0].after.color = "#fff"; }, /after.color/],
    [patch => { patch.lights[0].after.intensity = "1"; }, /after.intensity/],
    [patch => { patch.lights[0] = { id: "unused", before: null, after: null }; }, /both be null/],
    [patch => { patch.lights = Array.from({ length: 129 }, () => clone(patch.lights[0])); }, /at most 128/],
    [patch => { delete patch.lights; }, /requires lights/],
    [patch => { patch.schemaVersion = 1; }, /require schemaVersion 2/],
  ];
  const source = await readFile(mapPath, "utf8");
  for (const [mutate, expected] of cases) {
    const patch = makeLightPatch("path-lamp", { intensity: 1.5 });
    patch.casters = makePatch("oak", { height: 60 }).casters;
    patch.lights.unshift({ id: "studio-light-1", before: null, after: studioLight() });
    // Invalid light comes first only for the edit being mutated; a valid caster
    // always precedes all light operations and must never be partially written.
    const creation = patch.lights.shift();
    mutate(patch);
    if (Array.isArray(patch.lights)) patch.lights.push(creation);
    await assert.rejects(apply(patch), expected);
    assert.equal(await readFile(mapPath, "utf8"), source);
    assert.deepEqual(await readdir(path.dirname(mapPath)), ["forest.tmj"]);
  }
  await assert.rejects(apply({ schemaVersion: 2, sceneId: scene.id, casters: [], lights: [{ id: "\nbad", before: null,
    after: studioLight("\nbad") }] }), /without control characters/);
});

test("invalid source ID counters and excessive resulting source counts fail atomically", async t => {
  const { map, mapPath, makePatch, apply, scene } = await fixture(t);
  const patch = { schemaVersion: 2, sceneId: scene.id, casters: makePatch("oak", { height: 60 }).casters,
    lights: [{ id: "studio-light-1", before: null, after: studioLight() }] };
  for (const key of ["nextobjectid", "nextlayerid"]) for (const value of [0, 1.5, "20", Number.MAX_SAFE_INTEGER]) {
    const invalid = { ...clone(map), [key]: value };
    const source = JSON.stringify(invalid);
    await writeFile(mapPath, source);
    await assert.rejects(apply(patch), new RegExp(`map.${key}`));
    assert.equal(await readFile(mapPath, "utf8"), source);
    assert.deepEqual(await readdir(path.dirname(mapPath)), ["forest.tmj"]);
  }
  const populated = clone(map);
  populated.layers.push(layer(8, "Lights", [
    { id: 13, name: "current-lamp", x: 20, y: 20, point: true, properties: [] },
  ]));
  await writeFile(mapPath, JSON.stringify(populated));
  patch.lights = Array.from({ length: 128 }, (_, index) => ({ id: `studio-light-${index + 1}`, before: null,
    after: studioLight(`studio-light-${index + 1}`) }));
  const source = await readFile(mapPath, "utf8");
  await assert.rejects(apply(patch), /at most 128 authored lights/);
  assert.equal(await readFile(mapPath, "utf8"), source);
});
