import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import sharp from "sharp";
import { compileTiledWorld, readTiledWorld, serializeTiledWorld } from "../scripts/lib/tiled-world.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const run = promisify(execFile);
const props = values => Object.entries(values).map(([name, value]) => ({ name, type: typeof value === "number" ? "int" : "string", value }));
const clone = value => structuredClone(value);
const setProp = (object, name, value) => { object.properties.find(property => property.name === name).value = value; };
const spawn = () => ({
  id: 10, name: "mochlik-spawn", x: 35, y: 55, width: 0, height: 0, point: true,
  properties: [{ name: "role", type: "string", value: "spawn" }, { name: "size", type: "float", value: 12.5 }],
});
const waterPolygon = (id, name = "", x = 30.125, y = 50.375) => ({
  id, name, x, y, width: 0, height: 0,
  polygon: [{ x: -10.0625, y: -20.125 }, { x: 15.25, y: -20.125 }, { x: 15.25, y: 5.5 }, { x: -10.0625, y: 5.5 }],
});
const waterLayer = (id, name, objects) => ({ id, name, type: "objectgroup", draworder: "topdown", objects });
const layerObjects = layers => layers.flatMap(layer => layer.layers ? layerObjects(layer.layers) : layer.objects);

async function fixture(t, { directoryRoot = tmpdir() } = {}) {
  const directory = await mkdtemp(path.join(directoryRoot, "tiled-world-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const publicDir = path.join(directory, "public");
  const mapPath = path.join(directory, "world", "fixture.tmj");
  await mkdir(publicDir);
  await mkdir(path.dirname(mapPath));
  const writeImage = (name, width, height, background) => sharp({ create: { width, height, channels: 4, background } }).webp().toFile(path.join(publicDir, name));
  await Promise.all([
    writeImage("ground.webp", 200, 200, "#284533"),
    writeImage("kiln-0.webp", 40, 60, "#755546"),
    writeImage("kiln-1.webp", 80, 120, "#a8693b"),
  ]);
  const object = (id, name, x, y, width, height, role, extra = {}) => ({ id, name, x, y, width, height, rotation: 0, visible: true, properties: props({ role }), ...extra });
  const marker = (id, role, x, y) => object(id, role, x, y, 0, 0, role, { point: true, properties: props({ role, siteId: "kiln" }) });
  const polygon = (id, role) => object(id, role, 25, 35, 0, 0, role, { polygon: [{ x: -5, y: -5 }, { x: 10, y: -5 }, { x: 10, y: 20 }, { x: -5, y: 20 }], properties: props({ role, siteId: "kiln" }) });
  const tile = (id, image, imagewidth, imageheight, values) => ({ id, image: `../public/${image}`, imagewidth, imageheight, properties: props(values) });
  const map = {
    type: "map", orientation: "orthogonal", infinite: false, width: 100, height: 100, tilewidth: 1, tileheight: 1, properties: props({ worldId: "test-forest" }),
    tilesets: [{ firstgid: 1, name: "Images", columns: 0, tilecount: 3, tilewidth: 200, tileheight: 200, objectalignment: "topleft", tiles: [
      tile(0, "ground.webp", 200, 200, { role: "terrain" }),
      tile(1, "kiln-0.webp", 40, 60, { role: "siteState", siteId: "kiln", level: 0, label: "Cold kiln" }),
      tile(2, "kiln-1.webp", 80, 120, { role: "siteState", siteId: "kiln", level: 1, label: "Working kiln" }),
    ] }],
    layers: [{ id: 1, name: "World", type: "objectgroup", draworder: "index", objects: [
      object(1, "ground", 0, 0, 100, 100, "terrain", { gid: 1 }),
      object(2, "kiln-preview", 20, 30, 20, 30, "site", { gid: 2, properties: props({ role: "site", siteId: "kiln", label: "Pottery kiln", initialLevel: 1 }) }),
      marker(3, "anchor", 30, 50), marker(4, "entry", 30, 60), marker(5, "light", 32, 40),
      polygon(6, "hitArea"), polygon(7, "collision"),
      object(8, "focus", 10, 20, 50, 50, "focus"),
      object(9, "clearing-walk", 30, 60, 0, 0, "path", { polyline: [{ x: 0, y: 0 }, { x: 10, y: 10 }, { x: 20, y: 10 }] }),
    ] }],
  };
  const options = { mapPath, publicDir };
  return { map, options, directory, writeImage, compile: value => compileTiledWorld(value ?? map, options) };
}

test("Tiled source compiles physical image scale, top-left objects and local geometry into deterministic world coordinates", async t => {
  const { map, options, compile } = await fixture(t);
  const scene = await compile();
  assert.equal(scene.schemaVersion, 1);
  assert.equal(scene.id, "test-forest");
  assert.equal(Object.hasOwn(scene, "actor"), false, "legacy maps may omit a spawn point");
  assert.equal(Object.hasOwn(scene, "water"), false, "legacy maps do not invent water geometry");
  assert.equal(Object.hasOwn(scene, "lights"), false, "legacy maps keep their site light markers without inventing new lights");
  assert.deepEqual(scene.terrain[0].bounds, { x: 0, y: 0, width: 100, height: 100 });
  assert.deepEqual(scene.sites[0], {
    id: "kiln", label: "Pottery kiln", bounds: { x: 20, y: 30, width: 20, height: 30 },
    anchor: { x: 30, y: 50 }, entry: { x: 30, y: 60 },
    hitArea: [{ x: 20, y: 30 }, { x: 35, y: 30 }, { x: 35, y: 55 }, { x: 20, y: 55 }],
    collision: [{ x: 20, y: 30 }, { x: 35, y: 30 }, { x: 35, y: 55 }, { x: 20, y: 55 }],
    light: { x: 32, y: 40 }, initialLevel: 1,
    states: [
      { level: 0, label: "Cold kiln", image: scene.sites[0].states[0].image },
      { level: 1, label: "Working kiln", image: scene.sites[0].states[1].image },
    ],
  });
  assert.deepEqual(scene.paths, [{ id: "clearing-walk", points: [{ x: 30, y: 60 }, { x: 40, y: 70 }, { x: 50, y: 70 }] }]);
  const bytes = await readFile(path.join(options.publicDir, "kiln-1.webp"));
  const hash = createHash("sha256").update(bytes).digest("hex").slice(0, 12);
  assert.equal(scene.sites[0].states[1].image, `/kiln-1.webp?v=${hash}`);
  const serialized = serializeTiledWorld(scene);
  assert.equal(serialized.includes(options.publicDir), false);
  assert.equal(serialized, serializeTiledWorld(await compile()));
  await writeFile(options.mapPath, JSON.stringify(map));
  assert.deepEqual(await readTiledWorld(options.mapPath, options.publicDir), scene);
  assert.equal(map.layers[0].objects[1].gid, 2, "initial level may differ from the editor preview tile");
});

test("moving authoring geometry and replacing image bytes changes only the generated data it owns", async t => {
  const { map, compile, writeImage } = await fixture(t);
  const before = await compile();
  map.layers[0].objects[1].x += 10;
  map.layers[0].objects[2].x += 10;
  const moved = await compile();
  assert.equal(moved.sites[0].bounds.x, before.sites[0].bounds.x + 10);
  assert.equal(moved.sites[0].anchor.x, before.sites[0].anchor.x + 10);
  assert.deepEqual(moved.sites[0].states, before.sites[0].states);
  await writeImage("kiln-1.webp", 80, 120, "#208040");
  const updated = await compile();
  assert.notEqual(updated.sites[0].states[1].image, moved.sites[0].states[1].image);
  assert.equal(updated.sites[0].states[0].image, moved.sites[0].states[0].image);
  assert.deepEqual(updated.sites[0].bounds, moved.sites[0].bounds);
});

test("terrain and focus form a valid scene before any sites or routes are placed", async t => {
  const { map, compile } = await fixture(t);
  map.tilesets[0].tiles = map.tilesets[0].tiles.slice(0, 1);
  map.tilesets[0].tilecount = 1;
  map.layers[0].objects = map.layers[0].objects.filter(object => ["terrain", "focus"].includes(object.properties.find(property => property.name === "role").value));
  const scene = await compile();
  assert.deepEqual(scene.sites, []);
  assert.deepEqual(scene.paths, []);
  assert.equal(scene.actor, undefined);
  assert.equal(scene.terrain.length, 1);
  assert.deepEqual(scene.focus, { x: 10, y: 20, width: 50, height: 50 });
  assert.deepEqual(scene.terrain[0].bounds, { x: 0, y: 0, width: 100, height: 100 }, "physical image pixels do not resize logical coordinates");
});

test("authored focus, spawn, size and path edits are exported in world coordinates", async t => {
  const { map, compile } = await fixture(t);
  const actor = spawn();
  map.layers.push({ id: 2, name: "Actors", type: "objectgroup", draworder: "index", objects: [actor] });
  const before = await compile();
  assert.deepEqual(before.actor, { spawn: { x: 35, y: 55 }, size: 12.5 });
  Object.assign(map.layers[0].objects[7], { x: 5, y: 15, width: 65, height: 65 });
  Object.assign(actor, { x: 40, y: 60 });
  setProp(actor, "size", 18.25);
  map.layers[0].objects[8].polyline[1] = { x: 12, y: 15 };
  const after = await compile();
  assert.deepEqual(after.focus, { x: 5, y: 15, width: 65, height: 65 });
  assert.deepEqual(after.actor, { spawn: { x: 40, y: 60 }, size: 18.25 });
  assert.deepEqual(after.paths, [{ id: "clearing-walk", points: [{ x: 30, y: 60 }, { x: 42, y: 75 }, { x: 50, y: 70 }] }]);
  assert.deepEqual(after.terrain, before.terrain);
  assert.deepEqual(after.sites, before.sites);
  actor.properties[1] = { name: "size", type: "int", value: 18 };
  assert.deepEqual((await compile()).actor, { spawn: { x: 40, y: 60 }, size: 18 });
});

test("clearing routes opt into local life without changing unmarked prototype paths", async t => {
  const { map, compile } = await fixture(t);
  const route = map.layers[0].objects[8];
  const unmarked = (await compile()).paths[0];
  route.properties.push(...props({ behavior: "clearing" }));
  assert.deepEqual((await compile()).paths[0], { ...unmarked, behavior: "clearing" }, "optional values are left to the life controller");
  route.properties.push(...props({ activity: "look", pauseSeconds: 2 }));
  for (const activity of ["look", "sniff", "groom", "rest"]) {
    setProp(route, "activity", activity);
    assert.deepEqual((await compile()).paths[0], { ...unmarked, behavior: "clearing", activity, pauseSeconds: 2 });
  }
  route.properties.find(property => property.name === "pauseSeconds").type = "float";
  setProp(route, "pauseSeconds", 4.5);
  assert.equal((await compile()).paths[0].pauseSeconds, 4.5);
  setProp(route, "pauseSeconds", 20);
  assert.equal((await compile()).paths[0].pauseSeconds, 20);
  route.properties.push(...props({ siteId: "kiln" }));
  assert.equal((await compile()).paths[0].behavior, "clearing", "existing site ownership remains valid");
});

test("clearing route properties reject misspellings, wrong types and unsupported behavior", async t => {
  const { map, compile } = await fixture(t);
  const route = value => value.layers[0].objects[8];
  route(map).properties.push(...props({ behavior: "clearing", activity: "sniff", pauseSeconds: 4 }));
  const cases = [
    ["unknown behavior", value => { setProp(route(value), "behavior", "journey"); }, /properties\.behavior: expected "clearing"/],
    ["unknown activity", value => { setProp(route(value), "activity", "fishing"); }, /expected look, sniff, groom or rest/],
    ["activity without opt-in", value => { route(value).properties = props({ role: "path", activity: "rest" }); }, /require behavior: clearing/],
    ["pause without opt-in", value => { route(value).properties = props({ role: "path", pauseSeconds: 5 }); }, /require behavior: clearing/],
    ["pause too short", value => { setProp(route(value), "pauseSeconds", 1); }, /from 2 to 20 seconds/],
    ["pause too long", value => { setProp(route(value), "pauseSeconds", 21); }, /from 2 to 20 seconds/],
    ["pause as string", value => { route(value).properties.find(property => property.name === "pauseSeconds").type = "string"; }, /expected float or int/],
    ["behavior as bool", value => { route(value).properties.find(property => property.name === "behavior").type = "bool"; }, /type: expected "string"/],
    ["unknown setting", value => { route(value).properties.push(...props({ speed: 20 })); }, /unknown property "speed"/],
    ["route setting on focus", value => { value.layers[0].objects[7].properties.push(...props({ behavior: "clearing" })); }, /focus only accepts the role/],
    ["route setting on site", value => { value.layers[0].objects[1].properties.push(...props({ activity: "rest" })); }, /site objects only accept/],
  ];
  for (const [name, mutate, pattern] of cases) {
    await t.test(name, async () => {
      const value = clone(map);
      mutate(value);
      await assert.rejects(compile(value), pattern);
    });
  }
});

test("invalid focus and spawn authoring fails instead of ignoring editor changes", async t => {
  const { map, compile } = await fixture(t);
  map.layers.push({ id: 2, name: "Actors", type: "objectgroup", draworder: "index", objects: [spawn()] });
  const cases = [
    ["nonsquare focus", value => { value.layers[0].objects[7].height = 40; }, /objects\[7\]: focus must be square/],
    ["focus outside world", value => { value.layers[0].objects[7].x = 60; }, /rectangle is outside world bounds/],
    ["duplicate focus", value => { value.layers[0].objects.push({ ...clone(value.layers[0].objects[7]), id: 11 }); }, /only one focus rectangle/],
    ["duplicate spawn", value => { value.layers[1].objects.push({ ...spawn(), id: 11 }); }, /only one spawn point/],
    ["spawn outside world", value => { value.layers[1].objects[0].x = 101; }, /point is outside world bounds/],
    ["negative spawn", value => { value.layers[1].objects[0].y = -1; }, /objects\[0\]\.y: expected a finite number >= 0/],
    ["spawn rectangle", value => { delete value.layers[1].objects[0].point; }, /shape: expected "point"/],
    ["disabled point", value => { value.layers[1].objects[0].point = false; }, /point: expected true/],
    ["missing size", value => { value.layers[1].objects[0].properties.pop(); }, /properties\.size: expected a finite number/],
    ["zero size", value => { setProp(value.layers[1].objects[0], "size", 0); }, /spawn size must be positive/],
    ["negative size", value => { setProp(value.layers[1].objects[0], "size", -1); }, /spawn size must be positive/],
    ["oversized actor", value => { setProp(value.layers[1].objects[0], "size", 101); }, /no larger than the smaller world dimension/],
    ["nonfinite size", value => { setProp(value.layers[1].objects[0], "size", Infinity); }, /expected a finite number/],
    ["string size", value => { value.layers[1].objects[0].properties[1] = { name: "size", type: "string", value: "12" }; }, /type: expected float or int/],
    ["fractional int size", value => { value.layers[1].objects[0].properties[1].type = "int"; }, /expected a safe integer/],
    ["wrong spawn role", value => { setProp(value.layers[1].objects[0], "role", "spwan"); }, /unknown marker role "spwan"/],
    ["extra spawn property", value => { value.layers[1].objects[0].properties.push(...props({ siteId: "kiln" })); }, /spawn only accepts role and size/],
    ["size on site", value => { value.layers[0].objects[1].properties.push({ name: "size", type: "float", value: 12 }); }, /site objects only accept/],
    ["size on path", value => { value.layers[0].objects[8].properties.push({ name: "size", type: "float", value: 12 }); }, /path only accepts role, siteId, behavior, activity and pauseSeconds/],
  ];
  for (const [name, mutate, pattern] of cases) {
    await t.test(name, async () => {
      const value = clone(map);
      mutate(value);
      await assert.rejects(compile(value), pattern);
    });
  }
});

test("global IDs resolve across embedded image collections, including sparse tile IDs", async t => {
  const { map, compile } = await fixture(t);
  const original = map.tilesets[0];
  const states = original.tiles.splice(1);
  original.tilecount = 1;
  states[0].id = 2; states[1].id = 8;
  map.tilesets.push({ ...original, firstgid: 10, name: "States", tilecount: 2, tilewidth: 80, tileheight: 120, tiles: states });
  map.layers[0].objects[1].gid = 12;
  const scene = await compile();
  assert.deepEqual(scene.sites[0].states.map(state => state.level), [0, 1]);
  map.layers[0].objects[1].gid = 18;
  assert.deepEqual(await compile(), scene, "swapping the editor preview does not rewrite runtime progression");
});

test("an explicit Tiled 1.12 normal layer blend mode keeps the same scene", async t => {
  const { map, compile } = await fixture(t);
  const before = await compile();
  map.layers[0].mode = "normal";
  assert.deepEqual(await compile(), before);
});

test("unsupported or ambiguous authoring fails with the exact map location", async t => {
  const { map, compile } = await fixture(t);
  const cases = [
    ["external tileset", value => { value.tilesets[0].source = "external.tsj"; }, /map\.tilesets\[0\]\.source: not supported/],
    ["implicit bottom alignment", value => { delete value.tilesets[0].objectalignment; }, /objectalignment: expected "topleft"/],
    ["tile offset", value => { value.tilesets[0].tileoffset = { x: 1, y: 0 }; }, /tileoffset: not supported/],
    ["template", value => { value.layers[0].objects[1].template = "site.tx"; }, /objects\[1\]\.template: not supported/],
    ["rotation", value => { value.layers[0].objects[1].rotation = 15; }, /objects\[1\]\.rotation: expected 0/],
    ["flip bits", value => { value.layers[0].objects[1].gid = 0x80000002; }, /objects\[1\]\.gid: tile flip\/rotation bits/],
    ["hex rotation bit", value => { value.layers[0].objects[1].gid = 0x10000002; }, /tile flip\/rotation bits/],
    ["layer offset", value => { value.layers[0].offsetx = 3; }, /layers\[0\]\.offsetx: expected 0/],
    ["layer blend mode", value => { value.layers[0].mode = "multiply"; }, /layers\[0\]\.mode: expected "normal"/],
    ["group layer", value => { value.layers[0].type = "group"; }, /layers\[0\]\.type: expected "objectgroup"/],
    ["hidden layer", value => { value.layers[0].visible = false; }, /layers\[0\]\.visible: expected true/],
    ["distorted sprite", value => { value.layers[0].objects[1].width = 19; }, /objects\[1\]: object aspect ratio/],
    ["missing entry", value => { value.layers[0].objects.splice(3, 1); }, /site kiln is missing entry/],
    ["unplaced catalog", value => { value.layers[0].objects.splice(1, 1); }, /state catalog kiln has no placed site/],
    ["wrong marker shape", value => { value.layers[0].objects[2].point = false; }, /objects\[2\]\.point: expected true/],
    ["unknown site marker", value => { setProp(value.layers[0].objects[2], "siteId", "missing"); }, /markers reference unknown site missing/],
    ["unknown route owner", value => { value.layers[0].objects[8].properties.push(...props({ siteId: "missing" })); }, /path references unknown site missing/],
    ["duplicate state", value => { setProp(value.tilesets[0].tiles[2], "level", 0); }, /duplicate level 0 for site kiln/],
    ["missing initial state", value => { setProp(value.layers[0].objects[1], "initialLevel", 2); }, /initialLevel 2 is missing/],
    ["duplicate preview", value => { value.layers[0].objects.push({ ...clone(value.layers[0].objects[1]), id: 10 }); }, /more than one preview object/],
    ["duplicate property", value => { value.properties.push(...props({ worldId: "other" })); }, /duplicate property "worldId"/],
    ["mistyped property", value => { value.properties[0].name = "worldID"; }, /unknown property "worldID"/],
    ["outside world", value => { value.layers[0].objects[1].x = 95; }, /rectangle is outside world bounds/],
    ["invalid polygon", value => { value.layers[0].objects[5].polygon = [{ x: 0, y: 0 }, { x: 1, y: 1 }, { x: 2, y: 2 }]; }, /polygon must enclose a nonzero area/],
    ["twice-traced polygon", value => { const polygon = value.layers[0].objects[5].polygon; polygon.push(...clone(polygon)); }, /polygon vertices must be unique/],
    ["self-intersecting polygon", value => { value.layers[0].objects[5].polygon = [{ x: 0, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }, { x: 10, y: 0 }, { x: 15, y: 5 }]; }, /polygon must not self-intersect/],
    ["overlapping polygon edges", value => { value.layers[0].objects[5].polygon = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 5, y: 0 }, { x: 5, y: 10 }]; }, /polygon edges must not overlap/],
  ];
  for (const [name, mutate, pattern] of cases) {
    await t.test(name, async () => {
      const value = clone(map);
      mutate(value);
      await assert.rejects(compile(value), pattern);
    });
  }
});

