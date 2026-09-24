import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root,
  resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false } });
after(() => vite.close());
const { drawLivingWorldDebug } = await vite.ssrLoadModule("/features/world/living-world-debug.ts");
const rect = (x, y, width, height) => [{ x, y }, { x: x + width, y }, { x: x + width, y: y + height }, { x, y: y + height }];
const scene = {
  focus: { x: 0, y: 0, width: 120, height: 100 }, actor: { spawn: { x: 40, y: 55 }, size: 25 },
  navigation: { version: 1, cellSize: 10, areas: [{ id: "clearing", points: rect(5, 5, 100, 80) }],
    obstacles: [{ id: "rock", points: rect(65, 40, 5, 6) }], interests: [] },
  sites: [{ id: "home", collision: rect(5, 15, 20, 20) }],
  water: { surfaces: [{ id: "water", points: rect(100, 10, 10, 80) }], exclusions: [] },
  habitats: [{ id: "meadow", species: "butterfly", points: rect(20, 15, 65, 40), capacity: 2,
    anchors: [{ id: "leaf", kind: "rest", position: { x: 35, y: 25 } }] }],
};
const snapshot = {
  nav: { radius: 4, cellSize: 10, bounds: { x: 5, y: 5, width: 100, height: 80 },
    grid: { columns: 2, rows: 2, origin: { x: 5, y: 5 }, walkable: new Uint8Array([1, 0, 1, 1]) } },
  position: { x: 40, y: 55 }, path: [{ x: 40, y: 55 }, { x: 55, y: 65 }], target: { x: 55, y: 65 },
  activity: "sniff", reason: "reachable-interest",
  fauna: [{ id: "butterfly-1", species: "butterfly", mode: "approach", x: 43, y: 30,
    target: { x: 44, y: 42 }, habitatId: "meadow" }],
  encounter: { entityId: "butterfly-1", phase: "approach" },
};

function drawing(scale = 1) {
  const calls = [];
  const ctx = new Proxy({ getTransform: () => ({ a: scale, b: 0 }) }, {
    get: (target, name) => name in target ? target[name] : (...args) => calls.push([name, ...args]),
    set: (target, name, value) => { target[name] = value; calls.push([name, value]); return true; },
  });
  return { ctx, calls };
}

function inEnvironment(mode, run) {
  const before = process.env.NODE_ENV;
  try { process.env.NODE_ENV = mode; run(); }
  finally { if (before === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = before; }
}

test("diagnostics are disabled outside development and with both switches off", () => {
  for (const mode of ["production", "test", "preview"]) inEnvironment(mode, () => {
    const { ctx, calls } = drawing();
    drawLivingWorldDebug(ctx, scene, { ...snapshot, debugNavigation: true, debugFauna: true });
    assert.deepEqual(calls, []);
  });
  inEnvironment("development", () => {
    const { ctx, calls } = drawing();
    drawLivingWorldDebug(ctx, scene, snapshot);
    assert.deepEqual(calls, []);
  });
});

test("navigation draws authored boundaries, safe cells, radius, route and decision without changing inputs", () => {
  inEnvironment("development", () => {
    const originalScene = structuredClone(scene), originalSnapshot = structuredClone(snapshot);
    const { ctx, calls } = drawing(2);
    drawLivingWorldDebug(ctx, scene, { ...snapshot, debugNavigation: true });
    const labels = calls.filter(([name]) => name === "fillText").map(([, text]) => text);
    assert.deepEqual(labels, ["занятие: sniff", "reachable-interest", "цель"]);
    assert.equal(calls.filter(([name]) => name === "fillRect").length, 3);
    assert.ok(calls.some(call => call[0] === "arc" && call[1] === 40 && call[2] === 55 && call[3] === 4));
    assert.ok(calls.some(call => call[0] === "strokeStyle" && call[1] === "#78edb0"));
    assert.ok(calls.some(call => call[0] === "strokeStyle" && call[1] === "#ff8e86"));
    assert.ok(calls.some(call => call[0] === "strokeStyle" && call[1] === "#72cfff"));
    assert.equal(calls.some(([name]) => ["clip", "drawImage", "getImageData", "putImageData"].includes(name)), false);
    assert.equal(calls.at(-1)[0], "restore");
    assert.deepEqual(scene, originalScene);
    assert.deepEqual(snapshot, originalSnapshot);
  });
});

test("fauna diagnostics use the same IDs and targets independently of navigation", () => {
  inEnvironment("development", () => {
    const { ctx, calls } = drawing();
    drawLivingWorldDebug(ctx, scene, { ...snapshot, debugFauna: true });
    const labels = calls.filter(([name]) => name === "fillText").map(([, text]) => text);
    assert.deepEqual(labels, ["meadow · butterfly", "butterfly-1 · approach", "встреча: approach"]);
    assert.ok(calls.some(call => call[0] === "lineTo" && call[1] === 44 && call[2] === 42));
    assert.equal(calls.some(([name]) => name === "arc" || name === "fillRect"), false);
    assert.equal(calls.filter(([name]) => name === "save").length, 1);
    assert.equal(calls.at(-1)[0], "restore");
  });
});

test("large grids and populations cannot produce unbounded debug draw work", () => {
  inEnvironment("development", () => {
    const { ctx, calls } = drawing();
    const nav = { ...snapshot.nav, grid: { ...snapshot.nav.grid, rows: 1000, columns: 1000,
      walkable: new Uint8Array(1000000).fill(1) } };
    const fauna = Array.from({ length: 1000 }, (_, index) => ({ ...snapshot.fauna[0], id: `butterfly-${index}` }));
    drawLivingWorldDebug(ctx, { ...scene, habitats: [] }, { ...snapshot, debugNavigation: true, debugFauna: true, nav, fauna });
    assert.ok(calls.filter(([name]) => name === "fillRect").length <= 1024);
    assert.equal(calls.filter(([name, text]) => name === "fillText" && text.startsWith("butterfly-")).length, 32);
  });
});
