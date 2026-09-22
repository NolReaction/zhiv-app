import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root,
  resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false } });
after(() => vite.close());
const { FOREST_ATMOSPHERE_LIMITS, forestAtmosphereState, forestAtmosphereFrame, drawForestAtmosphere }
  = await vite.ssrLoadModule("/features/world/forest-atmosphere.ts");

const scene = { schemaVersion: 1, id: "test-forest", width: 960, height: 720,
  focus: { x: 170, y: 210, width: 240, height: 240 }, terrain: [], sites: [], paths: [] };
const options = { elapsed: 12, timestamp: Date.UTC(2026, 8, 20), dusk: 0, reducedMotion: false };
const groups = ["butterflies", "fireflies", "birds", "raindrops"];
const inside = (particle, bounds) => particle.x >= bounds.x && particle.x <= bounds.x + bounds.width
  && particle.y >= bounds.y && particle.y <= bounds.y + bounds.height;

function weatherTimestamp(predicate) {
  for (let seconds = 0; seconds < 3600; seconds += 10) {
    const timestamp = options.timestamp + seconds * 1000;
    if (predicate(forestAtmosphereState(scene, { ...options, timestamp }))) return timestamp;
  }
  assert.fail("the weather schedule must include the requested conditions");
}

const clearTimestamp = weatherTimestamp(state => state.cloudiness === 0);
const rainTimestamp = weatherTimestamp(state => state.rain > .4);

function drawing(width = 360, height = 360) {
  const calls = [], stack = [];
  const ctx = { canvas: { width, height }, globalAlpha: .63, fillStyle: "#123456",
    strokeStyle: "#abcdef", lineWidth: 4, clipped: false, transform: [3, 4, .2] };
  const snapshot = () => ({ globalAlpha: ctx.globalAlpha, fillStyle: ctx.fillStyle,
    strokeStyle: ctx.strokeStyle, lineWidth: ctx.lineWidth, clipped: ctx.clipped,
    transform: [...ctx.transform] });
  const initial = snapshot();
  for (const name of ["beginPath", "rect", "moveTo", "lineTo", "ellipse"])
    ctx[name] = (...args) => calls.push([name, ...args]);
  for (const name of ["fillRect", "fill", "stroke"])
    ctx[name] = (...args) => { assert.ok(ctx.clipped, "every paint is clipped to the world"); calls.push([name, ...args, snapshot()]); };
  ctx.save = () => { stack.push(snapshot()); calls.push(["save"]); };
  ctx.restore = () => { assert.ok(stack.length, "restore has a matching save"); Object.assign(ctx, stack.pop()); calls.push(["restore"]); };
  ctx.clip = () => { ctx.clipped = true; calls.push(["clip"]); };
  ctx.translate = (x, y) => { ctx.transform[0] += x; ctx.transform[1] += y; calls.push(["translate", x, y]); };
  ctx.rotate = angle => { ctx.transform[2] += angle; calls.push(["rotate", angle]); };
  return { ctx, calls, stack, snapshot, initial };
}

test("shared clock produces deterministic world particles regardless of camera and draw order", () => {
  const input = { ...options, timestamp: rainTimestamp, dusk: .4 };
  const first = forestAtmosphereFrame(scene, input);
  const circle = drawing(320, 320), map = drawing(1440, 900);
  drawForestAtmosphere(circle.ctx, scene, input);
  forestAtmosphereFrame({ ...scene, id: "another-forest" }, { ...input, elapsed: 800 });
  drawForestAtmosphere(map.ctx, scene, input);
  assert.deepEqual(map.calls, circle.calls, "camera pixels do not alter world positions or weather");
  assert.deepEqual(forestAtmosphereFrame(scene, input), first, "sampling another scene cannot consume particle state");
  assert.notDeepEqual(forestAtmosphereFrame(scene, { ...input, elapsed: input.elapsed + 5 }).butterflies, first.butterflies);
  assert.deepEqual(scene.focus, { x: 170, y: 210, width: 240, height: 240 });
});

test("weather changes continuously with bounded drizzle and long clear intervals", () => {
  let previous, clearRun = 0, longestClearRun = 0, rainySeconds = 0;
  const seen = new Set();
  for (let seconds = 0; seconds < 3600; seconds++) {
    const state = forestAtmosphereState(scene, { ...options, timestamp: options.timestamp + seconds * 1000 });
    seen.add(state.weather);
    assert.ok(state.rain >= 0 && state.rain <= .45, "rain stays gentle");
    assert.ok(state.cloudiness >= 0 && state.cloudiness <= 1);
    if (previous) {
      assert.ok(Math.abs(state.rain - previous.rain) < .01, "rain never jumps at a phase or cycle boundary");
      assert.ok(Math.abs(state.cloudiness - previous.cloudiness) < .015, "clouds gather and clear gradually");
    }
    clearRun = state.cloudiness === 0 ? clearRun + 1 : 0;
    longestClearRun = Math.max(longestClearRun, clearRun);
    if (state.rain > .04) rainySeconds++;
    previous = state;
  }
  assert.deepEqual([...seen].sort(), ["clear", "cloudy", "drizzle"]);
  assert.ok(longestClearRun >= 8 * 60, "clear skies last several minutes");
  assert.ok(rainySeconds < 3600 / 3, "drizzle leaves most of the hour dry");
  assert.deepEqual(forestAtmosphereState(scene, { ...options, elapsed: 999 }).rain,
    forestAtmosphereState(scene, options).rain, "weather uses the shared timestamp rather than animation elapsed time");
});

