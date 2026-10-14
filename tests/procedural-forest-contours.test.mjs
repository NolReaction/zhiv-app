import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false } });
after(() => vite.close());
const { marchingSquares, createWaterContourCache } = await vite.ssrLoadModule("/features/world/dev/procedural-forest/terrain/contours.ts");
const { sampleGround, sampleWaterSignedDistance } = await vite.ssrLoadModule("/features/world/dev/procedural-forest/terrain/layout.ts");
const { initialTerrain, applyTerrainPatch, strokeTerrainCells, dirtyTerrainChunks, updateTerrainAppearance } = await vite.ssrLoadModule("/features/world/dev/procedural-forest/terrain/terrain-data.ts");
const { drawTerrain, drawTerrainMaterial } = await vite.ssrLoadModule("/features/world/dev/procedural-forest/terrain/terrain.ts");
const contains = (points, x, y) => {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const a = points[i], b = points[j];
    if ((a[1] > y) !== (b[1] > y) && x < (b[0] - a[0]) * (y - a[1]) / (b[1] - a[1]) + a[0]) inside = !inside;
  }
  return inside;
};
const wet = (contours, x, y) => contours.filter(contour => contains(contour.points ?? contour, x, y)).length % 2 === 1;

test("marching squares keep disconnected ponds, dry islands and holes without crossing chains", () => {
  const bounds = { x: 0, y: 0, width: 12, height: 12 };
  const field = (x, y) => x >= 2 && x <= 10 && y >= 2 && y <= 10 && !(x >= 5 && x <= 7 && y >= 5 && y <= 7) ? 1 : -1;
  const loops = marchingSquares(field, bounds, 1);
  assert.equal(loops.length, 2);
  assert.equal(wet(loops, 3, 3), true);
  assert.equal(wet(loops, 6, 6), false);
  assert.equal(wet(loops, 0, 0), false);
  for (const points of loops) assert.equal(new Set(points.map(point => point.join(":"))).size, points.length);
});

test("bilinear saddle decisions distinguish a connected channel from diagonal touching islands", () => {
  const bounds = { x: 0, y: 0, width: 7, height: 7 };
  for (const points of [[[3, 3], [4, 4]], [[4, 3], [3, 4]]]) {
    const diagonal = (x, y) => points.some(([px, py]) => x === px && y === py);
    assert.equal(marchingSquares((x, y) => diagonal(x, y) ? 1 : -1, bounds, 1).length, 2, "equal saddle keeps corner-touching islands separate");
    assert.equal(marchingSquares((x, y) => diagonal(x, y) ? 2 : -1, bounds, 1).length, 1, "asymptotic decider joins the dominant wet channel");
  }
});

test("zero samples cannot create open chains or ambiguous shared four-way vertices", () => {
  const loops = marchingSquares((x, y) => x === 3 && y === 3 ? 1 : x === 4 && y === 3 ? 0 : -1, { x: 0, y: 0, width: 7, height: 7 }, 1);
  assert.equal(loops.length, 1);
  assert.equal(wet(loops, 3, 3), true);
  assert.equal(wet(loops, 4.2, 3), false);
});

test("coast-only samples preserve the exact old signed water distance", () => {
  for (const [x, y] of [[0, 0], [620, 773], [730, 1270], [1000, 1450], [1599, 1000], [2300, 1200], [3199, 1599]]) {
    assert.equal(sampleWaterSignedDistance(x, y), sampleGround(x, y).water);
  }
});

test("one effective water field adds connected ponds and islands and removes the old shore on restore", () => {
  const cache = createWaterContourCache(), initial = initialTerrain(), base = cache.read(initial);
  assert.equal(wet(base, 256, 256), false);
  assert.equal(wet(base, 1200, 1500), true);
  const pond = strokeTerrainCells({ x: 240, y: 256 }, { x: 400, y: 256 }, 128, "water", 1600);
  const edited = applyTerrainPatch(initial, pond), contours = cache.read(edited);
  assert.equal(wet(contours, 256, 256), true);
  assert.equal(wet(contours, 392, 256), true);
  const island = applyTerrainPatch(edited, strokeTerrainCells({ x: 320, y: 256 }, { x: 320, y: 256 }, 48, "grass", 1600));
  assert.equal(wet(cache.read(island), 320, 256), false);
  assert.deepEqual(cache.read(initial), base, "restoring the initial overrides recreates identical points, normals and arc distances");
  cache.dispose();
});

