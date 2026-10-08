import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test, { after, before } from "node:test";
import sharp from "sharp";
import { createServer } from "vite";
import { compileTiledWorld, serializeTiledWorld } from "../scripts/lib/tiled-world.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
let directory, options, vite;
before(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "tiled-audio-"));
  options = { publicDir: path.join(directory, "public"), mapPath: path.join(directory, "world", "fixture.tmj") };
  await mkdir(options.publicDir);
  await sharp({ create: { width: 10, height: 10, channels: 4, background: "#335544" } }).webp().toFile(path.join(options.publicDir, "tile.webp"));
  vite = await createServer({ appType: "custom", configFile: false, root, resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false } });
});
after(async () => { await vite?.close(); await rm(directory, { recursive: true, force: true }); });

const properties = values => Object.entries(values).map(([name, value]) => ({ name, type: typeof value === "number" ? name === "level" || name === "initialLevel" ? "int" : "float" : "string", value }));
const layer = (id, name, objects) => ({ id, name, type: "objectgroup", draworder: "index", objects });
const point = (id, name, values, x = 120, y = 120) => ({ id, name, x, y, width: 0, height: 0, point: true, properties: properties(values) });
const polygon = (id, name, values) => ({ id, name, x: 10, y: 10, width: 0, height: 0, polygon: [{ x: 0, y: 0 }, { x: 80, y: 0 }, { x: 80, y: 50 }, { x: 0, y: 50 }], properties: properties(values) });
const emitter = () => point(50, "workshop-main", { profileId: "workshop.woodworking", siteId: "workshop", stationId: "workshop", activation: "production-working", innerRadius: 25, outerRadius: 180, gainDb: -3 });
const zone = () => polygon(51, "river", { profileId: "river", fadeDistance: 60 });
function fixture(withAudio = true) {
  const tile = (id, values) => ({ id, image: "../public/tile.webp", imagewidth: 10, imageheight: 10, properties: properties(values) });
  const site = (siteId, firstId, firstGid, x) => [
    { id: firstId, name: siteId, x, y: 100, width: 30, height: 30, gid: firstGid, properties: properties({ role: "site", siteId, label: siteId, initialLevel: 0 }) },
    point(firstId + 1, `${siteId}-anchor`, { role: "anchor", siteId }, x + 15, 125),
    point(firstId + 2, `${siteId}-entry`, { role: "entry", siteId }, x + 15, 135),
    ...["hitArea", "collision"].map((role, i) => ({ ...polygon(firstId + 3 + i, role, { role, siteId }), x, y: 100, polygon: [{ x: 0, y: 0 }, { x: 30, y: 0 }, { x: 30, y: 30 }] })),
  ];
  return {
    type: "map", orientation: "orthogonal", width: 400, height: 400, tilewidth: 1, tileheight: 1, properties: properties({ worldId: "audio-test" }),
    tilesets: [{ firstgid: 1, name: "Images", columns: 0, tilecount: 5, tilewidth: 10, tileheight: 10, objectalignment: "topleft", tiles: [tile(0, { role: "terrain" }), ...["workshop", "quarry"].flatMap((siteId, i) => [0, 1].map(level => tile(1 + i * 2 + level, { role: "siteState", siteId, level, label: `${siteId} ${level}` })))] }],
    layers: [layer(1, "World", [
      { id: 1, name: "ground", x: 0, y: 0, width: 400, height: 400, gid: 1 },
      { id: 2, name: "focus", x: 0, y: 0, width: 100, height: 100, properties: properties({ role: "focus" }) },
      ...site("workshop", 10, 2, 100), ...site("quarry", 20, 4, 200),
      point(30, "campfire", { role: "campfire", campfireId: "clearing-fire", radius: 10 }, 300, 300),
      point(31, "campfire-seat", { role: "campfire-seat", campfireId: "clearing-fire" }, 300, 330),
    ]), ...(withAudio ? [layer(2, "AudioEmitters", [emitter()]), layer(3, "AudioZones", [zone()])] : [])],
  };
}
const compile = map => compileTiledWorld(map, options);
const set = (object, name, value) => {
  object.properties = object.properties.filter(p => p.name !== name);
  if (value !== undefined) object.properties.push(...properties({ [name]: value }));
};

test("audio metadata compiles deterministically without changing map data", async () => {
  const map = fixture(), before = structuredClone(map), scene = await compile(map);
  assert.deepEqual(scene.audio.emitters[0], { id: "workshop-main", profileId: "workshop.woodworking", gainDb: -3, position: { x: 120, y: 120 }, activation: "production-working", innerRadius: 25, outerRadius: 180, siteId: "workshop", stationId: "workshop" });
  assert.equal(scene.audio.zones[0].gainDb, 0);
  assert.equal(scene.audio.zones[0].fadeDistance, 60);
  assert.deepEqual(scene.audio.zones[0].points, [{ x: 10, y: 10 }, { x: 90, y: 10 }, { x: 90, y: 60 }, { x: 10, y: 60 }]);
  assert.equal(serializeTiledWorld(scene), serializeTiledWorld(await compile(map)));
  assert.deepEqual(map, before);
});

test("maps without audio remain valid and explicitly empty layers remain empty", async () => {
  assert.equal(Object.hasOwn(await compile(fixture(false)), "audio"), false);
  const map = fixture(false);
  map.layers.push(layer(2, "AudioEmitters", []));
  assert.deepEqual((await compile(map)).audio, { emitters: [], zones: [] });
});

