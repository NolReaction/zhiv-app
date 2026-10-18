import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root,
  server: { middlewareMode: true, hmr: false, ws: false } });
after(() => vite.close());
const { createEarthClouds } = await vite.ssrLoadModule("/features/earth/globe-clouds.ts");

function scene({ zoom = 1, failAttachmentAt = -1 } = {}) {
  const markers = [];
  const listeners = new Map();
  let styleWrites = 0;
  const ownerDocument = {
    createElement(tag) {
      return {
        tag, attributes: {}, children: [],
        style: new Proxy({}, { set(target, key, value) { styleWrites++; target[key] = value; return true; } }),
        setAttribute(name, value) { this.attributes[name] = value; },
        append(...children) { this.children.push(...children); },
      };
    },
    createElementNS(_namespace, tag) { return this.createElement(tag); },
  };
  const map = {
    getContainer: () => ({ ownerDocument }),
    getZoom: () => zoom,
    on(event, listener) { listeners.set(event, listener); },
    off(event, listener) { if (listeners.get(event) === listener) listeners.delete(event); },
  };
  class Marker {
    constructor(options) {
      this.options = options;
      this.positions = [];
      this.removed = 0;
      // Simulate fields owned by the real SDK, never by the cloud artwork.
      options.element.style.opacity = "0";
      options.element.style.transform = "translate(12px, 34px)";
      markers.push(this);
    }
    setLngLat(position) { this.positions.push(position); return this; }
    addTo(target) {
      assert.equal(target, map);
      if (markers.length - 1 === failAttachmentAt) throw new Error("attachment failed");
      return this;
    }
    remove() { this.removed++; }
  }
  return {
    create: () => createEarthClouds(map, Marker),
    markers, listeners,
    setZoom(value) { zoom = value; listeners.get("zoom")?.(); },
    get styleWrites() { return styleWrites; },
  };
}

function lastPosition(marker) { return marker.positions.at(-1); }
function wrapper(marker) { return marker.options.element; }
function visual(marker) { return wrapper(marker).children[0]; }

test("eight decorative native markers preserve SDK projection and back-globe occlusion", () => {
  const state = scene();
  const clouds = state.create();
  assert.equal(state.markers.length, 8);
  for (const marker of state.markers) {
    assert.equal(marker.options.opacityWhenCovered, 0);
    assert.equal(marker.options.subpixelPositioning, true);
    assert.equal(marker.options.draggable, false);
    assert.equal(marker.options.pitchAlignment, "viewport");
    assert.equal(wrapper(marker).attributes["aria-hidden"], "true");
    assert.equal(wrapper(marker).style.pointerEvents, "none");
    assert.equal(wrapper(marker).style.opacity, "0", "covered opacity belongs to MapLibre");
    assert.equal(wrapper(marker).style.transform, "translate(12px, 34px)");
    assert.equal(visual(marker).children.length, 2, "shadow and puff are separate original vectors");
    assert.ok(visual(marker).children.every(node => node.tag === "svg" && node.attributes.focusable === "false"));
  }
  clouds.update(5_000);
  for (const marker of state.markers) {
    assert.equal(wrapper(marker).style.opacity, "0");
    assert.equal(wrapper(marker).style.transform, "translate(12px, 34px)");
  }
  clouds.dispose();
});

test("a paused scene stays still while manual zoom fades and then completely removes the clouds", () => {
  const state = scene();
  const clouds = state.create();
  const positions = state.markers.map(marker => marker.positions.length);
  state.setZoom(2.5);
  assert.ok(state.markers.every(marker => visual(marker).style.opacity === "1"));
  state.setZoom(3.35);
  assert.ok(state.markers.every(marker => Math.abs(Number(visual(marker).style.opacity) - 0.5) < 0.00001));
  assert.deepEqual(state.markers.map(marker => marker.positions.length), positions);
  state.setZoom(4.2);
  assert.ok(state.markers.every(marker => wrapper(marker).style.display === "none"));
  const writes = state.styleWrites;
  clouds.update(5_000);
  clouds.update(10_000);
  assert.equal(state.styleWrites, writes);
  assert.deepEqual(state.markers.map(marker => marker.positions.length), positions);
  state.setZoom(1);
  assert.ok(state.markers.every(marker => wrapper(marker).style.display === "" && visual(marker).style.opacity === "1"));
  clouds.dispose();
});