test("image resolution confines both paths and symlinks, and verifies real pixel metadata", async t => {
  const { map, options, directory, compile } = await fixture(t);
  const cases = [
    ["../private.webp", /image must stay inside public/],
    ["https://example.com/image.webp", /plain file-relative image path/],
    ["/tmp/image.webp", /plain file-relative image path/],
    ["..\\public\\ground.webp", /plain file-relative image path/],
    ["../public/missing.webp", /image does not exist/],
  ];
  for (const [image, pattern] of cases) {
    const value = clone(map);
    value.tilesets[0].tiles[0].image = image;
    await assert.rejects(compile(value), pattern);
  }
  await writeFile(path.join(directory, "private.webp"), await readFile(path.join(options.publicDir, "ground.webp")));
  await symlink(path.join(directory, "private.webp"), path.join(options.publicDir, "linked.webp"));
  const linked = clone(map);
  linked.tilesets[0].tiles[0].image = "../public/linked.webp";
  await assert.rejects(compile(linked), /image symlink must stay inside public/);
  const wrongSize = clone(map);
  wrongSize.tilesets[0].tiles[0].imagewidth = 100;
  await assert.rejects(compile(wrongSize), /imagewidth: expected 200, received 100/);
  const wrongMaximum = clone(map);
  wrongMaximum.tilesets[0].tileheight = 100;
  await assert.rejects(compile(wrongMaximum), /tileheight: expected 200, received 100/);
  const png = await sharp({ create: { width: 200, height: 200, channels: 4, background: "#254070" } }).png().toBuffer();
  const truncated = png.subarray(0, Math.floor(png.length * 0.7));
  assert.equal((await sharp(truncated).metadata()).width, 200, "a damaged image can still have a valid header");
  await writeFile(path.join(options.publicDir, "ground.webp"), truncated);
  await assert.rejects(compile(), /cannot decode image pixels/);
  await writeFile(path.join(options.publicDir, "ground.webp"), "This is not an image");
  await assert.rejects(compile(), /cannot decode image/);
});

