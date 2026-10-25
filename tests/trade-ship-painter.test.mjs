import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, resolve: { alias: { "@": root } },
  server: { middlewareMode: true, hmr: false, ws: false } });
after(() => vite.close());
const { drawTradeShip, tradeShipGatePoint } = await vite.ssrLoadModule("/features/world/objects/trade-ship/trade-ship-painter.ts");

const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-8, `${actual} ≠ ${expected}`);
// Invert the art camera to measure physical lengths, rather than screen widths.
function unproject(point, height = 0) {
  const x = point.x - 400, y = point.y - 300 + height;
  const depth = (y + .20 * x) / .48;
  return { length: x + .45 * depth, depth };
}

function recordingCanvas(failOn) {
  const calls = [], stack = [];
  let gradient = 0;
  let state = { globalAlpha: .37, lineWidth: 7, lineJoin: "bevel", lineCap: "square", fillStyle: "before-fill",
    strokeStyle: "before-stroke", globalCompositeOperation: "xor", transform: [2, 0, 0, 2, 11, 13] };
  const snapshot = () => ({ ...state, transform: [...state.transform] });
  const original = snapshot();
  const value = item => Array.isArray(item) ? item.map(value)
    : item && typeof item === "object" && "gradient" in item ? { gradient: item.gradient } : item;
  const finite = args => { for (const arg of args.flat(Infinity)) if (typeof arg === "number") assert.ok(Number.isFinite(arg)); };
  function multiply([a, b, c, d, e, f]) {
    const [p, q, r, s, x, y] = state.transform;
    state.transform = [p * a + r * b, q * a + s * b, p * c + r * d, q * c + s * d, p * e + r * f + x, q * e + s * f + y];
  }
  const ctx = new Proxy({}, {
    get(_, key) {
      if (key in state) return state[key];
      if (["canvas", "drawImage", "getImageData", "createPattern"].includes(key)) throw new Error(`Unexpected raster/DOM dependency: ${key}`);
      return (...args) => {
        finite(args); calls.push([key, ...args.map(value)]);
        if (key === failOn) throw new Error("recording failure");
        if (key === "save") stack.push(snapshot());
        else if (key === "restore") { assert.ok(stack.length, "restore without save"); state = stack.pop(); }
        else if (key === "translate") multiply([1, 0, 0, 1, ...args]);
        else if (key === "scale") multiply([args[0], 0, 0, args[1], 0, 0]);
        else if (key === "rotate") multiply([Math.cos(args[0]), Math.sin(args[0]), -Math.sin(args[0]), Math.cos(args[0]), 0, 0]);
        else if (key === "createLinearGradient" || key === "createRadialGradient") {
          const id = ++gradient;
          return { gradient: id, addColorStop(offset, color) { finite([offset]); assert.ok(!/NaN|Infinity/.test(color)); calls.push(["colorStop", id, offset, color]); } };
        }
      };
    },
    set(_, key, next) {
      if (typeof next === "number") finite([next]);
      state[key] = next; calls.push(["set", key, value(next)]); return true;
    },
  });
  return { ctx, calls, snapshot, original, depth: () => stack.length };
}

const frame = overrides => ({ x: 17, y: 29, width: 640, time: 0, night: 0, gate: 0, ramp: 0, cargo: 0, still: true, ...overrides });
function drawing(overrides) {
  const canvas = recordingCanvas(); drawTradeShip(canvas.ctx, frame(overrides));
  assert.equal(canvas.depth(), 0); assert.deepEqual(canvas.snapshot(), canvas.original);
  return canvas.calls;
}

test("gate rotates rigidly around one fixed vertical hinge rather than scaling its physical leaf", () => {
  for (const height of [0, 43]) {
    const hinge = tradeShipGatePoint(0, 0, height), base = unproject(hinge, height);
    for (const opening of [0, .1, .25, .5, .75, 1]) {
      assert.deepEqual(tradeShipGatePoint(opening, 0, height), hinge);
      const end = unproject(tradeShipGatePoint(opening, 75, height), height);
      near(Math.hypot(end.length - base.length, end.depth - base.depth), 75);
    }
  }
  const start = unproject(tradeShipGatePoint(0, 75)), end = unproject(tradeShipGatePoint(1, 75));
  near(start.depth, -73); near(end.length, 20); near(end.depth, 2);
  for (const opening of [-1, NaN, Infinity, -Infinity]) assert.deepEqual(tradeShipGatePoint(opening, 75), tradeShipGatePoint(0, 75));
  assert.deepEqual(tradeShipGatePoint(2, 75), tradeShipGatePoint(1, 75));
});

