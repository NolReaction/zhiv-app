import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
const vite = await createServer({ appType: "custom", configFile: false,
  root: fileURLToPath(new URL("..", import.meta.url)), server: { middlewareMode: true, hmr: false, ws: false } });
after(() => vite.close());
const { createEarthTouchPitch } = await vite.ssrLoadModule("/features/earth/touch-pitch.ts");
class Surface extends EventTarget {
  listeners = new Map();
  addEventListener(type, callback, options) { this.listeners.set(callback, { type, options }); super.addEventListener(type, callback, options); }
  removeEventListener(type, callback, options) { this.listeners.delete(callback); super.removeEventListener(type, callback, options); }
}
function fixture(initial = 0) {
  const owner = new Surface(), canvas = new Surface();owner.hidden = false;canvas.ownerDocument = owner;
  let pitch = initial, stops = 0, nativeEnabled = true;
  const writes = [], map = { getCanvasContainer: () => canvas, getPitch: () => pitch,
    getMinPitch: () => 0, getMaxPitch: () => 60, touchPitch: { isEnabled: () => nativeEnabled },
    setPitch(value, data) { pitch = value; writes.push({ value, data }); }, stop() { stops++; } };
  const controller = createEarthTouchPitch(map);
  const emit = (type, points) => {
    const event = new Event(type, { cancelable: true });
    Object.defineProperty(event, "touches", { value: points.map(([clientX, clientY, identifier = 0]) => ({ clientX, clientY, identifier })) });
    canvas.dispatchEvent(event); return event;
  };
  controller.setEnabled(true);
  return { owner, canvas, controller, emit, writes, get pitch() { return pitch; }, get stops() { return stops; },
    native(value) { nativeEnabled = value; } };
}
const start = [[195, 450, 1], [195, 550, 2]];

test("parallel vertical-finger movement pitches through the public camera API and clamps both ends", () => {
  const h = fixture();
  assert.equal(h.emit("touchstart", start).defaultPrevented, false);
  const event = h.emit("touchmove", [[195, 430, 1], [195, 530, 2]]);
  assert.equal(event.defaultPrevented, true);assert.equal(h.pitch, 10);assert.equal(h.stops, 1);
  assert.equal(h.writes[0].data.originalEvent, event);
  h.emit("touchmove", [[195, 250, 1], [195, 350, 2]]);assert.equal(h.pitch, 60);
  h.emit("touchmove", [[195, 650, 1], [195, 750, 2]]);assert.equal(h.pitch, 0);
  assert.equal(h.emit("touchend", [[195, 750, 2]]).defaultPrevented, true);
  assert.equal(h.emit("touchend", []).defaultPrevented, true);assert.equal(h.stops, 2);
  h.controller.dispose();
});

test("native side-by-side pitch, pinch, rotation and pan retain their whole SDK sequence", () => {
  const cases = [
    { start: [[140, 500, 1], [250, 500, 2]], move: [[140, 450, 1], [250, 450, 2]] },
    { start, move: [[195, 430, 1], [195, 570, 2]] },
    { start, move: [[170, 457, 1], [220, 543, 2]] },
    { start, move: [[225, 450, 1], [225, 550, 2]] },
    { start: [[195, 450, 1]], move: [[195, 350, 1]] },
  ];
  for (const item of cases) {
    const h = fixture();h.emit("touchstart", item.start);
    assert.equal(h.emit("touchmove", item.move).defaultPrevented, false);
    assert.equal(h.emit("touchmove", [[195, 390, 1], [195, 490, 2]]).defaultPrevented, false);
    h.emit("touchend", []);assert.equal(h.writes.length, 0);assert.equal(h.stops, 0);h.controller.dispose();
  }
});

test("small or one-finger motion cannot claim a pitch; a third finger never produces a new camera delta", () => {
  const h = fixture();h.emit("touchstart", start);
  assert.equal(h.emit("touchmove", [[195, 448, 1], [195, 548, 2]]).defaultPrevented, false);
  assert.equal(h.writes.length, 0);
  h.emit("touchmove", [[195, 430, 1], [195, 530, 2]]);assert.equal(h.pitch, 10);
  h.emit("touchstart", [[195, 430, 1], [195, 530, 2], [250, 530, 3]]);
  assert.equal(h.emit("touchmove", [[195, 410, 1], [195, 510, 2], [250, 530, 3]]).defaultPrevented, true);
  assert.equal(h.pitch, 10);
  h.emit("touchend", []);h.controller.dispose();
});

test("pause, native disable, document hiding and cancellation retire claims without changing native handlers", () => {
  for (const pause of [h => h.controller.setEnabled(false), h => { h.native(false);h.emit("touchmove", [[195, 410, 1], [195, 510, 2]]); },
    h => { h.owner.hidden = true;h.owner.dispatchEvent(new Event("visibilitychange")); }, h => h.emit("touchcancel", [])]) {
    const h = fixture();h.emit("touchstart", start);h.emit("touchmove", [[195, 430, 1], [195, 530, 2]]);
    pause(h);assert.equal(h.stops, 2);assert.equal(h.pitch, 10);
    h.emit("touchmove", [[195, 390, 1], [195, 490, 2]]);assert.equal(h.pitch, 10);h.controller.dispose();
  }
});

test("a fresh first touch retires a dropped end, and disposal removes every listener and late camera write", () => {
  const h = fixture();h.emit("touchstart", start);h.emit("touchmove", [[195, 430, 1], [195, 530, 2]]);
  h.emit("touchstart", [[195, 450, 5]]);assert.equal(h.stops, 2);
  h.emit("touchstart", [[195, 450, 5], [195, 550, 6]]);
  h.emit("touchmove", [[195, 430, 5], [195, 530, 6]]);assert.equal(h.pitch, 20);
  const startListener = [...h.canvas.listeners.values()].find(item => item.type === "touchstart");
  assert.equal(startListener.options.passive, true, "iOS double-tap keeps a passive touchstart path");
  h.controller.dispose();h.controller.dispose();assert.equal(h.canvas.listeners.size, 0);assert.equal(h.owner.listeners.size, 0);
  h.controller.setEnabled(true);h.emit("touchstart", start);h.emit("touchmove", [[195, 390, 1], [195, 490, 2]]);assert.equal(h.pitch, 20);
});