test("water surfaces and nested exclusions preserve every authored vertex without role properties", async t => {
  const { map, compile } = await fixture(t);
  const before = await compile();
  const river = waterPolygon(20, "river-main");
  const tributary = waterPolygon(21, "tributary", 35.625, 55.875);
  const leaf = waterPolygon(22, "leaf-1");
  const rock = waterPolygon(23, "", 32.875, 52.125);
  map.layers.splice(1, 0, waterLayer(2, "Water", [river, tributary]));
  map.layers.push({ id: 3, name: "WaterExclusions", type: "group", layers: [
    waterLayer(4, "Leaves", [leaf]),
    { id: 5, name: "Rocks", type: "group", layers: [waterLayer(6, "Small rocks", [rock])] },
  ] });
  const original = clone(map);
  const scene = await compile();
  const absolute = object => object.polygon.map(p => ({ x: object.x + p.x, y: object.y + p.y }));
  assert.deepEqual(scene.water, {
    surfaces: [{ id: "river-main", points: absolute(river) }, { id: "tributary", points: absolute(tributary) }],
    exclusions: [{ id: "leaf-1", points: absolute(leaf) }, { id: "exclusion-23", points: absolute(rock) }],
  }, "distinct polygons may overlap; exclusions may touch or cross a water boundary");
  const unchanged = { ...scene };
  delete unchanged.water;
  assert.deepEqual(unchanged, before, "water metadata does not affect other scene fields or rendering order");
  assert.deepEqual(map, original, "compilation never edits detailed authoring data");
  assert.equal(serializeTiledWorld(scene), serializeTiledWorld(await compile()));
});

