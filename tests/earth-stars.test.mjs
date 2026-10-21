import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root,
  server: { middlewareMode: true, hmr: false } });
after(() => vite.close());
const { EARTH_STAR_COUNT, EARTH_STAR_MAX_PIXELS, earthStarPoints, isEarthStarInSpace, createEarthStars } = await vite.ssrLoadModule("/features/earth/earth-stars.ts");

function scene({ width = 390, height = 844, radius = 160, zoom = 0.5, contextAvailable = true } = {}) {
  let time = 0;
  let clears = 0;
  let removed = 0;
  let projections = 0;
  let transform;
  let arc;
  const listeners = new Map();
  const painted = [];
  const context = {
    globalAlpha: 1,
    setTransform(...value) { transform = value; },
    clearRect() { clears++; painted.length = 0; },
    beginPath() {},
    arc(x, y, size) { arc = { x, y, radius: size }; },
    fill() { painted.push({ ...arc, opacity: this.globalAlpha }); },
  };
  const canvas = { width: 0, height: 0, dataset: {}, attributes: {}, hidden: false,
    setAttribute(name, value) { this.attributes[name] = value; },
    getContext() { return contextAvailable ? context : null; },
    remove() { removed++; },
  };
  const ownerDocument = { defaultView: { devicePixelRatio: 3, performance: { now: () => time },
    setTimeout() { throw new Error("a static starfield must not schedule timers"); },
    requestAnimationFrame() { throw new Error("a static starfield must not schedule frames"); } },
    createElement(tag) { assert.equal(tag, "canvas"); return canvas; } };
  const host = { ownerDocument, children: [], append(child) { this.children.push(child); } };
  const nativeCanvas = { clientWidth: width, clientHeight: height };
  const map = {
    getCanvas: () => nativeCanvas,
    getZoom: () => zoom,
    unproject([x, y]) {
      const dx = x - width / 2; const dy = y - height / 2;
      const distance = Math.hypot(dx, dy);
      if (distance <= radius) return [x, y];
      return [width / 2 + dx / distance * radius, height / 2 + dy / distance * radius];
    },
    project([x, y]) { projections++; return { x, y }; },
    on(type, callback) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(callback);
    },
    off(type, callback) { listeners.get(type)?.delete(callback); if (!listeners.get(type)?.size) listeners.delete(type); },
  };
  return {
    map, host, canvas, painted, listeners, nativeCanvas,
    create: mode => createEarthStars(map, host, mode ?? "auto"),
    emit: type => { for (const callback of listeners.get(type) ?? []) callback(); },
    setTime: value => { time = value; },
    setRadius: value => { radius = value; },
    setZoom: value => { zoom = value; },
    get clears() { return clears; }, get removed() { return removed; }, get projections() { return projections; }, get transform() { return transform; },
  };
}

test("the original fixed sky has a small deterministic population without repeated redraw randomness", () => {
  assert.equal(EARTH_STAR_COUNT, 128);
  assert.deepEqual(earthStarPoints(), earthStarPoints());
  assert.equal(earthStarPoints().length, EARTH_STAR_COUNT);
  for (const star of earthStarPoints()) {
    assert.ok(star.x >= 0 && star.x < 1 && star.y >= 0 && star.y < 1);
    assert.ok(star.radius > 0 && star.radius <= 1.35 && star.opacity > 0 && star.opacity <= 1);
  }
});

test("public globe round trips exclude land and the atmospheric edge while accepting distant space", () => {
  const state = scene();
  assert.equal(isEarthStarInSpace(state.map, { x: 195, y: 422 }), false);
  assert.equal(isEarthStarInSpace(state.map, { x: 360, y: 422 }, 1), false);
  assert.equal(isEarthStarInSpace(state.map, { x: 385, y: 422 }, 1), true);
  assert.equal(isEarthStarInSpace(state.map, { x: 195, y: 30 }, 1), true);
  const invalidProjection = { unproject: () => [0, 0], project: () => ({ x: NaN, y: Infinity }) };
  assert.equal(isEarthStarInSpace(invalidProjection, { x: 195, y: 30 }), false);
});

test("only ready-visible space receives dots; day, auto and evening have distinct intensity", () => {
  const state = scene();
  const stars = state.create();
  assert.equal(state.host.children.length, 1);
  assert.equal(state.canvas.attributes["aria-hidden"], "true");
  assert.equal(state.canvas.hidden, true);
  assert.equal(state.clears, 0);
  stars.setVisible(true);
  stars.setVisible(true);
  assert.equal(state.canvas.hidden, false);
  assert.equal(state.canvas.width, 585, "retina rendering is capped at 1.5 rather than multiplying a full-screen canvas by device DPR");
  assert.equal(state.canvas.height, 1266);
  assert.ok(state.painted.length > 20 && state.painted.length <= EARTH_STAR_COUNT * 2);
  for (const dot of state.painted) {
    assert.ok(Math.hypot(dot.x - 195, dot.y - 422) > 170 + dot.radius, "no dot or soft halo lands on Earth");
  }
  const auto = state.painted[0].opacity;
  stars.setMode("evening");
  const evening = state.painted[0].opacity;
  stars.setMode("day");
  const day = state.painted[0].opacity;
  assert.ok(day < auto && auto < evening);
  stars.dispose();
});

