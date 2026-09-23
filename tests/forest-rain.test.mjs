import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root,
  resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false } });
after(() => vite.close());
const { sampleForestRain, drawForestRain, drawForestWaterImpact, FOREST_RAIN_LIMIT }
  = await vite.ssrLoadModule("/features/world/forest-rain.ts");
const { forestGroundWeatherFrame, isForestGroundClear }
  = await vite.ssrLoadModule("/features/world/forest-ground-weather.ts");
const scene = { schemaVersion: 1, id: "rain-surfaces", width: 960, height: 720,
  focus: { x: 170, y: 210, width: 240, height: 240 }, terrain: [], sites: [], paths: [],
  actor: { spawn: { x: 290, y: 330 }, size: 48 } };
const options = { elapsed: 12, rain: .68 };
const within = (point, area) => point.x >= area.x && point.x <= area.x + area.width
  && point.y >= area.y && point.y <= area.y + area.height;

test("rain is deterministic across consumers, sparse in auto and bounded at all intensities", () => {
  const expected = sampleForestRain(scene, options);
  sampleForestRain({ ...scene, id: "unrelated" }, { elapsed: 2500, rain: 1 });
  assert.deepEqual(sampleForestRain(scene, options), expected);
  assert.notDeepEqual(sampleForestRain(scene, { ...options, elapsed: 12.1 }), expected);
  assert.equal(sampleForestRain(scene, { ...options, rain: 0 }).length, 0);
  let previous = 0;
  for (const rain of [.1, .35, .68, 1]) {
    const drops = sampleForestRain(scene, { ...options, rain });
    assert.ok(drops.length > previous && drops.length <= FOREST_RAIN_LIMIT);
    assert.ok(sampleForestRain(scene, { ...options, rain, automatic: true }).length <= 54);
    previous = drops.length;
  }
  assert.ok(FOREST_RAIN_LIMIT <= 180);
  assert.deepEqual(sampleForestRain(scene, { ...options, reducedMotion: true }), []);
});

test("short translucent depth layers cover both the clearing and the full resized world", () => {
  for (const layout of [{ width: 61, height: 83, focus: { x: 29, y: 8, width: 25, height: 25 } },
    { width: 2600, height: 1800, focus: { x: 1800, y: 1100, width: 500, height: 500 } }]) {
    const world = { x: 0, y: 0, width: layout.width, height: layout.height };
    const scale = Math.max(.35, Math.min(2, layout.focus.width / 256));
    for (const elapsed of [0, 5, 250, 1e6]) {
      const drops = sampleForestRain({ ...scene, ...layout }, { rain: 1, elapsed });
      assert.equal(new Set(drops.map(drop => drop.depth)).size, 3);
      assert.ok(drops.some(drop => within(drop, layout.focus)));
      assert.ok(drops.some(drop => !within(drop, layout.focus)));
      assert.ok(drops.some(drop => drop.x < layout.width * .2));
      assert.ok(drops.some(drop => drop.x > layout.width * .8));
      for (const drop of drops) {
        assert.ok(within(drop, world));
        assert.ok(Object.values(drop).every(Number.isFinite));
        assert.ok(drop.length > 0 && drop.length < 7 * scale, "no long white bars");
        assert.ok(drop.opacity >= 0 && drop.opacity < .5);
        assert.ok(drop.size < scale * .8 && drop.size > 0);
      }
    }
  }
});

test("bad numeric rain inputs stay finite, safely dry or clamped", () => {
  for (const rain of [NaN, Infinity, -1]) assert.deepEqual(sampleForestRain(scene, { elapsed: 10, rain }), []);
  assert.equal(sampleForestRain(scene, { elapsed: Infinity, rain: 100 }).length, FOREST_RAIN_LIMIT);
  const broken = { ...scene, width: NaN, height: Infinity, focus: { x: NaN, y: -50, width: -1, height: 0 } };
  assert.ok(sampleForestRain(broken, options).every(drop => Object.values(drop).every(Number.isFinite)));
});

function context() {
  const calls = [], stack = [];
  const ctx = { fillStyle: "initial", strokeStyle: "initial", globalAlpha: .5, lineWidth: 1 };
  const snapshot = () => ({ fillStyle: ctx.fillStyle, strokeStyle: ctx.strokeStyle,
    globalAlpha: ctx.globalAlpha, lineWidth: ctx.lineWidth });
  for (const method of ["beginPath", "rect", "clip", "moveTo", "lineTo", "bezierCurveTo", "closePath", "ellipse", "fill", "stroke"])
    ctx[method] = (...args) => calls.push([method, ...args, snapshot()]);
  ctx.save = () => stack.push(snapshot());
  ctx.restore = () => Object.assign(ctx, stack.pop());
  return { ctx, calls, stack, snapshot };
}