test("particles stay in authored world and focus bounds after changing map dimensions", () => {
  const layouts = [
    { width: 61, height: 83, focus: { x: 29, y: 8, width: 25, height: 25 } },
    { width: 2600, height: 1800, focus: { x: 1800, y: 1100, width: 500, height: 500 } },
  ];
  for (const layout of layouts) {
    const edited = { ...scene, ...layout };
    const world = { x: 0, y: 0, width: edited.width, height: edited.height };
    for (let elapsed = 0; elapsed < 300; elapsed += 3) {
      const frame = forestAtmosphereFrame(edited, { ...options, elapsed, timestamp: rainTimestamp, dusk: .5 });
      for (const group of groups) for (const particle of frame[group]) {
        assert.ok(inside(particle, world), `${group} must follow the resized world instead of legacy map coordinates`);
        assert.ok(Number.isFinite(particle.size) && particle.size > 0);
        assert.ok(particle.opacity >= 0 && particle.opacity <= 1);
      }
      for (const group of ["butterflies", "fireflies", "raindrops"])
        assert.ok(frame[group].some(particle => inside(particle, edited.focus)), `${group} remain visible near the authored focus`);
    }
  }
});

test("moving the authored focus moves its local insects while preserving world-wide insects", () => {
  const moved = { ...scene, focus: { ...scene.focus, x: scene.focus.x + 300, y: scene.focus.y - 150 } };
  const input = { ...options, timestamp: clearTimestamp, dusk: .5 };
  const before = forestAtmosphereFrame(scene, input), after = forestAtmosphereFrame(moved, input);
  for (const group of ["butterflies", "fireflies"]) {
    let relocated = 0, fixed = 0;
    before[group].forEach((particle, index) => {
      const next = after[group][index];
      if (Math.abs(next.x - particle.x) < 1e-8 && Math.abs(next.y - particle.y) < 1e-8) fixed++;
      else {
        relocated++;
        assert.ok(Math.abs(next.x - particle.x - 300) < 1e-8);
        assert.ok(Math.abs(next.y - particle.y + 150) < 1e-8);
        assert.ok(inside(next, moved.focus));
      }
    });
    assert.ok(relocated > 0 && fixed > 0, `${group} inhabit both the clearing and the wider world`);
  }
});

test("day and night swap insect populations and birds visit briefly in small flocks", () => {
  const counts = new Set();
  let birdSeconds = 0;
  for (let elapsed = 0; elapsed < 1200; elapsed++) {
    const day = forestAtmosphereFrame(scene, { ...options, elapsed, timestamp: clearTimestamp });
    const night = forestAtmosphereFrame(scene, { ...options, elapsed, timestamp: clearTimestamp, dusk: true });
    assert.equal(day.butterflies.length, FOREST_ATMOSPHERE_LIMITS.butterflies);
    assert.equal(day.fireflies.length, 0);
    assert.equal(night.butterflies.length, 0);
    assert.equal(night.fireflies.length, FOREST_ATMOSPHERE_LIMITS.fireflies);
    assert.equal(night.birds.length, 0);
    assert.ok(day.birds.length <= 2 && day.birds.length <= FOREST_ATMOSPHERE_LIMITS.birds);
    counts.add(day.birds.length);
    if (day.birds.length) birdSeconds++;
    assert.equal(day.raindrops.length, 0);
  }
  assert.deepEqual([...counts].sort(), [0, 1, 2]);
  assert.ok(birdSeconds < 1200 / 4, "birds are occasional visitors rather than a constant flock");
  assert.equal(forestAtmosphereFrame(scene, { ...options, timestamp: rainTimestamp }).raindrops.length, FOREST_ATMOSPHERE_LIMITS.raindrops);
});

test("reduced motion freezes both clocks and omits all bird and rain strokes", () => {
  for (const dusk of [false, .5, true]) {
    const first = { ...options, elapsed: 0, timestamp: clearTimestamp, dusk, reducedMotion: true };
    const later = { ...first, elapsed: 3600, timestamp: rainTimestamp + 3 * 86400000 };
    const frame = forestAtmosphereFrame(scene, first);
    assert.deepEqual(forestAtmosphereFrame(scene, later), frame);
    assert.deepEqual(frame.birds, []);
    assert.deepEqual(frame.raindrops, []);
    const before = drawing(), after = drawing();
    drawForestAtmosphere(before.ctx, scene, first);
    drawForestAtmosphere(after.ctx, scene, later);
    assert.deepEqual(after.calls, before.calls, "static wings, glows, tint and weather do not advance with either clock");
    assert.equal(before.calls.some(call => call[0] === "stroke"), false);
  }
});

test("drawing clips to scene bounds and restores the caller's canvas state including bird transforms", () => {
  let elapsed = 0;
  while (elapsed < 300 && !forestAtmosphereFrame(scene, { ...options, elapsed, timestamp: rainTimestamp, dusk: .5 }).birds.length) elapsed++;
  assert.ok(elapsed < 300, "exercise a frame containing a bird transform");
  const drawingState = drawing();
  drawForestAtmosphere(drawingState.ctx, scene, { ...options, elapsed, timestamp: rainTimestamp, dusk: .5 });
  assert.deepEqual(drawingState.calls.slice(0, 4), [["save"], ["beginPath"], ["rect", 0, 0, scene.width, scene.height], ["clip"]]);
  assert.ok(drawingState.calls.some(call => call[0] === "translate"));
  assert.ok(drawingState.calls.some(call => call[0] === "ellipse"));
  assert.ok(drawingState.calls.some(call => call[0] === "stroke"));
  assert.equal(drawingState.stack.length, 0);
  assert.deepEqual(drawingState.snapshot(), drawingState.initial, "the next scene pass keeps its alpha, styles, clipping and transform");
});