test("camera moves wait for the SDK frame without erasing stars or scheduling their own work", () => {
  const state = scene(); const stars = state.create(); stars.setVisible(true);
  for (let time = 1; time < 100; time += 10) { state.setTime(time); state.emit("move"); }
  assert.equal(state.clears, 1, "many camera events coalesce into the next rendered frame");
  state.setRadius(190); state.emit("move");
  assert.equal(state.canvas.hidden, false);
  state.emit("render"); assert.equal(state.clears, 2);
  for (const dot of state.painted) assert.ok(Math.hypot(dot.x - 195, dot.y - 422) > 200 + dot.radius);
  for (let i = 0; i < 20; i++) state.emit("render");
  assert.equal(state.clears, 2, "idle/decorative frames never repaint an unchanged starfield");
  state.setRadius(160); state.emit("moveend"); state.emit("render");
  assert.equal(state.clears, 3); assert.equal(state.canvas.hidden, false);
  stars.dispose();
});

test("stars follow visible space at any zoom and disappear only when Earth fills the view", () => {
  const state = scene();
  const stars = state.create();
  stars.setVisible(true);
  for (const zoom of [1.5, 2.5, 4.2, 16]) {
    state.setZoom(zoom); state.emit("moveend"); state.emit("render");
    assert.equal(state.canvas.hidden, false, "remaining sky is not erased by a zoom cutoff");
    assert.ok(state.painted.length > 0);
  }
  state.setRadius(1_000); state.emit("move"); state.emit("render");
  assert.equal(state.canvas.hidden, true);
  assert.equal(state.painted.length, 0, "no star remains over an Earth-filled viewport");
  state.setRadius(160); state.emit("move"); state.emit("render");
  assert.equal(state.canvas.hidden, false, "a newly visible horizon restores stars before moveend");
  stars.dispose();
});

test("hidden state, missing Canvas2D and disposal perform no continuing star work", () => {
  const state = scene({ radius: 1_000 });
  const stars = state.create();
  stars.setVisible(true);
  const streetClears = state.clears;
  const streetProjections = state.projections;
  state.setTime(1000); state.emit("move");
  assert.equal(state.clears, streetClears);
  assert.equal(state.projections, streetProjections, "camera events only mark the next SDK frame dirty");
  state.emit("render");
  assert.ok(state.projections > streetProjections);
  stars.setVisible(false);
  const hiddenProjections = state.projections;
  state.emit("move"); state.emit("moveend"); state.emit("resize"); state.emit("render"); stars.setMode("evening");
  assert.equal(state.projections, hiddenProjections);
  stars.dispose(); stars.dispose();
  assert.equal(state.listeners.size, 0);
  assert.equal(state.removed, 1);
  stars.setVisible(true); stars.setMode("auto");
  assert.equal(state.projections, hiddenProjections);
  const fallback = scene({ contextAvailable: false });
  const unavailable = fallback.create(); unavailable.setVisible(true); fallback.emit("move");
  assert.equal(fallback.canvas.hidden, true);
  assert.equal(fallback.projections, 0);
  unavailable.dispose();
});

test("pitched Mercator sky without a geographic intersection keeps stars and malformed projections stay safe", () => {
  const sky = { unproject: () => undefined, project: () => { throw new Error("must not project a missing intersection"); } };
  assert.equal(isEarthStarInSpace(sky, { x: 20, y: 10 }), true);
  assert.equal(isEarthStarInSpace({ unproject() { throw new Error("projection unavailable"); } }, { x: 20, y: 10 }), false);
  const state = scene(); state.map.unproject = () => undefined;
  const stars = state.create(); assert.doesNotThrow(() => stars.setVisible(true));
  assert.equal(state.canvas.hidden, false); assert.ok(state.painted.length >= EARTH_STAR_COUNT);
  state.emit("move"); assert.doesNotThrow(() => state.emit("render"));
  stars.dispose();
});

test("4K and ultrawide screens bound the star canvas to eight MiB while retaining CSS-space clipping", () => {
  for (const [width, height] of [[3840, 2160], [7680, 2160], [2160, 3840]]) {
    const state = scene({ width, height }); const stars = state.create(); stars.setVisible(true);
    assert.ok(state.canvas.width * state.canvas.height <= EARTH_STAR_MAX_PIXELS);
    assert.ok(state.canvas.width * state.canvas.height * 4 <= 8 * 1024 * 1024);
    assert.deepEqual(state.transform, [state.canvas.width / width, 0, 0, state.canvas.height / height, 0, 0], "rounded backing pixels use their actual CSS-space scale on each axis");
    assert.ok(state.painted.length > 0);
    for (const dot of state.painted) assert.ok(Math.hypot(dot.x - width / 2, dot.y - height / 2) > 170 + dot.radius);
    stars.dispose();
  }
});