test("extreme zoom-out hides decorative clouds instead of piling them over a tiny Earth", () => {
  const state = scene({ zoom: -1.5 });
  const clouds = state.create();
  assert.ok(state.markers.every(marker => wrapper(marker).style.display === "none"));
  const positions = state.markers.map(marker => marker.positions.length);
  clouds.update(30_000);
  assert.deepEqual(state.markers.map(marker => marker.positions.length), positions);
  state.setZoom(0.2);
  assert.ok(state.markers.every(marker => Math.abs(Number(visual(marker).style.opacity) - 0.5) < 0.00001));
  state.setZoom(0.6);
  assert.ok(state.markers.every(marker => visual(marker).style.opacity === "1"));
  state.setZoom(-0.2);
  assert.ok(state.markers.every(marker => wrapper(marker).style.display === "none"));
  clouds.dispose();
});

test("the shared absolute clock gives deterministic bounded drift, throttled to ten position writes per second", () => {
  const first = scene();
  const second = scene();
  const firstClouds = first.create();
  const secondClouds = second.create();
  const initial = first.markers.map(lastPosition);
  const initialWrites = first.markers[0].positions.length;
  for (let time = 0; time < 1_000; time += 16) firstClouds.update(time);
  assert.ok(first.markers[0].positions.length - initialWrites <= 10);
  firstClouds.update(60_000);
  secondClouds.update(60_000);
  assert.deepEqual(first.markers.map(lastPosition), second.markers.map(lastPosition));
  assert.ok(first.markers.every((marker, index) => lastPosition(marker)[0] > initial[index][0]));
  const beforeInvalid = first.markers.map(marker => marker.positions.length);
  for (const invalid of [NaN, Infinity, -1]) firstClouds.update(invalid);
  assert.deepEqual(first.markers.map(marker => marker.positions.length), beforeInvalid);
  firstClouds.update(48 * 60 * 60 * 1_000);
  for (const marker of first.markers) {
    const [longitude, latitude] = lastPosition(marker);
    assert.ok(Number.isFinite(longitude) && longitude >= -180 && longitude < 180);
    assert.ok(Number.isFinite(latitude) && Math.abs(latitude) < 90);
  }
  firstClouds.dispose();
  secondClouds.dispose();
});

test("hidden scenes make no animation writes and become static again when shown", () => {
  const state = scene();
  const clouds = state.create();
  clouds.setVisible(false);
  assert.ok(state.markers.every(marker => wrapper(marker).style.display === "none"));
  const writes = state.styleWrites;
  const positions = state.markers.map(marker => marker.positions.length);
  clouds.update(30_000);
  clouds.setVisible(false);
  state.setZoom(2);
  assert.equal(state.styleWrites, writes);
  assert.deepEqual(state.markers.map(marker => marker.positions.length), positions);
  clouds.setVisible(true);
  const restored = state.styleWrites;
  clouds.update(30_000);
  clouds.setVisible(true);
  assert.equal(state.styleWrites, restored, "showing a scene does not start or advance a clock");
  clouds.dispose();
});

test("disposal is idempotent and releases the zoom listener and every marker", () => {
  const state = scene();
  const clouds = state.create();
  assert.equal(state.listeners.size, 1);
  clouds.dispose();
  clouds.dispose();
  assert.equal(state.listeners.size, 0);
  assert.ok(state.markers.every(marker => marker.removed === 1));
  const writes = state.styleWrites;
  clouds.update(60_000);
  clouds.setVisible(false);
  state.setZoom(3);
  assert.equal(state.styleWrites, writes);
});

test("failed attachment removes even the partially attached marker", () => {
  const state = scene({ failAttachmentAt: 3 });
  assert.throws(state.create, /attachment failed/);
  assert.equal(state.markers.length, 4);
  assert.ok(state.markers.every(marker => marker.removed === 1));
  assert.equal(state.listeners.size, 0);
});
