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
    ["group layer", value => { value.layers[0].type = "group"; }, /layers\[0\]\.type: expected "objectgroup"/],
    ["hidden layer", value => { value.layers[0].visible = false; }, /layers\[0\]\.visible: expected true/],
    ["distorted sprite", value => { value.layers[0].objects[1].width = 19; }, /objects\[1\]: object aspect ratio/],
    ["missing entry", value => { value.layers[0].objects.splice(3, 1); }, /site kiln is missing entry/],
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

test("committed authoring exports identically and --check refuses stale output without rewriting it", async t => {
  const directory = await mkdtemp(path.join(tmpdir(), "tiled-check-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const input = path.join(root, "world/tiled/forest.tmj");
  const originalMap = await readFile(input);
  const output = path.join(directory, "forest.generated.json");
  const expected = serializeTiledWorld(await readTiledWorld(input, path.join(root, "public")));
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
