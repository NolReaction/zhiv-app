import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false } });
after(() => vite.close());
const {
  initialTerrain, cloneTerrain, validateTerrain, terrainCellKey, readTerrainMaterial,
  applyTerrainPatch, strokeTerrainCells, dirtyTerrainChunks, sampleEditedGround,
  CELL_SIZE, TERRAIN_CHUNK_SIZE, MAX_TERRAIN_CELLS,
  terrainAppearance, validateTerrainAppearance, updateTerrainAppearance,
} = await vite.ssrLoadModule("/apps/engine/examples/forest/terrain/terrain-data.ts");
const { sampleGround } = await vite.ssrLoadModule("/apps/engine/examples/forest/terrain/layout.ts");
const preview = cells => ({ cells: new Map(cells), chunkVersions: new Map() });

test("initial terrain preserves the old base and cloned cells remain independent", () => {
  assert.equal(CELL_SIZE, 16);
  assert.equal(TERRAIN_CHUNK_SIZE, 512);
  const first = initialTerrain(), second = initialTerrain();
  assert.deepEqual(first, { baseTrails: true, cells: {} });
  first.cells["1:2"] = "grass";
  assert.deepEqual(second.cells, {});
  const copy = cloneTerrain(first);
  copy.cells["1:2"] = "sand";
  assert.equal(first.cells["1:2"], "grass");
  assert.deepEqual(validateTerrain(first, 1600), first);
  assert.notEqual(validateTerrain(first, 1600).cells, first.cells);
});

test("terrain imports require canonical bounded cells and reject unsafe or unknown data", () => {
  const valid = { baseTrails: false, cells: { "0:0": "water", "99:99": "path" } };
  assert.deepEqual(validateTerrain(valid, 1600), valid);
  assert.ok(validateTerrain({ baseTrails: true, cells: { "199:99": "sand" } }, 3200));
  const unsafe = JSON.parse('{"baseTrails":true,"cells":{"__proto__":"grass"}}');
  const inherited = Object.create({ "0:0": "grass" });
  const symbolCells = { "0:0": "grass", [Symbol("hidden")]: "water" };
  for (const value of [
    null, [], { ...valid, unknown: true }, { baseTrails: 1, cells: {} }, { baseTrails: true },
    { baseTrails: true, cells: [] }, { baseTrails: true, cells: inherited }, unsafe,
    { baseTrails: true, cells: symbolCells }, { baseTrails: true, cells: { "0:0": null } },
    { baseTrails: true, cells: { "0:0": "restore" } },
    ...["00:0", "0:01", "-0:0", "-1:0", "0:100", "100:0", "1.5:0", "1e2:0", "0:0 ", "NaN:0", "constructor"]
      .map(key => ({ baseTrails: true, cells: { [key]: "grass" } })),
  ]) assert.equal(validateTerrain(value, 1600), null);
  for (const width of [0, NaN, Infinity, 1601, 3201]) assert.equal(validateTerrain(valid, width), null);
  const full = Object.fromEntries(Array.from({ length: MAX_TERRAIN_CELLS }, (_, index) => [`${index % 200}:${Math.floor(index / 200)}`, "grass"]));
  assert.ok(validateTerrain({ baseTrails: true, cells: full }, 3200));
  assert.equal(validateTerrain({ baseTrails: true, cells: { ...full, "0:100": "water" } }, 3200), null);
  assert.equal({}.polluted, undefined);
});

test("patches are immutable, remove restored overrides and reuse no-op snapshots", () => {
  const state = Object.freeze({ baseTrails: false, cells: Object.freeze({ "2:3": "path", "4:5": "sand" }) });
  const patch = new Map([["2:3", null], ["6:7", "water"]]);
  const changed = applyTerrainPatch(state, patch);
  assert.deepEqual(changed, { baseTrails: false, cells: { "4:5": "sand", "6:7": "water" } });
  assert.deepEqual(state.cells, { "2:3": "path", "4:5": "sand" });
  assert.notEqual(changed.cells, state.cells);
  assert.equal(patch.size, 2);
  assert.equal(applyTerrainPatch(state, new Map([["2:3", "path"], ["0:0", null]])), state);
  assert.equal(applyTerrainPatch(state, new Map([["__proto__", "water"], ["0:100", "water"], ["200:0", "grass"]])), state);
});

test("cell lookup uses world coordinates and preview restore takes precedence", () => {
  assert.equal(terrainCellKey(31.99, 32), "1:2");
  assert.equal(terrainCellKey(-.1, 0), "-1:0");
  const state = { baseTrails: true, cells: { "1:2": "path" } };
  assert.equal(readTerrainMaterial(20, 40, state), "path");
  assert.equal(readTerrainMaterial(20, 40, state, preview([["1:2", "water"]])), "water");
  assert.equal(readTerrainMaterial(20, 40, state, preview([["1:2", null]])), null);
  assert.equal(readTerrainMaterial(0, 0, state), null);
  assert.equal(readTerrainMaterial(0, 0, state, preview([["0:0", "sand"]])), "sand");
});

test("continuous brush capsules cover gaps between distant pointer events in either direction", () => {
  const from = { x: 8, y: 168 }, to = { x: 1592, y: 168 };
  const stroke = strokeTerrainCells(from, to, 24, "path", 1600);
  for (let column = 0; column < 100; column++) assert.equal(stroke.get(`${column}:10`), "path");
  assert.deepEqual(strokeTerrainCells(to, from, 24, "path", 1600), stroke);
  const diagonal = strokeTerrainCells({ x: 8, y: 8 }, { x: 1592, y: 1592 }, 24, "restore", 1600);
  for (let cell = 0; cell < 100; cell++) assert.equal(diagonal.get(`${cell}:${cell}`), null);
  assert.ok([...diagonal.values()].every(value => value === null));
});