test("Water also supports nested groups and WaterExclusions supports a plain object layer", async t => {
  const { map, compile } = await fixture(t);
  map.layers.push({ id: 2, name: "Water", type: "group", layers: [
    { id: 3, name: "Rivers", type: "group", layers: [waterLayer(4, "Main", [waterPolygon(20)])] },
  ] }, waterLayer(5, "WaterExclusions", [waterPolygon(21, "rock-1")]));
  const scene = await compile();
  assert.equal(scene.water.surfaces[0].id, "water-20");
  assert.equal(scene.water.exclusions[0].id, "rock-1");
  map.layers[1].layers = [];
  map.layers[2].objects = [];
  assert.deepEqual((await compile()).water, { surfaces: [], exclusions: [] }, "an emptied authoring mask stays empty");
});

test("invalid water geometry and unsupported nested transforms fail with the object location", async t => {
  const { map, compile } = await fixture(t);
  map.layers.push(waterLayer(2, "Water", [waterPolygon(20, "river-main")]));
  map.layers.push({ id: 3, name: "WaterExclusions", type: "group", layers: [waterLayer(4, "Leaves", [waterPolygon(21, "leaf-1")])] });
  const cases = [
    ["open boundary", value => { const o = value.layers[1].objects[0]; o.polyline = o.polygon; delete o.polygon; }, /\(river-main\) shape: expected "polygon"/],
    ["too few vertices", value => { value.layers[1].objects[0].polygon.length = 2; }, /requires at least 3 points/],
    ["outside world", value => { value.layers[1].objects[0].polygon[0].x = -100; }, /expected a finite number >= 0/],
    ["explicit repeated closure", value => { const p = value.layers[1].objects[0].polygon; p.push(clone(p[0])); }, /polygon vertices must be unique/],
    ["zero area", value => { value.layers[1].objects[0].polygon = [{ x: 0, y: 0 }, { x: 1, y: 1 }, { x: 2, y: 2 }]; }, /polygon must enclose a nonzero area/],
    ["self intersection", value => { value.layers[1].objects[0].polygon = [{ x: 0, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }, { x: 10, y: 0 }, { x: 15, y: 5 }]; }, /\(river-main\): polygon must not self-intersect/],
    ["exclusion rotation", value => { value.layers[2].layers[0].objects[0].rotation = 30; }, /layers\[2\]\.layers\[0\]\.objects\[0\]\.rotation: expected 0/],
    ["group offset", value => { value.layers[2].offsetx = 5; }, /layers\[2\]\.offsetx: expected 0/],
    ["nested layer offset", value => { value.layers[2].layers[0].y = 3; }, /layers\[2\]\.layers\[0\]\.y: expected 0/],
    ["nested layer parallax", value => { value.layers[2].layers[0].parallaxx = 0.5; }, /parallaxx: expected 1/],
    ["hidden group", value => { value.layers[2].visible = false; }, /visible: expected true/],
    ["conflicting group roles", value => { value.layers[2].layers[0].name = "Water"; }, /must not be nested inside each other/],
    ["duplicate nested layer ID", value => { value.layers[2].layers[0].id = 1; }, /duplicate layer ID/],
    ["duplicate nested object ID", value => { value.layers[2].layers[0].objects[0].id = 20; }, /duplicate object ID/],
    ["duplicate surface name", value => { value.layers[1].objects.push({ ...waterPolygon(22), name: "river-main" }); }, /duplicate water surfaces ID river-main/],
    ["duplicate exclusion name", value => { value.layers[2].layers.push(waterLayer(5, "More leaves", [waterPolygon(22, "leaf-1")])); }, /duplicate water exclusions ID leaf-1/],
    ["unexpected object properties", value => { value.layers[1].objects[0].properties = props({ role: "path" }); }, /unknown property "role"/],
    ["non-water topdown", value => { value.layers[0].draworder = "topdown"; }, /layers\[0\]\.draworder: expected "index"/],
  ];
  for (const [name, mutate, pattern] of cases) {
    await t.test(name, async () => {
      const value = clone(map);
      mutate(value);
      await assert.rejects(compile(value), pattern);
    });
  }
});

