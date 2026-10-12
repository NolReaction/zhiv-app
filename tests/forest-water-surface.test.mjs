import assert from "node:assert/strict";
import test, { after } from "node:test";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root,
  resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false } });
after(() => vite.close());
const { forestWaterFrame, drawForestWater, isForestWater, FOREST_WATER_LIMITS } = await vite.ssrLoadModule("/features/world/environment/water/forest-water.ts");
const { drawWaterCurrent, drawWaterGlint, forestWaterWind } = await vite.ssrLoadModule("/features/world/environment/water/forest-water-surface.ts");
const { drawWaterBreeze, drawWaterSplash } = await vite.ssrLoadModule("/features/world/environment/water/forest-water-life.ts");
const scene = JSON.parse(await readFile(new URL("../features/world/tiled/forest.generated.json", import.meta.url)));
const options = { elapsed: 10, rain: 0, dusk: 0, reducedMotion: false };
const rectangle = (id, x, y, width, height) => ({ id, points: [
  { x, y }, { x: x + width, y }, { x: x + width, y: y + height }, { x, y: y + height },
] });

// Sample actual painted paths, including rounded stroke caps and rotated drops.
// This checks the renderer's footprint rather than reproducing its safe ellipse.
function paintedPoints() {
  const points = [], stack = [];
  let start, path = [];
  const ctx = {
    lineWidth: 1,
    save() { stack.push(this.lineWidth); }, restore() { this.lineWidth = stack.pop(); },
    beginPath() { path = []; },
    moveTo(x, y) { start = { x, y }; path.push(start); },
    lineTo(x, y) {
      for (let index = 0; index <= 16; index++) path.push({ x: start.x + (x - start.x) * index / 16,
        y: start.y + (y - start.y) * index / 16 });
      start = { x, y };
    },
    bezierCurveTo(x1, y1, x2, y2, x3, y3) {
      for (let index = 0; index <= 16; index++) {
        const t = index / 16, u = 1 - t;
        path.push({ x: u ** 3 * start.x + 3 * u ** 2 * t * x1 + 3 * u * t ** 2 * x2 + t ** 3 * x3,
          y: u ** 3 * start.y + 3 * u ** 2 * t * y1 + 3 * u * t ** 2 * y2 + t ** 3 * y3 });
      }
      start = { x: x3, y: y3 };
    },
    quadraticCurveTo(x1, y1, x2, y2) {
      this.bezierCurveTo(start.x + (x1 - start.x) * 2 / 3, start.y + (y1 - start.y) * 2 / 3,
        x2 + (x1 - x2) * 2 / 3, y2 + (y1 - y2) * 2 / 3, x2, y2);
    },
    ellipse(x, y, rx, ry, rotation, from, to) {
      path.push({ x, y });
      for (let index = 0; index <= 32; index++) {
        const angle = from + (to - from) * index / 32, dx = Math.cos(angle) * rx, dy = Math.sin(angle) * ry;
        path.push({ x: x + dx * Math.cos(rotation) - dy * Math.sin(rotation),
          y: y + dx * Math.sin(rotation) + dy * Math.cos(rotation) });
      }
    },
    stroke() {
      for (const point of path) for (let angle = 0; angle < 2 * Math.PI; angle += Math.PI / 4) {
        points.push({ x: point.x + Math.cos(angle) * this.lineWidth / 2,
          y: point.y + Math.sin(angle) * this.lineWidth / 2 });
      }
    },
    fill() { points.push(...path); },
  };
  return { ctx, points };
}

test("flow, glints and wind crests keep every painted stroke on authored water at several scales", () => {
  const irregular = { ...scene, water: {
    surfaces: [{ id: "bend", points: [{ x: 0, y: 0 }, { x: 230, y: 0 }, { x: 230, y: 85 },
      { x: 100, y: 85 }, { x: 100, y: 210 }, { x: 0, y: 210 }] }],
    exclusions: [rectangle("jetty", 17, 24, 42, 8), rectangle("tiny-leaf", 70, 146, .06, .06)],
  } };
  const transform = (polygons, scale) => polygons.map(p => ({ ...p,
    points: p.points.map(point => ({ x: point.x * scale, y: point.y * scale })) }));
  for (const base of [scene, irregular]) for (const scale of [.25, 1, 2]) {
    const world = { ...base, width: base.width * scale, height: base.height * scale,
      water: { surfaces: transform(base.water.surfaces, scale), exclusions: transform(base.water.exclusions, scale) } };
    const { ctx, points } = paintedPoints();
    for (const elapsed of [0, 1.3, 7.8, 13.6, 21.2]) {
      points.length = 0;
      const frame = forestWaterFrame(world, { ...options, elapsed, wind: 1, dusk: elapsed > 10 ? 1 : 0 });
      for (const current of frame.currents) drawWaterCurrent(ctx, current);
      for (const glint of frame.glints) drawWaterGlint(ctx, glint);
      for (const wave of frame.breeze) drawWaterBreeze(ctx, wave);
      for (const splash of frame.splashes) drawWaterSplash(ctx, splash);
      for (const point of points) assert.ok(isForestWater(world, point), `dry painted point ${point.x},${point.y}, scale ${scale}`);
    }
  }
});

