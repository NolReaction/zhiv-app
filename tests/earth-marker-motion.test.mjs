import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const audioId = "virtual:earth-marker-audio";
const vite = await createServer({ appType: "custom", configFile: false, root,
  resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false },
  plugins: [{ name: "earth-marker-audio", enforce: "pre",
    resolveId(id) { if (id === audioId) return "\0" + audioId; },
    load(id) { if (id === "\0" + audioId) return "export const events=[];const runtime={play:event=>events.push(event)};export const getAudioRuntime=()=>runtime;"; },
    transform(source, id) {
      if (id.endsWith("/features/earth/marker-motion.ts")) return source.replace('from "@/features/audio/runtime/audio-service";', `from "${audioId}";`);
    },
  }] });
const { events: audioEvents } = await vite.ssrLoadModule(audioId);
const { createEarthPositionMarker, updateEarthPositionMarkerLabel } = await vite.ssrLoadModule("/features/earth/position-marker.ts");
const { earthMarkerMotion, bindEarthPositionMarkerMotion } = await vite.ssrLoadModule("/features/earth/marker-motion.ts");
const previousDocument = Object.getOwnPropertyDescriptor(globalThis, "document");

class Events extends EventTarget {
  listeners = new Map();
  addEventListener(type, listener, options) {
    const entries = this.listeners.get(type) ?? new Set();
    entries.add(listener); this.listeners.set(type, entries);
    super.addEventListener(type, listener, options);
  }
  removeEventListener(type, listener, options) {
    this.listeners.get(type)?.delete(listener);
    super.removeEventListener(type, listener, options);
  }
  count() { return [...this.listeners.values()].reduce((sum, entries) => sum + entries.size, 0); }
  emit(type) { this.dispatchEvent(new Event(type)); }
}
class Element extends Events {
  constructor(tag) {
    super(); this.tag = tag; this.attributes = {}; this.children = []; this.dataset = {};
    this.style = { setProperty(name, value) { this[name] = value; } };
    this.classList = { contains: name => (this.className ?? "").split(" ").includes(name) };
    this.draws = [];
    const context = { fillRect() {}, clearRect() {}, drawImage: source => this.draws.push(source) };
    this.getContext = () => context;
  }
  setAttribute(name, value) { this.attributes[name] = value; }
  toggleAttribute(name, value) { if (value) this.setAttribute(name, ""); else delete this.attributes[name]; }
  append(...children) { this.children.push(...children); }
  querySelector(selector) { return this.children.find(child => child.className === selector.slice(1)) ?? null; }
}
globalThis.document = { createElement: tag => new Element(tag) };
after(async () => {
  if (previousDocument) Object.defineProperty(globalThis, "document", previousDocument);
  else delete globalThis.document;
  await vite.close();
});

function fixture() {
  let now = 0, sequence = 0;
  const timers = new Map();
  const mapEvents = new Events();
  const camera = { longitude: 0, latitude: 0, bearing: 0, pitch: 0, zoom: 1 };
  const map = {
    getCenter: () => ({ lng: camera.longitude, lat: camera.latitude }),
    getBearing: () => camera.bearing,
    getPitch: () => camera.pitch,
    getZoom: () => camera.zoom,
    on: (type, listener) => mapEvents.addEventListener(type, listener),
    off: (type, listener) => mapEvents.removeEventListener(type, listener),
  };
  const document = new Events(); document.visibilityState = "visible";
  const reducedMotion = new Events(); reducedMotion.matches = false;
  const environment = {
    document, reducedMotion, now: () => now,
    setTimeout(callback, delay) { const id = ++sequence; timers.set(id, { callback, due: now + delay }); return id; },
    clearTimeout: id => timers.delete(id),
  };
  const marker = createEarthPositionMarker();
  marker.style.transform = "translate(100px, 120px)";
  marker.style.opacity = "1";
  const portrait = marker.children[0];
  const canvas = portrait.children[0];
  const dispose = bindEarthPositionMarkerMotion(map, marker, environment);
  return {
    marker, portrait, canvas, camera, mapEvents, document, reducedMotion, timers, dispose,
    move(values) { now += 16; Object.assign(camera, values); mapEvents.emit("move"); },
    advance(duration) {
      const until = now + duration;
      for (;;) {
        const next = [...timers.entries()].filter(([, timer]) => timer.due <= until).sort((a, b) => a[1].due - b[1].due)[0];
        if (!next) break;
        timers.delete(next[0]); now = next[1].due; next[1].callback();
      }
      now = until;
    },
  };
}

test("date-line and bearing wrap preserve the direction and size of a small turn", () => {
  const camera = { longitude: 179, latitude: 0, bearing: 179, pitch: 0 };
  const wrapped = earthMarkerMotion(camera, { ...camera, longitude: -179, bearing: -179 }, 16);
  const continuous = earthMarkerMotion({ ...camera, longitude: 0, bearing: 0 }, { ...camera, longitude: 2, bearing: 2 }, 16);
  assert.deepEqual(wrapped, continuous);
  assert.ok(wrapped.lean < 0 && wrapped.lean > -10);
  assert.ok(earthMarkerMotion(camera, { ...camera, longitude: 178 }, 16).lean > 0);
});

