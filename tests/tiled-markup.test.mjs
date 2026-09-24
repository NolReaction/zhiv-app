import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root,
  resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false } });
after(() => vite.close());
const { paintFixedWorld } = await vite.ssrLoadModule("/features/world/tiled/renderer.ts");
const scene = {
  schemaVersion: 1, id: "markup", width: 100, height: 100,
  terrain: [], sites: [], paths: [], lights: [], focus: { x: 0, y: 0, width: 100, height: 100 },
  mushrooms: [{ id: "mushroom-a", position: { x: 20, y: 30 } }],
  bushes: [{ id: "bush-a", points: [{ x: 40, y: 20 }, { x: 70, y: 20 }, { x: 70, y: 55 }],
    entry: { x: 70, y: 60 }, hide: { x: 60, y: 40 } }],
  water: { surfaces: [{ id: "river", points: [{ x: 0, y: 80 }, { x: 100, y: 80 }, { x: 100, y: 100 }] }], exclusions: [] },
};

function paint(debug) {
  const calls = [];
  const ctx = new Proxy({}, {
    get: (target, name) => name in target ? target[name] : (...args) => calls.push([name, ...args]),
    set: (target, name, value) => { target[name] = value; return true; },
  });
  paintFixedWorld(ctx, scene, { images: new Map(), visuals: {}, actor: null,
    options: { levels: {}, debug, night: false, selectedSiteId: null, reducedMotion: true } });
  return calls;
}

test("general DEV markup identifies mushroom placements and bush contour, entrance and hiding point", () => {
  const calls = paint(true);
  assert.deepEqual(calls.filter(([name]) => name === "fillText").map(call => call[1]), ["mushroom-a", "bush-a", "вход", "укрытие"]);
  assert.deepEqual(calls.filter(([name]) => name === "arc").map(call => call.slice(1, 3)), [[20, 30], [70, 60], [60, 40]]);
  assert.ok(calls.some(call => call[0] === "moveTo" && call[1] === 40 && call[2] === 20), "bush contour is visible");
  assert.ok(calls.some(call => call[0] === "lineTo" && call[1] === 60 && call[2] === 40), "entrance connects to the hiding position");
  assert.equal(calls.some(call => call[0] === "moveTo" && call[1] === 0 && call[2] === 80), false, "water remains controlled independently");
});

test("normal rendering does not expose mushroom and bush markup", () => {
  const calls = paint(false);
  assert.equal(calls.some(([name]) => ["fillText", "strokeText", "arc", "moveTo", "lineTo"].includes(name)), false);
});