test("brushes clamp diameter and world bounds without projecting off-map strokes onto the border", () => {
  const origin = { x: 0, y: 0 }, end = { x: 1600, y: 1600 };
  assert.deepEqual([...strokeTerrainCells(origin, origin, 24, "grass", 1600)], [["0:0", "grass"]]);
  assert.deepEqual([...strokeTerrainCells(end, end, 24, "grass", 1600)], [["99:99", "grass"]]);
  assert.deepEqual(strokeTerrainCells(origin, origin, 1, "grass", 1600), strokeTerrainCells(origin, origin, 24, "grass", 1600));
  assert.deepEqual(strokeTerrainCells(origin, origin, 999, "grass", 1600), strokeTerrainCells(origin, origin, 320, "grass", 1600));
  assert.equal(strokeTerrainCells({ x: -1000, y: -1000 }, { x: -500, y: -500 }, 320, "sand", 1600).size, 0);
  assert.equal(strokeTerrainCells(origin, { x: NaN, y: 8 }, 24, "sand", 1600).size, 0);
  const east = strokeTerrainCells({ x: 3192, y: 1592 }, { x: 3210, y: 1605 }, 320, "water", 3200);
  assert.ok(east.size > 0);
  for (const key of east.keys()) {
    const [x, y] = key.split(":").map(Number);
    assert.ok(x >= 0 && x < 200 && y >= 0 && y < 100);
  }
});

test("dirty chunks include feather and tile bleed at horizontal, vertical and corner seams", () => {
  assert.deepEqual(dirtyTerrainChunks(["10:10"]), new Set(["0:0"]));
  assert.deepEqual(dirtyTerrainChunks(["31:10"]), new Set(["0:0", "1:0"]));
  assert.deepEqual(dirtyTerrainChunks(["10:31"]), new Set(["0:0", "0:1"]));
  assert.deepEqual(dirtyTerrainChunks(["31:31"]), new Set(["0:0", "1:0", "0:1", "1:1"]));
  assert.deepEqual(dirtyTerrainChunks(["30:10"]), new Set(["0:0", "1:0"]), "feather crosses before the actual cell reaches the seam");
  assert.deepEqual(dirtyTerrainChunks(["0:0"]), new Set(["-1:-1", "0:-1", "-1:0", "0:0"]));
  assert.equal(dirtyTerrainChunks(["-1:0", "__proto__"]).size, 0);
});

test("ground queries honour each explicit material, preview restore and base trail visibility", () => {
  const base = initialTerrain(), x = 620, y = 773, key = terrainCellKey(x, y);
  assert.deepEqual(sampleEditedGround(x, y, base), sampleGround(x, y));
  assert.ok(sampleEditedGround(x, y, base).path > .9);
  const noTrails = { ...base, baseTrails: false };
  assert.equal(sampleEditedGround(x, y, noTrails).path, 0);
  assert.equal(sampleEditedGround(x, y, noTrails).water, sampleEditedGround(x, y, base).water);
  const expected = {
    grass: { path: 0, water: -256, clearing: 0 }, path: { path: 1, water: -256, clearing: 1 },
    sand: { path: 0, water: -256, clearing: 1 }, water: { path: 0, water: 256, clearing: 1 },
  };
  for (const [material, sample] of Object.entries(expected)) {
    const edited = { ...base, cells: { [key]: material } };
    assert.deepEqual(sampleEditedGround(x, y, edited), sample);
    assert.deepEqual(sampleEditedGround(x, y, base, preview([[key, material]])), sample);
    assert.deepEqual(sampleEditedGround(x, y, edited, preview([[key, null]])), sampleGround(x, y));
  }
});

test("appearance is optional in old terrain and validates, clones and survives brush patches", () => {
  const legacy = initialTerrain();
  assert.deepEqual(terrainAppearance(legacy), { shoreStyle: "stone", shoreHeight: 12, blendWidth: 24, scatter: .55 });
  assert.equal("appearance" in validateTerrain(legacy, 1600), false);
  const appearance = { shoreStyle: "natural", shoreHeight: 24, blendWidth: 64, scatter: 1 };
  const changed = updateTerrainAppearance(legacy, appearance);
  assert.deepEqual(validateTerrain(changed, 1600), changed);
  assert.equal("appearance" in legacy, false);
  assert.equal(updateTerrainAppearance(changed, { shoreHeight: 24 }), changed);
  assert.equal(updateTerrainAppearance(changed, { shoreHeight: 25 }), changed);
  const cloned = cloneTerrain(changed); cloned.appearance.shoreHeight = 0;
  assert.equal(changed.appearance.shoreHeight, 24);
  assert.deepEqual(applyTerrainPatch(changed, new Map([["1:1", "grass"]])).appearance, appearance);
  for (const value of [null, {}, { ...appearance, unknown: 0 }, { ...appearance, shoreStyle: "brick" },
    { ...appearance, shoreHeight: -1 }, { ...appearance, shoreHeight: Infinity }, { ...appearance, blendWidth: 7 },
    { ...appearance, blendWidth: 65 }, { ...appearance, scatter: -1 }, { ...appearance, scatter: 1.01 }]) {
    assert.equal(validateTerrainAppearance(value), null);
    assert.equal(validateTerrain({ ...legacy, appearance: value }, 1600), null);
  }
  assert.ok(dirtyTerrainChunks(["26:10"]).has("1:0"), "96px halo reaches neighbours before a wide blend or bank crosses the tile seam");
});
