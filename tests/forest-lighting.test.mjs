import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root,
  resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false } });
after(() => vite.close());
const { forestLightSources, forestLightPulse, drawForestLighting, drawForestLightFixtures, drawForestLightEmitters }
  = await vite.ssrLoadModule("/features/world/forest-lighting.ts");
const source = (id, kind = "lantern", x = 30) => ({ id, kind, position: { x, y: 40 },
  radius: 70, intensity: 1, color: "#ffd28a", flicker: .12 });
const scene = () => ({ schemaVersion: 1, id: "lights-test", width: 1254, height: 1254,
  terrain: [], focus: { x: 0, y: 0, width: 300, height: 300 }, paths: [],
  sites: [{ id: "home", bounds: { x: 10, y: 20, width: 60, height: 60 }, initialLevel: 1,
    light: { x: 30, y: 40 } }], lights: [source("home-lantern"), source("street-torch", "torch", 250)] });
const options = { night: 1, elapsed: 12, reducedMotion: false };

function context() {
  const calls = [], stack = [], ctx = { canvas: { width: 800, height: 800 },
    globalAlpha: .7, globalCompositeOperation: "source-over", fillStyle: "original", strokeStyle: "original", lineWidth: 2,
    getTransform: () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }) };
  const state = () => ({ globalAlpha: ctx.globalAlpha, globalCompositeOperation: ctx.globalCompositeOperation,
    fillStyle: ctx.fillStyle, strokeStyle: ctx.strokeStyle, lineWidth: ctx.lineWidth });
  ctx.save = () => stack.push(state()); ctx.restore = () => Object.assign(ctx, stack.pop());
  ctx.createRadialGradient = (...args) => {
    const gradient = { stops: [], addColorStop(...stop) { this.stops.push(stop); } };
    calls.push({ method: "gradient", args, gradient }); return gradient;
  };
  for (const method of ["drawImage", "fillRect", "beginPath", "ellipse", "moveTo", "lineTo", "bezierCurveTo",
    "quadraticCurveTo", "closePath", "fill", "stroke", "translate", "scale"])
    ctx[method] = (...args) => calls.push({ method, args, ...state() });
  return { ctx, calls, state, stack };
}

test("authored lights override colocated legacy lamps and hide with their building", () => {
  const map = scene();
  assert.deepEqual(forestLightSources(map).map(light => light.id), ["home-lantern", "street-torch"]);
  assert.deepEqual(forestLightSources(map, { showBuildings: false }).map(light => light.id), ["street-torch"]);
  const legacy = { ...map, lights: undefined };
  assert.equal(forestLightSources(legacy)[0].id, "site:home");
  assert.deepEqual(forestLightSources(legacy, { levels: { home: 0 } }), []);
  assert.deepEqual(forestLightSources({ ...map, sites: [], lights: [] }), [], "no guessed forest positions in another map");
});

test("flames have bounded independent motion and are static with the shared clock paused or reduced", () => {
  const light = source("torch-a", "torch"), other = source("torch-b", "torch");
  const first = forestLightPulse(light, 12, false);
  assert.equal(first, forestLightPulse(light, 12, false));
  assert.notEqual(first, forestLightPulse(other, 12, false));
  for (let time = 0; time < 10; time += .1) {
    assert.equal(forestLightPulse(light, time, true), 1);
    const pulse = forestLightPulse(light, time, false);
    assert.ok(pulse >= 1 - light.flicker && pulse <= 1 + light.flicker);
  }
  assert.equal(forestLightPulse({ ...light, flicker: 0 }, 10, false), 1);
});

test("day leaves artwork unchanged; night reuses a bounded illumination texture and respects authored edits", () => {
  const beforeDocument = globalThis.document, canvases = [];
  globalThis.document = { createElement() {
    const paint = context(), canvas = { width: 0, height: 0, getContext: () => paint.ctx };
    canvases.push(canvas); return canvas;
  } };
  try {
    const map = scene(), paint = context(), initial = paint.state();
    drawForestLighting(paint.ctx, map, { ...options, night: 0 });
    assert.equal(paint.calls.length, 0); assert.equal(canvases.length, 0);
    drawForestLighting(paint.ctx, map, options);
    const first = paint.calls.find(call => call.method === "drawImage");
    assert.equal(first.globalCompositeOperation, "multiply");
    assert.ok(canvases[0].width <= 768 && canvases[0].height <= 768);
    drawForestLighting(paint.ctx, map, { ...options, night: .5, elapsed: 99 });
    const second = paint.calls.filter(call => call.method === "drawImage").at(-1);
    assert.equal(second.args[0], first.args[0]); assert.equal(second.globalAlpha, .5);
    assert.equal(canvases.length, 1, "camera/time changes never rebuild the light field");
    map.lights[0].radius = 100;
    drawForestLighting(paint.ctx, map, options);
    assert.equal(canvases.length, 2, "a Tiled geometry edit invalidates cached illumination");
    drawForestLighting(paint.ctx, map, { ...options, showBuildings: false });
    assert.equal(canvases.length, 3, "hidden buildings cannot keep their light pool");
    assert.deepEqual(paint.state(), initial); assert.equal(paint.stack.length, 0);
  } finally {
    if (beforeDocument === undefined) delete globalThis.document; else globalThis.document = beforeDocument;
  }
});

test("torch posts remain by day but luminous cores only appear at night and inside the camera", () => {
  const map = scene(), day = context(), night = context();
  drawForestLightFixtures(day.ctx, map);
  assert.ok(day.calls.some(call => call.method === "fillRect"));
  day.calls.length = 0;
  drawForestLightEmitters(day.ctx, map, { ...options, night: 0 });
  assert.equal(day.calls.length, 0);
  const initial = night.state(); drawForestLightEmitters(night.ctx, map, options);
  assert.ok(night.calls.some(call => call.method === "bezierCurveTo"), "shaped flame rather than a glowing dot");
  assert.deepEqual(night.state(), initial);
  const off = context(); off.ctx.getTransform = () => ({ a: 1, b: 0, c: 0, d: 1, e: 10000, f: 10000 });
  drawForestLightEmitters(off.ctx, map, options); assert.equal(off.calls.length, 0);
  const disabled = context();
  drawForestLightEmitters(disabled.ctx, { ...map, sites: [], lights: [ { ...source("off"), intensity: 0 } ] }, options);
  assert.equal(disabled.calls.length, 0);
  const bright = { ...source("strong-flicker"), flicker: 1 }, edge = context();
  const time = Array.from({ length: 100 }, (_, i) => i / 10).find(t => forestLightPulse(bright, t, false) > 1.4);
  assert.notEqual(time, undefined);
  edge.ctx.getTransform = () => ({ a: 1, b: 0, c: 0, d: 1, e: -51, f: 0 });
  drawForestLightEmitters(edge.ctx, { ...map, sites: [], lights: [bright] }, { ...options, elapsed: time });
  assert.ok(edge.calls.some(call => call.method === "gradient"), "a pulsing halo enters before its offscreen center");
});
