import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root,
  resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false } });
after(() => vite.close());
const { createPhaserCameraInput } = await vite.ssrLoadModule("/features/world/phaser/camera-input.ts");

function harness({ editing = false } = {}) {
  const previous = Object.fromEntries(["window", "document", "ResizeObserver"].map(key => [key, globalThis[key]]));
  const window = new EventTarget();
  window.devicePixelRatio = 3;
  const document = { activeElement: null };
  const observer = { disconnected: false };
  Object.assign(globalThis, { window, document, ResizeObserver: class {
    observe() {}
    disconnect() { observer.disconnected = true; }
  } });
  const rect = { left: 0, top: 0, width: 400, height: 300 };
  const canvas = new EventTarget(), captured = new Set();
  const dispatch = (type, values = {}) => {
    const event = new Event(type, { cancelable: true });
    Object.assign(event, { pointerId: 1, pointerType: "touch", button: 0, clientX: 200, clientY: 150, ...values });
    canvas.dispatchEvent(event);
    return event;
  };
  Object.assign(canvas, { style: {}, getBoundingClientRect: () => rect,
    setAttribute() {}, focus() { document.activeElement = canvas; },
    setPointerCapture(id) { captured.add(id); }, hasPointerCapture: id => captured.has(id),
    releasePointerCapture(id) { captured.delete(id); dispatch("lostpointercapture", { pointerId: id }); } });
  const camera = { x: 0, y: 0, zoom: 1,
    setZoom(value) { this.zoom = value; return this; },
    centerOn(x, y) { this.x = x; this.y = y; return this; }, setViewport() { return this; } };
  let buffer = null;
  const scene = { game: { canvas }, cameras: { main: camera }, scale: { resize(w, h) { buffer = [w, h]; } } };
  const calls = { taps: [], moves: [], ends: 0, cancels: 0 };
  const input = createPhaserCameraInput(scene, { getBoundingClientRect: () => rect },
    { width: 1000, height: 1000, focus: { x: 400, y: 400, width: 200, height: 200 } },
    { tap: point => calls.taps.push(point), beginDrag: () => editing,
      moveDrag: point => calls.moves.push(point), endDrag: () => calls.ends++, cancelDrag: () => calls.cancels++ });
  return { input, calls, camera, canvas, dispatch, observer, get buffer() { return buffer; },
    dispose() { input.dispose(); Object.assign(globalThis, previous); } };
}

test("pinch release keeps the remaining captured finger panning and does not create a tap", () => {
  const h = harness();
  try {
    h.dispatch("pointerdown", { pointerId: 1, clientX: 100 });
    h.dispatch("pointerdown", { pointerId: 2, clientX: 300 });
    h.dispatch("pointermove", { pointerId: 2, clientX: 350 });
    assert.ok(h.input.zoom > 1);
    h.dispatch("pointerup", { pointerId: 2, clientX: 350 });
    const before = h.camera.x;
    h.dispatch("pointermove", { pointerId: 1, clientX: 140 });
    assert.ok(h.camera.x < before);
    h.dispatch("pointerup", { pointerId: 1, clientX: 140 });
    assert.equal(h.calls.taps.length, 0);
  } finally { h.dispose(); }
});

test("wheel zoom preserves the touched world point and caps backing pixel density", () => {
  const h = harness();
  try {
    assert.deepEqual(h.buffer, [800, 600]);
    const before = { x: h.camera.x + 100 / h.input.zoom, y: h.camera.y + 20 / h.input.zoom };
    h.dispatch("wheel", { clientX: 300, clientY: 170, deltaY: -200, deltaMode: 0 });
    h.dispatch("pointerdown", { clientX: 300, clientY: 170 });
    h.dispatch("pointerup", { clientX: 300, clientY: 170 });
    const after = h.calls.taps.at(-1);
    assert.ok(Math.abs(after.x - before.x) < 1e-6);
    assert.ok(Math.abs(after.y - before.y) < 1e-6);
  } finally { h.dispose(); }
});

test("editing commits once on release, Escape cancels, and disposed gestures have no listeners", () => {
  const h = harness({ editing: true });
  try {
    h.dispatch("pointerdown");
    h.dispatch("pointermove", { clientX: 230 });
    h.dispatch("pointermove", { clientX: 250 });
    assert.equal(h.calls.ends, 0);
    h.dispatch("pointerup", { clientX: 250 });
    assert.equal(h.calls.ends, 1);
    h.dispatch("pointerdown");
    h.dispatch("pointermove", { clientX: 230 });
    h.dispatch("keydown", { key: "Escape" });
    h.dispatch("pointerup", { clientX: 230 });
    assert.equal(h.calls.ends, 1);
    assert.equal(h.calls.cancels, 1);
    h.input.dispose();
    const count = h.calls.moves.length;
    h.dispatch("pointerdown");
    h.dispatch("pointermove", { clientX: 260 });
    assert.equal(h.calls.moves.length, count);
    assert.equal(h.observer.disconnected, true);
  } finally { h.dispose(); }
});
