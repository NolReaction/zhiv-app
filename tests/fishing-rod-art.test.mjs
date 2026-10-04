import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root,
  resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false } });
after(() => vite.close());
const { FISHING_ROD_IDS, fishingRodId, fishingRodAppearance, fishingRodShapes } = await vite.ssrLoadModule("/features/world/fishing-rod-art.ts");
const { FishingRodIcon } = await vite.ssrLoadModule("/features/world/fishing-rod-icon.tsx");
const { drawFishingRod } = await vite.ssrLoadModule("/features/world/fishing-rod-painter.ts");

test("rod identities have different physical sections, grips and reel silhouettes even without color", () => {
  const geometry = new Set(), counts = new Set();
  for (const rodId of FISHING_ROD_IDS) {
    const shapes = fishingRodShapes(rodId);
    geometry.add(JSON.stringify(shapes.map(shape => Object.fromEntries(Object.entries(shape).filter(([key]) => !["fill", "stroke"].includes(key))))));
    counts.add(shapes.length);
    assert.ok(shapes.some(shape => shape.kind === "ellipse"), "every model has its own reel geometry");
    assert.ok(Object.isFrozen(fishingRodAppearance(rodId)));
  }
  assert.equal(geometry.size, 3); assert.equal(counts.size, 3);
  for (const value of [undefined, null, {}, "unknown", "constructor", "__proto__"]) assert.equal(fishingRodId(value), "reed_rod");
  assert.deepEqual(fishingRodShapes("unknown"), fishingRodShapes("reed_rod"));
});

test("all rod models keep the requested tip and finite bounded details through bending and cranking", () => {
  for (const rodId of FISHING_ROD_IDS) for (const length of [.68, 1, 1.35]) for (const side of [-1, 1]) {
    for (const tension of [0, .8, 1.5, NaN, Infinity]) {
      const options = { length, side, tension, crank: NaN, reel: { x: -.025, y: side * .043 } };
      const before = structuredClone(options), shapes = fishingRodShapes(rodId, options);
      const commands = shapes.filter(shape => shape.kind === "path").flatMap(shape => shape.commands);
      assert.ok(commands.some(command => command[0] === "Q" && command[3] === length && command[4] === 0), "the flexible shaft terminates at the same line attachment");
      for (const shape of shapes) {
        const numbers = shape.kind === "ellipse" ? [shape.x, shape.y, shape.rx, shape.ry]
          : shape.commands.flatMap(command => command.slice(1));
        assert.ok(numbers.every(Number.isFinite));
        assert.ok(numbers.every(value => Math.abs(value) < 1.5));
      }
      assert.deepEqual(options, before, "sampling never mutates the tackle rig");
    }
  }
});

test("Canvas uses the palm and line-tip anchors supplied by the character rig and balances its transform", () => {
  const calls = [], context = new Proxy({}, { get: (_target, key) => (...args) => calls.push([key, ...args]), set: () => true });
  for (const rodId of FISHING_ROD_IDS) {
    const frame = { grip: { x: 100, y: 140 }, tip: { x: 130, y: 100 }, reel: { x: 102, y: 143 }, size: 50,
      side: 1, tension: .7, crank: 1.2, rodId }, before = structuredClone(frame);
    calls.length = 0; drawFishingRod(context, frame);
    assert.equal(calls[0][0], "save"); assert.equal(calls.at(-1)[0], "restore");
    assert.deepEqual(calls.find(call => call[0] === "translate"), ["translate", 100, 140]);
    assert.deepEqual(calls.find(call => call[0] === "scale"), ["scale", 50, 50]);
    const angle = calls.find(call => call[0] === "rotate")[1];
    assert.ok(Math.abs(100 + Math.cos(angle) * 50 - frame.tip.x) < 1e-9);
    assert.ok(Math.abs(140 + Math.sin(angle) * 50 - frame.tip.y) < 1e-9);
    assert.ok(calls.flat().filter(value => typeof value === "number").every(Number.isFinite));
    assert.deepEqual(frame, before);
  }
  for (const size of [0, -1, Infinity, NaN]) {
    calls.length = 0; drawFishingRod(context, { grip: { x: 0, y: 0 }, tip: { x: 20, y: 20 }, reel: { x: 1, y: 1 }, size, side: 1, tension: 0, crank: 0 });
    assert.equal(calls.length, 0);
  }
});

test("compact and large SVG previews use each actual model without external assets or shared IDs", () => {
  for (const size of [24, 44, 64, 160]) for (const rodId of FISHING_ROD_IDS) {
    const html = renderToStaticMarkup(createElement(FishingRodIcon, { rodId, size }));
    assert.match(html, new RegExp(`width="${size}" height="${size}"`));
    assert.match(html, new RegExp(`data-fishing-rod="${rodId}"`));
    assert.match(html, /aria-hidden="true"/);
    assert.equal((html.match(/<(?:path|ellipse)\b/g) ?? []).length, fishingRodShapes(rodId).length);
    assert.doesNotMatch(html, /\bid="|<image|<use|<foreignObject|url\(|(?:href|src)=/);
  }
  const named = renderToStaticMarkup(createElement(FishingRodIcon, { rodId: "willow_rod", label: "Ивовая удочка" }));
  assert.match(named, /role="img" aria-label="Ивовая удочка"/); assert.doesNotMatch(named, /aria-hidden/);
});
