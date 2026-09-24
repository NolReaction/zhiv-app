import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root,
  resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false } });
after(() => vite.close());
const { drawWaterDebug } = await vite.ssrLoadModule("/features/world/dev/water-debug.ts");
const water = {
  surfaces: [{ id: "river", points: [{ x: 10, y: 20 }, { x: 90, y: 20 }, { x: 70, y: 100 }, { x: 10, y: 80 }] }],
  exclusions: [{ id: "leaf", points: [{ x: 25, y: 40 }, { x: 32, y: 42 }, { x: 27, y: 47 }] }],
};

function drawing(scale = 1) {
  const calls = [];
  const ctx = new Proxy({ getTransform: () => ({ a: scale, b: 0 }) }, {
    get: (target, name) => name in target ? target[name] : (...args) => calls.push([name, ...args]),
    set: (target, name, value) => { target[name] = value; calls.push([name, value]); return true; },
  });
  return { ctx, calls };
}

test("water debug traces the authored shore and exclusions without filling or changing masks", () => {
  const { ctx, calls } = drawing(2);
  drawWaterDebug(ctx, { water });
  assert.deepEqual(calls.filter(([name]) => name === "moveTo"), [["moveTo", 10, 20], ["moveTo", 25, 40]]);
  assert.equal(calls.filter(([name]) => name === "lineTo").length, 5);
  assert.equal(calls.filter(([name]) => name === "closePath").length, 2);
  assert.ok(calls.some(call => call[0] === "strokeStyle" && call[1] === "#58e5ff"));
  assert.ok(calls.some(call => call[0] === "strokeStyle" && call[1] === "#ff997e"));
  assert.deepEqual(calls.filter(([name]) => name === "setLineDash"), [["setLineDash", []], ["setLineDash", [2.5, 1.5]]]);
  assert.deepEqual(calls.filter(([name]) => name === "lineWidth").map(call => call[1]), [1.75, .75, 1.75, .75]);
  assert.equal(calls.filter(([name]) => name === "stroke").length, 4, "a dark outline keeps each colored boundary readable");
  assert.equal(calls.some(([name]) => ["fill", "clip", "drawImage", "getImageData"].includes(name)), false);
  assert.equal(calls.filter(([name]) => name === "save").length, 1);
  assert.equal(calls.at(-1)[0], "restore");
});

test("Path2D geometry is built once for each authored water object and reused between frames", () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "Path2D");
  const created = [];
  class MockPath {
    calls = [];
    constructor() { created.push(this); }
    moveTo(...args) { this.calls.push(["moveTo", ...args]); }
    lineTo(...args) { this.calls.push(["lineTo", ...args]); }
    closePath() { this.calls.push(["closePath"]); }
  }
  Object.defineProperty(globalThis, "Path2D", { value: MockPath, configurable: true });
  try {
    const authored = structuredClone(water);
    const first = drawing(), second = drawing();
    drawWaterDebug(first.ctx, { water: authored });
    const initialGeometry = created.map(path => structuredClone(path.calls));
    drawWaterDebug(second.ctx, { water: authored });
    assert.equal(created.length, 2);
    assert.deepEqual(created.map(path => path.calls), initialGeometry);
    assert.deepEqual(first.calls.filter(([name]) => name === "stroke"), second.calls.filter(([name]) => name === "stroke"));
    assert.equal(second.calls.some(([name]) => name === "lineTo" || name === "moveTo"), false);
    drawWaterDebug(drawing().ctx, { water: structuredClone(authored) });
    assert.equal(created.length, 4, "a newly loaded scene builds new paths");
  } finally {
    if (previous) Object.defineProperty(globalThis, "Path2D", previous);
    else delete globalThis.Path2D;
  }
});

test("scenes without water leave the canvas alone", () => {
  for (const scene of [{}, { water: { surfaces: [], exclusions: [] } }]) {
    const { ctx, calls } = drawing();
    drawWaterDebug(ctx, scene);
    assert.deepEqual(calls, []);
  }
});