test("wind, night and rain adjust the same surface without replacing its seeds", () => {
  const calm = forestWaterFrame(scene, { ...options, wind: 0 });
  const windy = forestWaterFrame(scene, { ...options, wind: 1 });
  assert.deepEqual(calm.currents.map(p => [p.x, p.y, p.phase]), windy.currents.map(p => [p.x, p.y, p.phase]));
  assert.ok(windy.currents.some((p, i) => p.opacity > calm.currents[i].opacity));
  assert.ok(windy.breeze.some((p, i) => p.opacity > calm.breeze[i].opacity));
  for (const variant of [{ dusk: 1 }, { rain: 1 }]) {
    const frame = forestWaterFrame(scene, { ...options, wind: 0, ...variant });
    assert.ok(frame.glints.every((p, i) => p.opacity <= calm.glints[i].opacity));
    assert.ok(frame.currents.every((p, i) => p.opacity <= calm.currents[i].opacity));
  }
  for (const wind of [NaN, Infinity, undefined]) assert.equal(forestWaterWind({ ...options, wind }), forestWaterWind(options));
  assert.equal(forestWaterWind({ ...options, wind: -9 }), 0);
  assert.equal(forestWaterWind({ ...options, wind: 9 }), 1);
});

test("surface controls are independent, all motion freezes, and wrapping currents fade completely", () => {
  const normal = forestWaterFrame(scene, options);
  const off = forestWaterFrame(scene, { ...options, waterSurface: false });
  assert.deepEqual(off.currents, []); assert.deepEqual(off.glints, []);
  for (const key of ["fish", "breeze", "impacts", "splashes"]) assert.deepEqual(off[key], normal[key]);
  const reduced = forestWaterFrame(scene, { ...options, reducedMotion: true, wind: 1, rain: 1 });
  assert.deepEqual(reduced, forestWaterFrame(scene, { ...options, elapsed: 600, reducedMotion: true, wind: 1, rain: 1 }));
  assert.deepEqual(reduced.impacts, []); assert.deepEqual(reduced.splashes, []);
  assert.ok(new Set(normal.currents.map(p => p.phase)).size > 20);
  let wraps = 0, previous = forestWaterFrame(scene, { ...options, elapsed: 0 }).currents;
  for (let elapsed = .04; elapsed < 24; elapsed += .04) {
    const current = forestWaterFrame(scene, { ...options, elapsed }).currents;
    for (let i = 0; i < current.length; i++) if (current[i].phase < previous[i].phase) {
      wraps++;
      assert.ok(current[i].opacity < .0002 && previous[i].opacity < .0002, "drift wrap is invisible");
    }
    previous = current;
  }
  assert.ok(wraps > 50);
});

test("both river arms have surface detail and every frame remains bounded on large maps", () => {
  const frame = forestWaterFrame(scene, options);
  const inArm = p => p.x >= 525 && p.x <= 665 && p.y >= 860 && p.y <= 1040;
  assert.ok(frame.currents.some(inArm), "narrow arm carries the flow too");
  assert.ok(frame.glints.some(inArm), "narrow arm has independent glints");
  const huge = { ...scene, width: 125400, water: {
    surfaces: [rectangle("wide-river", 0, 0, 125400, 1254)], exclusions: [],
  } };
  for (const world of [scene, huge]) {
    const bounded = forestWaterFrame(world, { ...options, rain: 1 });
    for (const key of ["currents", "glints", "fish", "breeze", "splashes", "impacts"]) {
      assert.ok(bounded[key].length <= FOREST_WATER_LIMITS[key], `${key} has a fixed budget`);
    }
  }
  const offscreen = { canvas: { width: 300, height: 200 },
    getTransform: () => ({ a: 1, b: 0, c: 0, d: 1, e: -10000, f: -10000 }),
    save() { assert.fail("offscreen water must not issue paint calls"); } };
  drawForestWater(offscreen, scene, options);
});