test("Lights compiles named points and nested groups without changing water or legacy site lighting", async t => {
  const { map, compile } = await fixture(t);
  map.layers.push(waterLayer(2, "Water", [waterPolygon(20, "river-main")]));
  const before = await compile();
  const lantern = { id: 21, name: "home-lantern", x: 35.125, y: 48.625, point: true };
  const torch = { id: 22, name: "Факел у моста", x: 70, y: 90, width: 0, height: 0, point: true, properties: [
    { name: "kind", type: "string", value: "torch" },
    { name: "radius", type: "float", value: 92.5 },
    { name: "color", type: "color", value: "#FFFFA95C" },
    { name: "intensity", type: "float", value: 1.3 },
  ] };
  const glow = { id: 23, name: "glow-mushroom", x: 15, y: 18, point: true, properties: props({ kind: "glow" }) };
  map.layers.push(waterLayer(3, "Lights", [lantern]), { id: 4, name: "Lights", type: "group", layers: [
    { id: 5, name: "Path", type: "group", layers: [{ ...waterLayer(6, "Torches", [torch]), draworder: "index" }] },
    waterLayer(7, "Mushrooms", [glow]),
  ] });
  const original = clone(map);
  const scene = await compile();
  assert.deepEqual(scene.lights, [
    { id: "home-lantern", position: { x: 35.125, y: 48.625 }, kind: "lantern", radius: 70, intensity: 1, color: "#ffd28a", flicker: 0.04 },
    { id: "Факел у моста", position: { x: 70, y: 90 }, kind: "torch", radius: 92.5, intensity: 1.3, color: "#ffa95c", flicker: 0.12 },
    { id: "glow-mushroom", position: { x: 15, y: 18 }, kind: "glow", radius: 70, intensity: 1, color: "#8adbd0", flicker: 0 },
  ]);
  const { lights, ...unchanged } = scene;
  assert.equal(lights.length, 3);
  assert.deepEqual(unchanged, before);
  assert.deepEqual(map, original, "light authoring is not mutated by compilation");
  assert.equal(serializeTiledWorld(scene), serializeTiledWorld(await compile()));
  torch.properties = [
    ...props({ kind: "torch", color: "#abcdef", radius: 500, intensity: 2, flicker: 1 }),
  ];
  lantern.properties = props({ intensity: 0, flicker: 0 });
  const customized = await compile();
  assert.equal(customized.lights[0].intensity, 0);
  assert.deepEqual(customized.lights[1], { ...scene.lights[1], radius: 500, intensity: 2, color: "#abcdef", flicker: 1 });
  map.layers[2].objects = [];
  map.layers[3].layers = [];
  assert.deepEqual((await compile()).lights, [], "clearing the Lights group also removes runtime lights");
});

