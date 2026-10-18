import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root,
  resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false } });
after(() => vite.close());
const { forestLightSources, forestLightPulse, drawForestLighting, drawForestLightFixtures, drawForestLightEmitters,
  drawForestLighthouseBeams, forestLighthouseAngle }
  = await vite.ssrLoadModule("/features/world/environment/lighting/forest-lighting.ts");
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
  ctx.createLinearGradient = ctx.createRadialGradient = (...args) => {
    const gradient = { stops: [], addColorStop(...stop) { this.stops.push(stop); } };
    calls.push({ method: "gradient", args, gradient }); return gradient;
  };
  ctx.createImageData = (width, height) => ({ data: new Uint8ClampedArray(width * height * 4), width, height });
  for (const method of ["drawImage", "fillRect", "beginPath", "ellipse", "moveTo", "lineTo", "bezierCurveTo",
    "quadraticCurveTo", "closePath", "fill", "stroke", "translate", "scale", "clip", "rotate", "putImageData"])
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

test("building glass follows active artwork and its rotation; unlit ruins never inherit working lamps", () => {
  const geometry = { bounds: { x: 80, y: 100, width: 100, height: 150 },
    imagePlacement: { x: 80, y: 100, width: 150, height: 100, rotation: 90 } };
  const map = { ...scene(), sites: [{ id: "quarry", initialLevel: 0, bounds: geometry.bounds,
    states: [{ level: 0, image: "/world/prototype/quarry-lvl-0.png" },
      { level: 1, image: "/world/prototype/quarry-lvl-1.png?v=changed", geometry }] }], lights: [] };
  assert.deepEqual(forestLightSources(map), []);
  const [light] = forestLightSources(map, { levels: { quarry: 1 } });
  assert.equal(light.id, "quarry-lantern");
  assert.ok(Math.abs(light.position.x - (80 - .69 * 100)) < 1e-8);
  assert.ok(Math.abs(light.position.y - (100 + .617 * 150)) < 1e-8);
  assert.equal(light.glass.rotation, Math.PI / 2);
  assert.deepEqual(forestLightSources(map, { levels: { quarry: 1 }, showBuildings: false }), []);
  assert.deepEqual(forestLightSources({ ...map, sites: [{ ...map.sites[0], states: [{ level: 0, image: "/unknown.png" }] }] }), []);
});

test("actual map uses one aligned home lamp at every level plus the working mine/workshop/lighthouse", async () => {
  const map = JSON.parse(await readFile(new URL("../features/world/tiled/forest.generated.json", import.meta.url), "utf8"));
  const positions = [];
  for (let level = 1; level <= 5; level++) {
    const sources = forestLightSources(map, { levels: { home: level, quarry: 1, workshop: 2, lighthouse: 1 } });
    assert.equal(new Set(sources.map(light => light.id)).size, sources.length);
    const home = sources.filter(light => light.id === "home-lantern");
    assert.equal(home.length, 1); assert.ok(home[0].glass);
    positions.push(JSON.stringify(home[0].position));
    for (const id of ["quarry-lantern", "workshop-lantern", "workshop-window", "lighthouse-lens"]) {
      assert.ok(sources.find(light => light.id === id)?.glass, id);
    }
  }
  assert.equal(new Set(positions).size, 5, "home lamp follows every distinct cutout");
  const sources = forestLightSources(map, { levels: { quarry: 0, workshop: 1, lighthouse: 0 } });
  assert.equal(sources.some(light => ["quarry", "workshop", "lighthouse"].includes(light.siteId)), false);
  map.lights.find(light => light.id === "home-lantern").intensity = 0;
  assert.equal(forestLightSources(map).find(light => light.id === "home-lantern").intensity, 0,
    "Tiled intensity=0 still disables a lamp that follows its building");
});

