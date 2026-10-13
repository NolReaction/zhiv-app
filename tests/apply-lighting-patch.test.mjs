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
  type: typeof value === "number" ? name === "level" ? "int" : "float" : "string", value }));
const group = (id, name, layers, extra = {}) => ({ id, name, type: "group", layers, ...extra });
const layer = (id, name, objects) => ({ id, name, type: "objectgroup", draworder: "index", objects });
const square = size => [{ x: 0, y: 0 }, { x: size, y: 0 }, { x: size, y: size }, { x: 0, y: size }];
const point = (id, role, x, y) => ({ id, name: role, x, y, width: 0, height: 0, point: true,
  properties: props({ role, siteId: "home" }) });
const polygon = (id, name, x, y, extra = {}) => ({ id, name, x, y, width: 0, height: 0, rotation: 0, polygon: square(10), ...extra });

async function fixture(t) {
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
  return { directory, map, mapPath, patchPath, options, scene, makePatch, apply, oak, house };
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
    [patch => { patch.schemaVersion = 2; }, /schemaVersion/],
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