test("pan and appearance changes reuse contours; only dirty water grids rebuild on preview", () => {
  const cache = createWaterContourCache(), state = initialTerrain();
  const original = cache.read(state), first = cache.diagnostics();
  assert.equal(cache.read(state), original);
  assert.deepEqual(cache.diagnostics(), first);
  assert.equal(cache.read(updateTerrainAppearance(state, { shoreHeight: 24 })), original);
  assert.equal(cache.read(applyTerrainPatch(state, new Map([["15:15", "grass"]]))), original, "repainting distant dry ground does not rebuild water topology");
  assert.deepEqual(cache.diagnostics(), first);
  const cells = strokeTerrainCells({ x: 504, y: 256 }, { x: 536, y: 256 }, 80, "water", 1600);
  const versions = new Map([...dirtyTerrainChunks(cells.keys())].map(key => [key, 1]));
  const preview = { cells, chunkVersions: versions }, previewContours = cache.read(state, preview), changed = cache.diagnostics();
  assert.equal(wet(previewContours, 512, 256), true);
  assert.ok(changed.fieldBuilds - first.fieldBuilds <= 4, "one seam brush only rebuilds local 512px field grids");
  assert.equal(changed.baseSamples, first.baseSamples, "preview reuses all base geometry samples");
  assert.equal(cache.read(state, preview), previewContours);
  assert.deepEqual(cache.diagnostics(), changed);
  assert.deepEqual(cache.read(state), original, "cancelling preview restores the exact baseline loops");
});

test("continuous shore normals and monotonically increasing arc length cross 512px chunk seams", () => {
  const cache = createWaterContourCache(), state = applyTerrainPatch(initialTerrain(), strokeTerrainCells({ x: 448, y: 448 }, { x: 592, y: 592 }, 176, "water", 1600));
  const contours = cache.read(state), pond = contours.find(contour => contains(contour.points, 512, 512));
  assert.ok(pond);
  assert.ok(pond.points.some(point => point[0] < 512) && pond.points.some(point => point[0] > 512));
  for (let i = 0; i < pond.points.length; i++) {
    assert.ok(pond.lengths[i + 1] > pond.lengths[i]);
    assert.ok(Math.abs(Math.hypot(...pond.normals[i]) - 1) < 1e-9);
    const a = pond.normals[i], b = pond.normals[(i + 1) % pond.normals.length];
    assert.ok(a[0] * b[0] + a[1] * b[1] > .5, "smooth contour vertices have no abrupt bank-normal flips");
  }
  assert.ok(pond.length > 500);
});

test("base and repainted grass share clearing gradients, blades and fleck shadows exactly", () => {
  const recordContext = () => {
    const commands = [];
    let gradientId = 0;
    const ctx = new Proxy({}, {
      set(_target, key, value) { commands.push([String(key), value?.gradientId ? `gradient:${value.gradientId}` : value]); return true; },
      get(_target, key) {
        return (...args) => {
          commands.push([String(key), ...args]);
          if (key === "createRadialGradient" || key === "createLinearGradient") return { gradientId: ++gradientId, addColorStop: (...values) => commands.push(["addColorStop", ...values]) };
        };
      },
    });
    return { ctx, commands };
  };
  const base = recordContext(), repaint = recordContext(), bounds = { x: 128, y: 176, width: 128, height: 128 };
  drawTerrain(base.ctx, 7391, bounds, false);
  drawTerrainMaterial(repaint.ctx, 7391, bounds, "grass", false);
  assert.deepEqual(repaint.commands, base.commands);
  assert.ok(repaint.commands.some(command => command[0] === "addColorStop" && command[2] === "#8b9b44a8"), "clearing palette is present in both paths");
  assert.ok(repaint.commands.some(command => command[0] === "fillStyle" && command[1] === "#374f327a"), "grass fleck shadows are present in both paths");
});