test("disabled authored lamps suppress their automatic building source without hiding other lights", async () => {
  const map = JSON.parse(await readFile(new URL("../features/world/tiled/forest.generated.json", import.meta.url), "utf8"));
  const authored = map.lights.find(light => light.id === "home-lantern");
  authored.enabled = false;
  const sources = forestLightSources(map, { levels: { home: 1, workshop: 2 } });
  assert.equal(sources.some(light => light.id === "home-lantern"), false);
  assert.ok(sources.some(light => light.id === "workshop-lantern"));
  assert.equal(authored.enabled, false, "source resolution never mutates the authored draft");
});

test("explicitly moved building lamps use authored coordinates and leave the artwork glass behind", async () => {
  const map = JSON.parse(await readFile(new URL("../features/world/tiled/forest.generated.json", import.meta.url), "utf8"));
  const authored = map.lights.find(light => light.id === "home-lantern");
  const bound = forestLightSources(map, { levels: { home: 1 } }).find(light => light.id === authored.id);
  authored.position = { x: 300, y: 320 }; authored.height = 42;
  assert.deepEqual(forestLightSources(map, { levels: { home: 1 } }).find(light => light.id === authored.id).position,
    bound.position, "an untouched binding still follows the building");
  authored.manualPosition = true;
  const moved = forestLightSources(map, { levels: { home: 1 } }).find(light => light.id === authored.id);
  assert.deepEqual(moved.position, authored.position); assert.equal(moved.height, 42);
  assert.equal(moved.glass, undefined); assert.equal(moved.siteId, undefined);
  assert.ok(forestLightSources(map, { showBuildings: false, levels: { home: 1 } }).some(light => light.id === authored.id),
    "a detached source remains independent when building previews are hidden");
});

test("lighthouse casts twin volumes and optional surface spill only at night; clock, hiding and culling apply", () => {
  const beforeDocument = globalThis.document, canvases = [];
  globalThis.document = { createElement() {
    const paint = context(), canvas = { width: 0, height: 0, getContext: () => paint.ctx };
    canvases.push(canvas); return canvas;
  } };
  try {
    const map = { ...scene(), lights: [], sites: [{ id: "lighthouse", initialLevel: 1,
      bounds: { x: 100, y: 100, width: 100, height: 100 },
      states: [{ level: 1, image: "/world/prototype/lighthouse-level-1.png" }] }] };
    const day = context(); drawForestLighthouseBeams(day.ctx, map, { ...options, night: 0 });
    assert.equal(day.calls.length, 0); assert.equal(canvases.length, 0);
    const night = context(), original = night.state();
    drawForestLighthouseBeams(night.ctx, map, options);
    assert.equal(night.calls.filter(call => call.method === "drawImage").length, 4);
    assert.equal(canvases.length, 2);
    drawForestLighthouseBeams(night.ctx, map, { ...options, elapsed: 21 });
    assert.equal(canvases.length, 2, "sweeping never rebuilds the sprites");
    const low = context(); drawForestLighthouseBeams(low.ctx, map, { ...options, quality: "low" });
    assert.equal(low.calls.filter(call => call.method === "drawImage").length, 2, "low retains the main optics without the optional ground spill");
    assert.deepEqual(night.state(), original); assert.equal(night.stack.length, 0);
    assert.notEqual(forestLighthouseAngle(12, false), forestLighthouseAngle(21, false));
    assert.equal(forestLighthouseAngle(12, false), forestLighthouseAngle(48, false));
    assert.equal(forestLighthouseAngle(12, true), forestLighthouseAngle(21, true));
    assert.equal(forestLighthouseAngle(Infinity, false), forestLighthouseAngle(0, true));
    const hidden = context(); drawForestLighthouseBeams(hidden.ctx, map, { ...options, showBuildings: false });
    assert.equal(hidden.calls.length, 0);
    const off = context(); off.ctx.getTransform = () => ({ a: 1, b: 0, c: 0, d: 1, e: 10000, f: 10000 });
    drawForestLighthouseBeams(off.ctx, map, options); assert.equal(off.calls.length, 0);
    map.lights.push({ ...source("lighthouse-lens"), intensity: 0 });
    const disabled = context(); drawForestLighthouseBeams(disabled.ctx, map, options);
    assert.equal(disabled.calls.length, 0);
  } finally {
    if (beforeDocument === undefined) delete globalThis.document; else globalThis.document = beforeDocument;
  }
});