test("invalid placement is skipped, while optional values are finite and safely clamped", () => {
  for (const invalid of [{ x: NaN }, { y: Infinity }, { width: 0 }, { width: -1 }, { width: NaN }]) {
    const canvas = recordingCanvas(); drawTradeShip(canvas.ctx, frame(invalid)); assert.deepEqual(canvas.calls, []);
  }
  const empty = drawing();
  assert.deepEqual(drawing({ time: NaN, night: Infinity, gate: NaN, ramp: -1, cargo: NaN }), empty);
  assert.deepEqual(drawing({ time: -5, night: -4, cargo: -9 }), empty);
  for (const time of [NaN, Infinity, -9]) assert.deepEqual(drawing({ still: false, time }), drawing({ still: false, time: 0 }));
  assert.deepEqual(drawing({ cargo: 1.9 }), drawing({ cargo: 1 }));
  assert.deepEqual(drawing({ cargo: 99, gate: 99, ramp: 99, night: 99 }), drawing({ cargo: 3, gate: 1, ramp: 1, night: 1 }));
});

test("paused art does not shimmer with time and manual poses still work while paused", () => {
  for (const night of [0, 1]) assert.deepEqual(drawing({ time: 1, night }), drawing({ time: 100, night }));
  const closed = drawing();
  for (const pose of [{ gate: .5 }, { gate: 1, ramp: 1 }, { cargo: 3 }, { night: 1 }]) assert.notDeepEqual(drawing(pose), closed);
  const moving = { still: false, night: 1, time: 2 };
  assert.deepEqual(drawing(moving), drawing(moving));
  assert.notDeepEqual(drawing({ ...moving, time: 3 }), drawing(moving));
});

test("drawing needs no DOM or image source and restores the caller's state even on an early Canvas error", () => {
  const saved = new Map(["window", "document", "Image"].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  try {
    for (const key of saved.keys()) Object.defineProperty(globalThis, key, { configurable: true, get() { throw new Error(`Unexpected ${key}`); } });
    drawing({ still: false, night: 1, gate: 1, ramp: .5, cargo: 3, time: 2 });
  } finally {
    for (const [key, descriptor] of saved) if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key];
  }
  const canvas = recordingCanvas("scale");
  assert.throws(() => drawTradeShip(canvas.ctx, frame()), /recording failure/);
  assert.equal(canvas.depth(), 0); assert.deepEqual(canvas.snapshot(), canvas.original);
});

test("left-facing voyage keeps finite course corrections and water out of default PNG art", () => {
  const left = drawing();
  assert.deepEqual(left, drawing({ facing: "left", heading: 0 }));
  assert.ok(left.some(call => call[0] === "scale" && call[1] === -1));
  assert.ok(!drawing({ facing: "right" }).some(call => call[0] === "scale" && call[1] === -1));
  assert.deepEqual(drawing({ heading: Infinity }), left);
  assert.deepEqual(drawing({ heading: 4 }), drawing({ heading: .3 }));
  assert.deepEqual(drawing({ heading: -4 }), drawing({ heading: -.3 }));
  assert.deepEqual(drawing({ velocityX: 40, velocityY: 20 }), left, "velocity alone cannot leak water into PNG export");
  const afloat = drawing({ water: true });
  assert.notDeepEqual(afloat, left);
  assert.deepEqual(drawing({ water: true, velocityX: NaN, velocityY: Infinity }), afloat);
  assert.notDeepEqual(drawing({ water: true, velocityX: -40, velocityY: -10 }),
    drawing({ water: true, velocityX: 40, velocityY: 10 }), "wash follows the direction of actual movement in reverse");
});