test("camera jumps and pitch stay bounded; invalid input cannot write NaN to CSS", () => {
  const camera = { longitude: 0, latitude: 0, bearing: 0, pitch: 0 };
  const jumped = earthMarkerMotion(camera, { longitude: 150, latitude: 80, bearing: 120, pitch: 60 }, 1);
  assert.ok(Math.abs(jumped.lean) <= 10 && Math.abs(jumped.x) <= 2.5 && Math.abs(jumped.y) <= 2);
  assert.ok(earthMarkerMotion(camera, { ...camera, pitch: 3 }, 16).y > 0);
  assert.deepEqual(earthMarkerMotion(camera, { ...camera, longitude: NaN }, 16), { lean: 0, x: 0, y: 0 });
});

test("rotation only moves the portrait; settling leaves no JavaScript animation loop", () => {
  const s = fixture();
  s.move({ longitude: 2 });
  assert.equal(s.portrait.dataset.motion, "moving");
  assert.ok(parseFloat(s.portrait.style["--marker-lean"]) < 0);
  assert.equal(s.marker.style.transform, "translate(100px, 120px)");
  assert.equal(s.marker.style.opacity, "1");
  assert.equal(s.canvas.draws.length, 1, "camera events do not repaint the cached sprite");
  s.mapEvents.emit("moveend");
  assert.equal(s.portrait.dataset.motion, "settling");
  assert.equal(s.portrait.style["--marker-lean"], "0deg");
  assert.equal(s.timers.size, 0);
  s.dispose();
});

test("the player portrait hides at extreme distance and returns at its geographic anchor", () => {
  const s = fixture();
  s.marker.emit("click");
  assert.equal(s.timers.size, 1);
  s.move({ zoom: -1.5 });
  assert.equal(s.marker.style.visibility, "hidden");
  assert.ok("disabled" in s.marker.attributes);
  assert.equal(s.timers.size, 0);
  assert.equal(s.marker.style.transform, "translate(100px, 120px)");
  s.move({ zoom: 0.5 });
  assert.equal(s.marker.style.visibility, "");
  assert.ok(!("disabled" in s.marker.attributes));
  s.dispose();
});

test("a tap waves briefly, and a repeated tap replaces rather than adds timers", () => {
  const s = fixture();
  const idle = s.canvas.draws[0];
  updateEarthPositionMarkerLabel(s.marker, 25);
  s.marker.emit("click");
  assert.notEqual(s.canvas.draws.at(-1), idle);
  s.advance(130); assert.equal(s.timers.size, 1);
  s.marker.emit("click"); assert.equal(s.timers.size, 1);
  s.advance(700);
  assert.equal(s.canvas.draws.at(-1), idle);
  assert.equal(s.timers.size, 0);
  assert.match(s.marker.attributes["aria-label"], /точность ±25 м/);
  s.dispose();
});

test("self-marker clicks sound once only after visibility, distance and occlusion guards succeed", () => {
  audioEvents.length = 0;
  const s = fixture();
  assert.deepEqual(audioEvents, [], "mount and camera motion are silent");
  s.marker.emit("click");
  assert.deepEqual(audioEvents.map(event => event.cueId), ["ui.click"]);
  s.marker.className += " maplibregl-marker-covered";
  s.marker.emit("click");
  s.marker.className = s.marker.className.replace(" maplibregl-marker-covered", "");
  s.move({ zoom: -1.5 }); s.marker.emit("click");
  s.move({ zoom: 1 });
  s.document.visibilityState = "hidden"; s.marker.emit("click");
  s.document.visibilityState = "visible"; s.dispose(); s.marker.emit("click");
  assert.equal(audioEvents.length, 1);
  assert.equal(s.marker.dataset.audioCue, undefined, "there is no capture-phase duplicate before the click guard");
});

test("reduced motion uses a single static greeting and resets immediately when the preference changes", () => {
  const s = fixture();
  s.reducedMotion.matches = true; s.reducedMotion.emit("change");
  s.move({ longitude: 10, pitch: 20 });
  assert.equal(s.portrait.style["--marker-lean"], "0deg");
  s.marker.emit("click");
  const count = s.canvas.draws.length;
  s.advance(650); assert.equal(s.canvas.draws.length, count);
  s.advance(50); assert.equal(s.canvas.draws.length, count + 1);
  s.reducedMotion.matches = false; s.reducedMotion.emit("change");
  s.marker.emit("click");
  s.reducedMotion.matches = true; s.reducedMotion.emit("change");
  assert.equal(s.timers.size, 0);
  s.dispose();
});

test("hidden and occluded markers stop reactions and cannot be focused or clicked", () => {
  const s = fixture();
  s.marker.emit("click");
  s.document.visibilityState = "hidden"; s.document.emit("visibilitychange");
  assert.equal(s.timers.size, 0);
  assert.equal(s.marker.attributes.disabled, "");
  s.move({ longitude: 90 }); assert.equal(s.portrait.dataset.motion, "still");
  s.document.visibilityState = "visible"; s.document.emit("visibilitychange");
  assert.equal(s.marker.attributes.disabled, undefined);
  s.marker.className += " maplibregl-marker-covered";
  s.move({ longitude: 95 });
  assert.equal(s.marker.attributes.disabled, "");
  s.marker.emit("click"); assert.equal(s.timers.size, 0);
  s.dispose();
});

test("disposing the binding removes every listener and pending greeting callback", () => {
  const s = fixture();
  s.marker.emit("click");
  s.dispose(); s.dispose();
  const count = s.canvas.draws.length;
  s.advance(10_000); s.move({ longitude: 5 }); s.marker.emit("click");
  assert.equal(s.canvas.draws.length, count);
  assert.equal(s.timers.size, 0);
  for (const events of [s.marker, s.mapEvents, s.document, s.reducedMotion]) assert.equal(events.count(), 0);
  assert.equal(s.marker.style.transform, "translate(100px, 120px)");
});
