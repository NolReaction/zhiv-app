import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, resolve: { alias: { "@": root } },
  server: { middlewareMode: true, hmr: false, ws: false } });
after(() => vite.close());
const { createEarthFriendMarkers, earthFriendScreenPoint } = await vite.ssrLoadModule("/features/earth/friend-markers.ts");
const { layoutEarthFriends } = await vite.ssrLoadModule("/features/earth/friend-marker-layout.ts");
const person = (circleId, longitude = 0, latitude = 0, extra = {}) => ({ circleId,
  user: { publicId: `public-${circleId}`, displayName: `Друг ${circleId}` }, latitude, longitude,
  accuracyMeters: 1500, precision: "APPROXIMATE", updatedAt: "2026-10-18T18:30:00.000Z",
  expiresAt: "2026-10-18T18:32:00.000Z", expiresAtMonotonic: 121_000, ...extra });

function fixture({ zoom = 3, width = 1000, height = 600, reduced = false, failMarker = false } = {}) {
  const markers = [], selected = [], flights = [], observers = [], elements = [];
  const listeners = new Map(), timers = new Map();
  let now = 1_000, sequence = 0, disposed = false;
  const ownerDocument = {
    defaultView: { MutationObserver: class {
      constructor(callback) { this.callback = callback; this.targets = new Set(); observers.push(this); }
      observe(element) { this.targets.add(element); }
      disconnect() { this.targets.clear(); }
    } },
    createElement(tag) {
      const handlers = new Map(), classes = new Set();
      const element = { tag, attributes: {}, dataset: {}, children: [], handlers, classes,
        setAttribute(key, value) { this.attributes[key] = value; }, append(...children) { this.children.push(...children); },
        classList: { contains: name => classes.has(name) },
        addEventListener(type, callback) {
          if (!handlers.has(type)) handlers.set(type, new Set()); handlers.get(type).add(callback);
        },
        removeEventListener(type, callback) { handlers.get(type)?.delete(callback); },
        dispatch(type, extra = {}) {
          const event = { stopped: false, defaultPrevented: false, ...extra,
            stopPropagation() { this.stopped = true; }, preventDefault() { this.defaultPrevented = true; } };
          for (const callback of handlers.get(type) ?? []) callback(event);
          return event;
        } };
      elements.push(element); return element;
    },
  };
  const container = { ownerDocument, clientWidth: width, clientHeight: height };
  const map = {
    getContainer: () => container, getZoom: () => zoom, getProjection: () => ({ type: "globe" }),
    project: ([longitude, latitude]) => ({ x: width / 2 + longitude * 5, y: height / 2 - latitude * 5 }),
    unproject: ({ x, y }) => ({ lng: (x - width / 2) / 5, lat: (height / 2 - y) / 5 }),
    flyTo(options) { flights.push(options); },
    on(type, callback) { if (!listeners.has(type)) listeners.set(type, new Set()); listeners.get(type).add(callback); },
    off(type, callback) { listeners.get(type)?.delete(callback); },
  };
  class Marker {
    constructor(options) { this.options = options; this.positions = []; this.removed = 0; markers.push(this); }
    setLngLat(location) { this.positions.push([...location]); return this; }
    addTo(target) { assert.equal(target, map); if (failMarker) throw new Error("attachment failed"); return this; }
    remove() { this.removed++; }
  }
  const renderer = createEarthFriendMarkers(map, Marker, ids => selected.push(ids), {
    now: () => now, schedule(callback, delay) { const id = ++sequence; timers.set(id, { callback, due: now + delay }); return id; },
    cancel: id => timers.delete(id), reducedMotion: () => reduced,
  });
  const emit = type => { for (const callback of listeners.get(type) ?? []) callback(); };
  return { renderer, map, markers, selected, flights, observers, elements, listeners, timers, emit,
    get current() { return markers.filter(marker => !marker.removed); },
    show(rows) { renderer.setVisible(true); renderer.setSnapshot(rows); },
    zoom(value) { zoom = value; emit("move"); },
    cover(marker, covered) {
      if (covered) marker.options.element.classes.add("maplibregl-marker-covered");
      else marker.options.element.classes.delete("maplibregl-marker-covered");
      for (const observer of observers) observer.callback();
    },
    advance(duration, runTimers = true) {
      const end = now + duration;
      if (runTimers) while (timers.size) {
        const [id, timer] = [...timers].sort((a, b) => a[1].due - b[1].due)[0];
        if (timer.due > end) break;
        timers.delete(id); now = timer.due; timer.callback();
      }
      now = end;
    },
    dispose() { if (!disposed) renderer.dispose(); disposed = true; },
  };
}

