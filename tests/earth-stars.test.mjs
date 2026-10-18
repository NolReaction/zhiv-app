import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root,
  server: { middlewareMode: true, hmr: false } });
after(() => vite.close());
const { EARTH_STAR_COUNT, earthStarPoints, isEarthStarInSpace, createEarthStars } = await vite.ssrLoadModule("/features/earth/earth-stars.ts");

function scene({ width = 390, height = 844, radius = 160, zoom = 0.5, contextAvailable = true } = {}) {
  let time = 0;
  let clears = 0;
  let removed = 0;
  let projections = 0;
  let arc;
  const listeners = new Map();
  const painted = [];
  const context = {
    globalAlpha: 1,
    setTransform() {},
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
    get clears() { return clears; }, get removed() { return removed; }, get projections() { return projections; },
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

test("camera draws are throttled, silhouette changes cannot leave stale stars over Earth, and moveend restores them", () => {
  const state = scene();
  const stars = state.create();
  stars.setVisible(true);
  for (let time = 1; time < 100; time += 10) { state.setTime(time); state.emit("move"); }
  assert.equal(state.clears, 1);
  state.setTime(100); state.emit("move");
  assert.equal(state.clears, 2);
  state.setRadius(190);
  state.setTime(110); state.emit("move");
  assert.equal(state.canvas.hidden, true, "a stale clipping mask is never painted over a zooming or pitched globe");
  state.setTime(300); state.emit("move");
  assert.equal(state.clears, 2, "unsafe camera motion stays hidden until its final projection");
  state.emit("moveend");
  assert.equal(state.canvas.hidden, false);
  assert.equal(state.clears, 3);
  for (const dot of state.painted) assert.ok(Math.hypot(dot.x - 195, dot.y - 422) > 200 + dot.radius);
  stars.dispose();
});

test("street zoom, hidden state, missing Canvas2D and disposal perform no continuing star work", () => {
  const state = scene();
  const stars = state.create();
  stars.setVisible(true);
  state.setZoom(2.5); state.emit("moveend");
  assert.equal(state.canvas.hidden, true);
  const streetClears = state.clears;
  const streetProjections = state.projections;
  state.setTime(1000); state.emit("move");
  assert.equal(state.clears, streetClears);
  assert.equal(state.projections, streetProjections);
  stars.setVisible(false);
  const hiddenProjections = state.projections;
  state.emit("move"); state.emit("moveend"); state.emit("resize"); stars.setMode("evening");
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