test("malformed Lights authoring fails at the exact marker rather than silently changing illumination", async t => {
  const { map, compile } = await fixture(t);
  map.layers.push({ id: 2, name: "Lights", type: "group", layers: [waterLayer(3, "Path lights", [
    { id: 20, name: "path-torch", x: 25, y: 35, width: 0, height: 0, point: true, properties: [
      { name: "kind", type: "string", value: "torch" },
      { name: "radius", type: "float", value: 72.5 },
      { name: "intensity", type: "float", value: 1.2 },
      { name: "color", type: "color", value: "#ffbb66" },
      { name: "flicker", type: "float", value: 0.2 },
    ] },
  ])] });
  const light = value => value.layers[1].layers[0].objects[0];
  const cases = [
    ["missing name", value => { delete light(value).name; }, /objects\[0\]\.name: expected a non-empty string/],
    ["blank name", value => { light(value).name = " "; }, /name: expected a non-empty string/],
    ["duplicate name in another light layer", value => { value.layers.push(waterLayer(4, "Lights", [{ ...clone(light(value)), id: 21 }])); }, /duplicate light ID path-torch/],
    ["rectangle", value => { delete light(value).point; }, /shape: expected "point"/],
    ["disabled point", value => { light(value).point = false; }, /point: expected true/],
    ["point with rectangle extent", value => { light(value).width = 2; }, /width: expected 0/],
    ["out of bounds", value => { light(value).x = 101; }, /point is outside world bounds/],
    ["invalid kind", value => { setProp(light(value), "kind", "lamp"); }, /kind: expected lantern, torch or glow/],
    ["zero radius", value => { setProp(light(value), "radius", 0); }, /radius: expected a radius > 0 and <= 500/],
    ["oversized radius", value => { setProp(light(value), "radius", 501); }, /radius: expected a radius > 0 and <= 500/],
    ["negative intensity", value => { setProp(light(value), "intensity", -0.1); }, /intensity: expected intensity between 0 and 2/],
    ["excessive intensity", value => { setProp(light(value), "intensity", 2.1); }, /intensity: expected intensity between 0 and 2/],
    ["negative flicker", value => { setProp(light(value), "flicker", -0.1); }, /flicker: expected flicker between 0 and 1/],
    ["excessive flicker", value => { setProp(light(value), "flicker", 1.1); }, /flicker: expected flicker between 0 and 1/],
    ["nonfinite radius", value => { setProp(light(value), "radius", Infinity); }, /expected a finite number/],
    ["string radius", value => { light(value).properties[1].type = "string"; }, /type: expected float or int/],
    ["numeric color", value => { light(value).properties[3].type = "int"; }, /type: expected color or string/],
    ["short CSS color", value => { setProp(light(value), "color", "#fc0"); }, /color: expected #RRGGBB/],
    ["nonhex color", value => { setProp(light(value), "color", "orange"); }, /color: expected #RRGGBB/],
    ["translucent ARGB color", value => { setProp(light(value), "color", "#80ffbb66"); }, /light color must be opaque; use intensity/],
    ["accidental role property", value => { light(value).properties.push(...props({ role: "light" })); }, /unknown property "role"/],
    ["duplicate property", value => { light(value).properties.push(...props({ intensity: 1 })); }, /duplicate property "intensity"/],
    ["light group offset", value => { value.layers[1].offsetx = 1; }, /offsetx: expected 0/],
    ["hidden nested group", value => { value.layers[1].layers[0].visible = false; }, /visible: expected true/],
    ["Water nested in Lights", value => { value.layers[1].layers[0].name = "Water"; }, /must not be nested inside each other/],
    ["Lights nested in WaterExclusions", value => { value.layers[1].name = "WaterExclusions"; value.layers[1].layers[0].name = "Lights"; }, /must not be nested inside each other/],
  ];
  for (const [name, mutate, pattern] of cases) {
    await t.test(name, async () => {
      const value = clone(map);
      mutate(value);
      await assert.rejects(compile(value), pattern);
    });
  }
});

test("committed authoring exports identically and --check refuses stale output without rewriting it", async t => {
  const directory = await mkdtemp(path.join(tmpdir(), "tiled-check-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const input = path.join(root, "world/tiled/forest.tmj");
  const originalMap = await readFile(input);
  const output = path.join(directory, "forest.generated.json");
  const expected = serializeTiledWorld(await readTiledWorld(input, path.join(root, "public")));
  const scene = JSON.parse(expected);
  const source = JSON.parse(originalMap.toString("utf8"));
  const property = (object, name) => object.properties?.find(property => property.name === name)?.value;
  const objects = layerObjects(source.layers);
  const withRole = role => objects.filter(object => property(object, "role") === role);
  const rect = ({ x, y, width, height }) => ({ x, y, width, height });
  assert.equal(scene.width, source.width);
  assert.equal(scene.height, source.height);
  assert.deepEqual(scene.terrain.map(({ id, bounds }) => ({ id, bounds })),
    withRole("terrain").map(object => ({ id: object.name, bounds: rect(object) })));
  assert.deepEqual(scene.sites.map(({ id, label, bounds, initialLevel }) => ({ id, label, bounds, initialLevel })),
    withRole("site").map(object => ({ id: property(object, "siteId"), label: property(object, "label"),
      bounds: rect(object), initialLevel: property(object, "initialLevel") })));
  assert.deepEqual(scene.paths, withRole("path").map(object => ({ id: object.name,
    points: object.polyline.map(point => ({ x: object.x + point.x, y: object.y + point.y })),
    ...Object.fromEntries(["behavior", "activity", "pauseSeconds"].filter(key => property(object, key) !== undefined).map(key => [key, property(object, key)])) })));
  assert.equal(withRole("focus").length, 1);
  assert.deepEqual(scene.focus, rect(withRole("focus")[0]));
  assert.equal(withRole("spawn").length, 1, "the live forest needs one authored spawn point");
  const actor = withRole("spawn")[0];
  assert.deepEqual(scene.actor, { spawn: { x: actor.x, y: actor.y }, size: property(actor, "size") });
  const authoredWater = source.layers.find(layer => layer.name === "Water");
  const authoredExclusions = source.layers.find(layer => layer.name === "WaterExclusions");
  const waterGeometry = layers => layerObjects(layers).map(object => ({ id: object.name,
    points: object.polygon.map(point => ({ x: object.x + point.x, y: object.y + point.y })) }));
  assert.deepEqual(scene.water, { surfaces: waterGeometry([authoredWater]), exclusions: waterGeometry([authoredExclusions]) });
  assert.equal(await readFile(path.join(root, "features/world/tiled/forest.generated.json"), "utf8"), expected);
  const command = [path.join(root, "scripts/tiled-world.mjs"), input, output];
  await run(process.execPath, command, { cwd: directory });
  assert.equal(await readFile(output, "utf8"), expected);
  await run(process.execPath, [...command, "--check"], { cwd: directory });
  await writeFile(output, "stale\n");
  await assert.rejects(run(process.execPath, [...command, "--check"], { cwd: directory }), error => error.code === 1 && /Generated world is stale/.test(error.stderr));
  assert.equal(await readFile(output, "utf8"), "stale\n");
  assert.deepEqual(await readFile(input), originalMap);
});

test("CLI export refreshes proportional image sizes without moving geometry or rewriting images", async t => {
  // The CLI confines referenced files to the repository's public directory.
  const { map, options, directory, writeImage } = await fixture(t, { directoryRoot: path.join(root, "public") });
  const output = path.join(directory, "scene.generated.json");
  const command = [path.join(root, "scripts/tiled-world.mjs"), options.mapPath, output];
  await writeFile(options.mapPath, `${JSON.stringify(map)}\n`);
  await run(process.execPath, command);
  const originalMap = await readFile(options.mapPath);
  const originalOutput = await readFile(output);
  const before = JSON.parse(originalOutput);

  await writeImage("ground.webp", 100, 100, "#284533");
  await writeImage("kiln-1.webp", 160, 240, "#a8693b");
  const names = ["ground.webp", "kiln-0.webp", "kiln-1.webp"];
  const images = await Promise.all(names.map(name => readFile(path.join(options.publicDir, name))));
  await assert.rejects(run(process.execPath, [...command, "--check"]), error => error.code === 1 && /imagewidth: expected 100, received 200/.test(error.stderr));
  assert.deepEqual(await readFile(options.mapPath), originalMap, "check must not repair source metadata");
  assert.deepEqual(await readFile(output), originalOutput, "check must not regenerate output");

  await run(process.execPath, command);
  const updatedMap = JSON.parse(await readFile(options.mapPath, "utf8"));
  const expectedMap = clone(map);
  Object.assign(expectedMap.tilesets[0].tiles[0], { imagewidth: 100, imageheight: 100 });
  Object.assign(expectedMap.tilesets[0].tiles[2], { imagewidth: 160, imageheight: 240 });
  Object.assign(expectedMap.tilesets[0], { tilewidth: 160, tileheight: 240 });
  assert.deepEqual(updatedMap, expectedMap, "only image metadata may change in the authoring map");
  const after = JSON.parse(await readFile(output, "utf8"));
  assert.deepEqual(after.terrain[0].bounds, before.terrain[0].bounds);
  assert.deepEqual(after.sites.map(site => ({ ...site, states: undefined })), before.sites.map(site => ({ ...site, states: undefined })));
  assert.deepEqual(after.focus, before.focus);
  assert.deepEqual(after.paths, before.paths);
  assert.notEqual(after.terrain[0].image, before.terrain[0].image);
  assert.notEqual(after.sites[0].states[1].image, before.sites[0].states[1].image);
  assert.equal(after.sites[0].states[0].image, before.sites[0].states[0].image);
  await run(process.execPath, [...command, "--check"]);
  for (const [index, name] of names.entries()) {
    assert.deepEqual(await readFile(path.join(options.publicDir, name)), images[index], `${name} must retain the manually exported bytes`);
  }
});

test("CLI export validates the complete refreshed scene before writing either file", async t => {
  const { map, options, directory, writeImage } = await fixture(t, { directoryRoot: path.join(root, "public") });
  const output = path.join(directory, "scene.generated.json");
  const command = [path.join(root, "scripts/tiled-world.mjs"), options.mapPath, output];
  await writeFile(options.mapPath, `${JSON.stringify(map)}\n`);
  await run(process.execPath, command);
  const originalMap = await readFile(options.mapPath);
  const originalOutput = await readFile(output);
  // The first image needs a valid metadata refresh; a later state is distorted.
  await writeImage("ground.webp", 100, 100, "#284533");
  await writeImage("kiln-1.webp", 80, 100, "#a8693b");
  await assert.rejects(run(process.execPath, command), error => error.code === 1 && /object aspect ratio/.test(error.stderr));
  assert.deepEqual(await readFile(options.mapPath), originalMap);
  assert.deepEqual(await readFile(output), originalOutput);

  const unsupported = await sharp({ create: { width: 80, height: 120, channels: 4, background: "#a8693b" } }).gif().toBuffer();
  await writeFile(path.join(options.publicDir, "kiln-1.webp"), unsupported);
  await assert.rejects(run(process.execPath, command), error => error.code === 1 && /only PNG, WebP and JPEG/.test(error.stderr));
  assert.deepEqual(await readFile(options.mapPath), originalMap);
  assert.deepEqual(await readFile(output), originalOutput);
});