test("rain painter clips and restores state; water impact evolves from crown to expanding rings", () => {
  const drawing = context(), initial = drawing.snapshot();
  drawForestRain(drawing.ctx, scene, sampleForestRain(scene, options));
  assert.deepEqual(drawing.snapshot(), initial);
  assert.equal(drawing.stack.length, 0);
  assert.ok(drawing.calls.findIndex(call => call[0] === "clip") < drawing.calls.findIndex(call => call[0] === "fill"));
  assert.equal(drawing.calls.filter(call => call[0] === "stroke").length, 0, "falling drops are tapered shapes");
  const first = context(), later = context();
  const impact = { x: 40, y: 50, radiusX: 4, radiusY: 2, opacity: .5 };
  drawForestWaterImpact(first.ctx, { ...impact, phase: .13 });
  drawForestWaterImpact(later.ctx, { ...impact, phase: .72 });
  assert.ok(first.calls.some(call => call[0] === "fill"), "fresh impact has upward droplets");
  assert.ok(!later.calls.some(call => call[0] === "fill"), "droplets disappear before the rings");
  const radius = drawing => drawing.calls.find(call => call[0] === "ellipse")[3];
  assert.ok(radius(later) > radius(first));
  assert.deepEqual(first.snapshot(), initial);
  const finished = context();
  drawForestWaterImpact(finished.ctx, { ...impact, phase: 1 });
  assert.equal(finished.calls.length, 0);
});

test("rain hits dry ground immediately and all transient footprints honor exclusions", () => {
  let total = 0;
  for (let elapsed = 0; elapsed < 12; elapsed += .2) {
    const input = { elapsed, timestamp: 0, weather: "downpour", wetness: 0 };
    const frame = forestGroundWeatherFrame(scene, input);
    assert.equal(frame.puddles.length, 0);
    assert.ok(frame.impacts.length <= 12);
    total += frame.impacts.length;
    for (const impact of frame.impacts) assert.ok(isForestGroundClear(scene, impact, impact.radiusX));
    const excluded = forestGroundWeatherFrame(scene, { ...input, groundExclusions: [{ ...scene.actor.spawn, radius: 80 }] });
    assert.equal(excluded.impacts.length, 0);
  }
  assert.ok(total > 0);
  const noSpawn = forestGroundWeatherFrame({ ...scene, actor: undefined }, { elapsed: 5, timestamp: 0, weather: "downpour" });
  assert.equal(noSpawn.impacts.length, 0);
});

test("standing water uses stable distinct organic outlines and moving impact locations, freezing in reduced motion", () => {
  const input = { elapsed: 12, timestamp: 0, weather: "downpour", wetness: .9 };
  const first = forestGroundWeatherFrame(scene, input);
  const later = forestGroundWeatherFrame(scene, { ...input, elapsed: 15 });
  assert.ok(first.puddles.length > 1 && first.puddles.length <= 4);
  assert.equal(new Set(first.puddles.map(puddle => puddle.shape)).size, first.puddles.length);
  assert.deepEqual(first.puddles, later.puddles);
  assert.notDeepEqual(first.rings.map(({ x, y }) => [x, y]), later.rings.map(({ x, y }) => [x, y]));
  for (const ring of first.rings) {
    const puddle = first.puddles[ring.puddleIndex];
    assert.ok(Math.abs(ring.x - puddle.x) + ring.radiusX < puddle.radiusX);
    assert.ok(Math.abs(ring.y - puddle.y) + ring.radiusY < puddle.radiusY);
  }
  const still = forestGroundWeatherFrame(scene, { ...input, reducedMotion: true });
  assert.equal(still.rings.length, 0);
  assert.equal(still.impacts.length, 0);
  assert.deepEqual(still, forestGroundWeatherFrame(scene, { ...input, elapsed: 9999, reducedMotion: true }));
  const stopped = forestGroundWeatherFrame(scene, { ...input, weather: "clear" });
  assert.deepEqual(stopped.puddles, first.puddles);
  assert.equal(stopped.rings.length, 0);
  assert.equal(stopped.impacts.length, 0);
});