test("audio roles work in ordinary offset groups and editor visibility never disables runtime sources", async () => {
  const map = fixture(false), source = emitter();
  source.visible = false;
  set(source, "role", "audio-emitter");
  map.layers.push({ id: 2, name: "Sound placement", type: "group", offsetx: 10, offsety: 5, layers: [layer(3, "Custom", [source])] });
  assert.deepEqual((await compile(map)).audio.emitters[0].position, { x: 130, y: 125 });
});

test("separate equipment shares a physical site but retains its exact production binding", async () => {
  const map = fixture(), source = map.layers[1].objects[0];
  set(source, "stationId", "kiln");
  set(source, "profileId", "workshop.kiln");
  const result = (await compile(map)).audio.emitters[0];
  assert.equal(result.stationId, "kiln");
  assert.equal(result.siteId, "workshop");
});

test("negative decibels accept Tiled integer properties as well as floating point properties", async () => {
  const map = fixture();
  map.layers[1].objects[0].properties.find(p => p.name === "gainDb").type = "int";
  assert.equal((await compile(map)).audio.emitters[0].gainDb, -3);
});

test("campfire source references an existing authored fire", async () => {
  const map = fixture();
  map.layers[1].objects = [point(50, "fire-audio", { profileId: "campfire", activation: "campfire-lit", campfireId: "clearing-fire" }, 300, 300)];
  assert.equal((await compile(map)).audio.emitters[0].campfireId, "clearing-fire");
});

const invalidCases = [
  ["unknown profile", (e) => set(e, "profileId", "river.typo"), /unknown audio profile/],
  ["music as spatial source", (e) => set(e, "profileId", "music.day"), /must contain only loop cues/],
  ["unknown station", (e) => set(e, "stationId", "missing"), /unknown audio station/],
  ["wrong physical host", (e) => set(e, "stationId", "quarry"), /does not belong to site/],
  ["missing production binding", (e) => set(e, "stationId", undefined), /requires stationId/],
  ["unknown site", (e) => { set(e, "siteId", "missing"); set(e, "stationId", undefined); set(e, "activation", "always"); }, /unknown site/],
  ["unknown activation", (e) => set(e, "activation", "sometimes"), /unknown audio activation/],
  ["missing fire binding", (e) => set(e, "activation", "campfire-lit"), /requires campfireId/],
  ["unknown fire", (e) => { set(e, "activation", "campfire-lit"); set(e, "campfireId", "missing"); }, /unknown campfire/],
  ["unexpected fire binding", (e) => set(e, "campfireId", "clearing-fire"), /campfireId requires activation/],
  ["negative inner radius", (e) => set(e, "innerRadius", -1), /finite number >= 0/],
  ["inverted radii", (e) => set(e, "outerRadius", 10), /outerRadius must be greater/],
  ["nonfinite radius", (e) => set(e, "outerRadius", Infinity), /finite number/],
  ["excessive gain", (e) => set(e, "gainDb", 20), /gainDb must/],
  ["unknown level", (e) => set(e, "level", 99), /unknown visual level/],
  ["level without site", (e) => { set(e, "siteId", undefined); set(e, "level", 1); }, /requires siteId and level/],
  ["ellipse emitter", (e) => { delete e.point; e.ellipse = true; }, /ellipse.*not supported/],
  ["rectangle emitter", (e) => { delete e.point; }, /expected "point"/],
  ["unknown property", (e) => set(e, "outerRaduis", 200), /unknown property/],
];
for (const [name, mutate, expected] of invalidCases) test(`audio rejects ${name}`, async () => {
  const map = fixture();
  mutate(map.layers[1].objects[0]);
  await assert.rejects(compile(map), expected);
});

test("audio IDs are unique across emitter and zone layers", async () => {
  const map = fixture();
  map.layers[2].objects[0].name = "workshop-main";
  await assert.rejects(compile(map), /duplicate audio ID/);
});

test("zones reject a zero fade, intersecting polygon and site with no level", async () => {
  const map = fixture(), source = map.layers[2].objects[0];
  set(source, "fadeDistance", 0);
  await assert.rejects(compile(map), /finite number/);
  set(source, "fadeDistance", 60);
  set(source, "siteId", "workshop");
  await assert.rejects(compile(map), /siteId requires level/);
  set(source, "level", 1);
  assert.deepEqual((await compile(map)).audio.zones[0].when, { siteId: "workshop", level: 1 });
  source.polygon = [{ x: 0, y: 0 }, { x: 30, y: 30 }, { x: 0, y: 25 }, { x: 30, y: 0 }];
  await assert.rejects(compile(map), /self-intersect|nonzero area/);
});

test("audio visibility follows selected site visual levels without mutating source scene", async () => {
  const { previewWorldScene } = await vite.ssrLoadModule("/features/world/tiled/preview-state.ts");
  const map = fixture();
  set(map.layers[1].objects[0], "level", 1);
  const scene = await compile(map), original = structuredClone(scene);
  assert.equal(previewWorldScene(scene, { workshop: 0 }).audio.emitters.length, 0);
  const upgraded = previewWorldScene(scene, { workshop: 1 });
  assert.equal(upgraded.audio.emitters.length, 1);
  assert.equal(upgraded.audio.zones, scene.audio.zones);
  assert.equal(previewWorldScene(scene, { workshop: 1 }), upgraded);
  assert.equal(previewWorldScene(scene, { workshop: 99 }).audio.emitters.length, 0);
  assert.deepEqual(scene, original);
});