test("bounded clustering anchors groups on real members, preserves inputs and reserves private GPS", () => {
  const points = Object.freeze([{ circleId: "b", x: 111, y: 105 }, { circleId: "a", x: 100, y: 100 },
    { circleId: "self-overlap", x: 320, y: 300 }, { circleId: "separate", x: 600, y: 300 }].map(Object.freeze));
  const groups = layoutEarthFriends(points, { width: 800, height: 600 }, { x: 320, y: 300 });
  assert.equal(groups.length, 2);
  const cluster = groups.find(group => group.circleIds.length === 2);
  assert.deepEqual(cluster, { anchorId: "a", circleIds: ["a", "b"], x: 100, y: 100 });
  assert.equal(groups.some(group => group.circleIds.includes("self-overlap")), false);
  const many = Array.from({ length: 100 }, (_, index) => ({ circleId: String(index).padStart(3, "0"),
    x: 100 + index % 10 * 100, y: 100 + Math.floor(index / 10) * 100 }));
  const bounded = layoutEarthFriends(many, { width: 1200, height: 1200 }, null);
  assert.equal(bounded.length, 24);
  assert.ok(bounded.every(group => many.some(point => point.circleId === group.anchorId && point.x === group.x && point.y === group.y)));
});

test("public globe projection excludes the far hemisphere and handles longitude wrapping", () => {
  const map = { project: () => ({ x: 10, y: 20 }), getProjection: () => ({ type: "globe" }),
    unproject: () => ({ lng: -179, lat: 40 }) };
  assert.deepEqual(earthFriendScreenPoint(map, { longitude: 181 - 360, latitude: 40 }), { x: 10, y: 20 });
  map.unproject = () => ({ lng: 181, lat: 40 });
  assert.deepEqual(earthFriendScreenPoint(map, { longitude: -179, latitude: 40 }), { x: 10, y: 20 });
  assert.equal(earthFriendScreenPoint(map, { longitude: 1, latitude: -40 }), null);
  for (const longitude of [NaN, Infinity, -181, 181]) assert.equal(earthFriendScreenPoint(map, { longitude, latitude: 40 }), null);
  map.getProjection = () => ({ type: "mercator" });
  assert.deepEqual(earthFriendScreenPoint(map, { longitude: 1, latitude: -40 }), { x: 10, y: 20 });
});

test("only fresh real feed positions become anchored, labelled pins without remote markup or coordinate attributes", () => {
  const f = fixture();
  const friend = person("alice", 12.3, 25.5, { user: { publicId: "friend", displayName: "<img src=x> Алиса" } });
  f.renderer.setSnapshot([friend]); assert.equal(f.current.length, 0, "hidden input is discarded");
  f.show([friend]);
  assert.equal(f.current.length, 1);
  const marker = f.current[0], element = marker.options.element;
  assert.deepEqual(marker.positions.at(-1), [12.3, 25.5]);
  assert.deepEqual(element.dataset, { earthFriend: "true", cluster: "false" });
  assert.equal(element.tag, "button"); assert.equal(element.disabled, false); assert.equal(element.tabIndex, 0);
  assert.equal(element.children.length, 1); assert.equal(element.children[0].tag, "span");
  assert.equal(element.children[0].innerHTML, undefined); assert.match(element.attributes["aria-label"], /<img src=x>/);
  assert.match(element.attributes["aria-label"], /примерное местоположение ±1,5 км/);
  assert.doesNotMatch(JSON.stringify(element.attributes), /12\.3|25\.5/);
  for (const [key, value] of Object.entries({ anchor: "bottom", pitchAlignment: "viewport", rotationAlignment: "viewport",
    opacityWhenCovered: 0, subpixelPositioning: true })) assert.equal(marker.options[key], value);
  f.dispose();
});

test("nearby friends form one accessible group and native Enter/Space activation reaches only its member IDs", () => {
  const f = fixture(); f.show([person("b", 1, 1), person("a", 0, 0), person("c", 35, 0)]);
  assert.equal(f.current.length, 2);
  const cluster = f.current.find(marker => marker.options.element.dataset.cluster === "true");
  const element = cluster.options.element;
  assert.equal(element.children[0].textContent, "2");
  assert.match(element.attributes["aria-label"], /Близкие рядом: 2/);
  for (const type of ["pointerdown", "mousedown", "touchstart"]) assert.equal(element.dispatch(type).stopped, true);
  for (const key of ["Enter", " "]) {
    const event = element.dispatch("keydown", { key }); assert.equal(event.stopped, true); assert.equal(event.defaultPrevented, false);
  }
  assert.equal(element.dispatch("keydown", { key: "Tab" }).stopped, false);
  element.dispatch("click"); assert.deepEqual(f.selected, [["a", "b"]]);
  f.cover(cluster, true); assert.equal(element.disabled, true); assert.equal(element.tabIndex, -1);
  element.dispatch("click"); assert.equal(f.selected.length, 1);
  f.cover(cluster, false); assert.equal(element.disabled, false);
  f.dispose();
});

test("replacement revokes markers immediately and expires remaining coordinates with one monotonic timer", () => {
  const f = fixture(); f.show([person("a", -35), person("b", 35, 0, { expiresAtMonotonic: 31_000 })]);
  assert.equal(f.current.length, 2); assert.equal(f.timers.size, 1);
  const removed = f.current.find(marker => marker.positions.at(-1)[0] === -35);
  f.renderer.setSnapshot([person("b", 35, 0, { expiresAtMonotonic: 31_000 })]);
  assert.equal(removed.removed, 1); assert.equal(f.current.length, 1);
  removed.options.element.dispatch("click"); assert.deepEqual(f.selected, []);
  f.advance(30_000); assert.equal(f.current.length, 0); assert.equal(f.timers.size, 0);
  assert.equal(f.renderer.focusFriend("b"), false);
  f.dispose();
});