test("lighthouse optics follow anisotropic rotated artwork, and manual detachment removes every beam binding", async () => {
  const geometry = { bounds: { x: -20, y: 100, width: 100, height: 150 },
    imagePlacement: { x: 80, y: 100, width: 150, height: 100, rotation: 90 } };
  const map = { ...scene(), lights: [], sites: [{ id: "lighthouse", initialLevel: 1,
    bounds: geometry.bounds, states: [{ level: 1, image: "/world/prototype/lighthouse-level-1.png?v=current", geometry }] }] };
  const [bound] = forestLightSources(map);
  assert.deepEqual(bound.position, { x: 47.4, y: 176.5 });
  assert.ok(Math.abs(bound.beamGround.x - -11) < 1e-10);
  assert.equal(bound.beamGround.y, 176.5);
  assert.equal(bound.beamLength, 615);
  assert.equal(bound.glass.width, 8.25); assert.equal(bound.glass.height, 6.5);
  assert.equal(bound.glass.rotation, Math.PI / 2);
  map.lights.push({ ...source("lighthouse-lens"), manualPosition: true });
  const [detached] = forestLightSources(map);
  for (const field of ["siteId", "glass", "beamLength", "beamGround"]) assert.equal(detached[field], undefined, field);
  const paint = context(); drawForestLighthouseBeams(paint.ctx, map, options);
  assert.equal(paint.calls.length, 0);

  const actual = JSON.parse(await readFile(new URL("../features/world/tiled/forest.generated.json", import.meta.url), "utf8"));
  const lens = forestLightSources(actual, { levels: { lighthouse: 1 } }).find(light => light.id === "lighthouse-lens");
  const site = actual.sites.find(site => site.id === "lighthouse"), active = site.states.find(state => state.level === 1);
  const bounds = active.geometry.bounds;
  assert.ok(Math.abs(lens.position.x - (bounds.x + bounds.width * .51)) < 1e-8, "glass remains on the painted lens");
  assert.ok(Math.abs(lens.position.y - (bounds.y + bounds.height * .326)) < 1e-8);
});

test("finite coloured beam textures retain a bright axis, feathered boundaries and a distant soft surface footprint", () => {
  const beforeDocument = globalThis.document, canvases = [];
  globalThis.document = { createElement() {
    const paint = context(), canvas = { width: 0, height: 0, getContext: () => paint.ctx, paint };
    canvases.push(canvas); return canvas;
  } };
  try {
    const map = { ...scene(), lights: [{ ...source("lighthouse-lens"), color: "#fdcf72" }], sites: [{ id: "lighthouse", initialLevel: 1,
      bounds: { x: 100, y: 100, width: 100, height: 100 }, states: [{ level: 1, image: "/world/prototype/lighthouse-level-1.png" }] }] };
    drawForestLighthouseBeams(context().ctx, map, options);
    assert.equal(canvases.length, 2);
    const [volume, surface] = canvases.map(canvas => canvas.paint.calls.find(call => call.method === "putImageData").args[0]);
    const pixel = (texture, x, y = 95) => Array.from(texture.data.slice((y * texture.width + x) * 4, (y * texture.width + x) * 4 + 4));
    assert.deepEqual(pixel(volume, 256).slice(0, 3), [253, 207, 114], "Tiled colour reaches the actual beam sprite");
    assert.ok(pixel(volume, 256)[3] > pixel(volume, 256, 119)[3] * 2, "concentrated axis and broad penumbra differ");
    assert.ok(pixel(volume, 256, 119)[3] > 0, "soft penumbra remains visible");
    for (const texture of [volume, surface]) {
      assert.equal(pixel(texture, 0)[3], 0); assert.equal(pixel(texture, 511)[3], 0);
      for (let x = 0; x < texture.width; x++) {
        assert.equal(pixel(texture, x, 0)[3], 0); assert.equal(pixel(texture, x, 191)[3], 0);
      }
      let maximum = 0;
      for (let at = 3; at < texture.data.length; at += 4) maximum = Math.max(maximum, texture.data[at]);
      assert.ok(maximum > 0 && maximum < 128, "screen compositing cannot become an opaque fog sheet");
    }
    assert.equal(pixel(surface, 100)[3], 0, "ground spill has no second emitter at the tower base");
    assert.ok(pixel(surface, 280)[3] > 0, "the rotating surface footprint reaches distant terrain/water");
    for (const color of ["#fdcf73", "#fdcf74", "#fdcf75", "#fdcf76"]) {
      map.lights[0].color = color; drawForestLighthouseBeams(context().ctx, map, options);
    }
    assert.equal(canvases.length, 10);
    drawForestLighthouseBeams(context().ctx, map, { ...options, elapsed: 111 });
    assert.equal(canvases.length, 10, "animation reuses the retained colour pair");
    map.lights[0].color = "#fdcf72"; drawForestLighthouseBeams(context().ctx, map, options);
    assert.equal(canvases.length, 12, "oldest colour is evicted after four colour pairs");
  } finally {
    if (beforeDocument === undefined) delete globalThis.document; else globalThis.document = beforeDocument;
  }
});