test("repeated snapshot of the same point cannot extend its deadline or permit a click after expiry", () => {
  const f = fixture(); f.show([person("a", 0, 0, { expiresAtMonotonic: 11_000 })]);
  f.advance(5_000);
  f.renderer.setSnapshot([person("a", 0, 0, { expiresAtMonotonic: 121_000 })]);
  assert.equal([...f.timers.values()][0].due, 11_000);
  const marker = f.current[0];
  f.advance(5_001, false); marker.options.element.dispatch("click");
  assert.deepEqual(f.selected, []); assert.equal(f.current.length, 0); assert.equal(f.timers.size, 0);
  f.dispose();
});

test("hidden maps purge coordinates, listeners and timers; returning needs a fresh snapshot", () => {
  const f = fixture(); f.show([person("a")]);
  const oldTimer = [...f.timers.values()][0].callback;
  f.renderer.setVisible(false);
  assert.equal(f.current.length, 0); assert.equal(f.timers.size, 0); assert.equal(f.observers[0].targets.size, 0);
  f.renderer.setSnapshot([person("a")]); f.renderer.setVisible(true);
  assert.equal(f.current.length, 0); assert.equal(f.renderer.focusFriend("a"), false);
  f.renderer.setSnapshot([person("b", 20)]);
  oldTimer(); assert.equal(f.current.length, 1, "a canceled expiry cannot erase a newer generation");
  assert.equal(f.renderer.focusFriend("a"), false); assert.equal(f.renderer.focusFriend("b"), true);
  f.dispose();
});

test("tiny globe and private GPS overlap remove only drawing, preserving a valid explicit focus action", () => {
  const f = fixture({ reduced: true }); f.show([person("a")]);
  f.renderer.setSelfPosition({ latitude: 0, longitude: 0, accuracy: 10, timestamp: Date.now() });
  assert.equal(f.current.length, 0);
  f.renderer.setSelfPosition(null); assert.equal(f.current.length, 1);
  f.zoom(-0.2); assert.equal(f.current.length, 0);
  assert.equal(f.renderer.focusFriend("a"), true);
  assert.deepEqual(f.flights[0].center, [0, 0]); assert.equal(f.flights[0].duration, 0); assert.equal(f.flights[0].essential, false);
  assert.ok(f.flights[0].zoom < 12, "approximate sharing never pretends to identify an exact building");
  f.zoom(2); assert.equal(f.current.length, 1);
  f.dispose();
});

test("invalid, duplicate, expired and overlong deadlines are ignored before any projection", () => {
  const f = fixture();
  f.show([person("a"), person("a", 10), person("nan", NaN), person("latitude", 0, 91),
    person("expiry", 35, 0, { expiresAtMonotonic: 999 }), person("future", 35, 0, { expiresAtMonotonic: 122_000 }),
    person("accuracy", 35, 0, { accuracyMeters: -1 }), person("false-precision", 35, 0, { accuracyMeters: 10 })]);
  assert.equal(f.current.length, 1); assert.deepEqual(f.current[0].positions.at(-1), [0, 0]);
  f.dispose();
});

test("panning bounds DOM and observer targets, and disposal fences late events with no retained handlers", () => {
  const f = fixture({ width: 2000, height: 1200 });
  const rows = Array.from({ length: 100 }, (_, index) => person(String(index).padStart(3, "0"), -89 + index % 10 * 19, -80 + Math.floor(index / 10) * 17));
  f.show(rows); assert.equal(f.current.length, 24); assert.equal(f.observers[0].targets.size, 24);
  for (let index = 0; index < 5; index++) {
    f.renderer.setSnapshot(rows.slice(index * 10)); f.emit("move");
    assert.ok(f.current.length <= 24); assert.equal(f.observers[0].targets.size, f.current.length);
  }
  const late = [...f.timers.values()][0].callback;
  f.dispose(); f.renderer.dispose(); late(); f.emit("move");
  f.renderer.setVisible(true); f.renderer.setSnapshot(rows);
  assert.equal(f.current.length, 0); assert.equal(f.timers.size, 0); assert.equal(f.observers[0].targets.size, 0);
  assert.ok([...f.listeners.values()].every(set => set.size === 0));
  assert.ok(f.elements.every(element => [...element.handlers.values()].every(set => set.size === 0)));
  assert.ok(f.markers.every(marker => marker.removed === 1));
});

test("a failed native marker attachment releases its handlers and leaves the map usable", () => {
  const f = fixture({ failMarker: true });
  assert.doesNotThrow(() => f.show([person("a")]));
  assert.equal(f.current.length, 0); assert.ok(f.markers.every(marker => marker.removed === 1));
  assert.ok(f.elements.every(element => [...element.handlers.values()].every(set => set.size === 0)));
  f.dispose();
});