test("offscreen lighthouse tips remain visible, and world boundaries clip the beam without changing canvas state", () => {
  const map = { ...scene(), lights: [], sites: [{ id: "lighthouse", initialLevel: 1,
    bounds: { x: -300, y: 100, width: 100, height: 100 }, states: [{ level: 1, image: "/world/prototype/lighthouse-level-1.png" }] }] };
  const beforeDocument = globalThis.document;
  globalThis.document = { createElement: () => ({ width: 0, height: 0, getContext: () => context().ctx }) };
  try {
    const paint = context(), original = paint.state();
    drawForestLighthouseBeams(paint.ctx, map, options);
    assert.equal(paint.calls.filter(call => call.method === "drawImage").length, 4);
    assert.ok(paint.calls.some(call => call.method === "lineTo" && call.args[0] === map.width && call.args[1] === map.height));
    assert.ok(paint.calls.findIndex(call => call.method === "clip") < paint.calls.findIndex(call => call.method === "drawImage"));
    assert.deepEqual(paint.state(), original); assert.equal(paint.stack.length, 0);
  } finally {
    if (beforeDocument === undefined) delete globalThis.document; else globalThis.document = beforeDocument;
  }
});

test("Fresnel lens clips to transformed glass, keeps authored warm halo and bounded intensity in both qualities", () => {
  const map = { ...scene(), lights: [{ ...source("lighthouse-lens"), intensity: 1.4, color: "#ffcc88" }],
    sites: [{ id: "lighthouse", initialLevel: 1, bounds: { x: 100, y: 100, width: 100, height: 100 },
      states: [{ level: 1, image: "/world/prototype/lighthouse-level-1.png" }] }] };
  const glass = forestLightSources(map)[0].glass;
  for (const quality of ["high", "low"]) {
    const paint = context(), original = paint.state();
    drawForestLightEmitters(paint.ctx, map, { ...options, quality });
    const ellipse = paint.calls.find(call => call.method === "ellipse");
    assert.deepEqual(ellipse.args.slice(0, 4), [0, 0, glass.width / 2, glass.height / 2]);
    assert.ok(paint.calls.some(call => call.method === "rotate" && call.args[0] === glass.rotation));
    assert.equal(paint.calls.filter(call => call.method === "fillRect").length, quality === "high" ? 6 : 3);
    assert.ok(paint.calls.find(call => call.method === "gradient").gradient.stops[0][1].includes("255,204,136"));
    assert.ok(paint.calls.every(call => call.globalAlpha === undefined || call.globalAlpha >= 0 && call.globalAlpha <= 1));
    assert.deepEqual(paint.state(), original); assert.equal(paint.stack.length, 0);
  }
  map.sites[0].bounds = { x: -76, y: 100, width: 100, height: 200 };
  const edge = context(); drawForestLightEmitters(edge.ctx, map, options);
  assert.ok(edge.calls.some(call => call.method === "ellipse"), "scaled lens halo enters the camera before its offscreen center");
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
