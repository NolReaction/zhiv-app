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
const { FISH_SPECIES_IDS, FISH_SPECIES, fishShapes, fishSpeciesId } = await vite.ssrLoadModule("/features/world/activities/fishing/fish-species.ts");
const { drawFishSprite } = await vite.ssrLoadModule("/features/world/activities/fishing/fish-sprite.ts");
const { FishIcon } = await vite.ssrLoadModule("/features/world/activities/fishing/fish-icon.tsx");
const { economyCatalog } = await vite.ssrLoadModule("/features/economy/domain/model.ts");

test("every catalog species has a distinct silhouette and bounded full-tail geometry for water clearance", () => {
  assert.deepEqual([...FISH_SPECIES_IDS].sort(), economyCatalog.fishing.fish.map(fish => fish.itemId).sort());
  const bodies = new Set();
  for (const species of FISH_SPECIES_IDS) {
    bodies.add(JSON.stringify(FISH_SPECIES[species].radius));
    for (const tail of [-Infinity, -1, 0, 1, Infinity, NaN]) for (const shape of fishShapes(species, tail)) {
      const points = shape.kind === "ellipse"
        ? [[shape.x - shape.rx, shape.y - shape.ry], [shape.x + shape.rx, shape.y + shape.ry]] : shape.points;
      for (const [x, y] of points) {
        assert.ok(Number.isFinite(x) && Number.isFinite(y));
        assert.ok(Math.hypot(x, y) + (shape.width ?? 0) / 2 < .87, "water agents can use the documented .87 × size clearance");
      }
    }
  }
  assert.equal(bodies.size, FISH_SPECIES_IDS.length);
  for (const invalid of [undefined, null, {}, "constructor", "__proto__", "unknown_fish"]) assert.equal(fishSpeciesId(invalid), "fish");
});

test("Canvas fish preserve caller state and reject invalid positions before issuing geometry", () => {
  const calls = [];
  const context = new Proxy({}, { get: (_target, key) => (...args) => calls.push([key, ...args]), set: () => true });
  for (const species of FISH_SPECIES_IDS) {
    calls.length = 0;
    drawFishSprite(context, { x: 50, y: 40, size: 8, species, angle: NaN, tailSwing: NaN, underwater: true });
    assert.equal(calls[0][0], "save"); assert.equal(calls.at(-1)[0], "restore");
    assert.ok(calls.some(call => call[0] === "ellipse"));
    assert.ok(calls.flat().filter(value => typeof value === "number").every(Number.isFinite));
  }
  for (const frame of [{ x: NaN, y: 0, size: 8 }, { x: 0, y: Infinity, size: 8 }, { x: 0, y: 0, size: -1 }]) {
    calls.length = 0; drawFishSprite(context, frame); assert.equal(calls.length, 0);
  }
});

test("fish icons need no asset requests or shared SVG IDs and expose optional accessible labels", () => {
  const drawings = new Set();
  for (const species of FISH_SPECIES_IDS) {
    const html = renderToStaticMarkup(createElement(FishIcon, { species, size: 32 }));
    assert.match(html, /width="32" height="32"/); assert.match(html, /aria-hidden="true"/);
    assert.doesNotMatch(html, /\bid="|<image|<use|<foreignObject|url\(|(?:href|src)=/);
    assert.ok(html.includes(FISH_SPECIES[species].colors.body)); drawings.add(html);
  }
  assert.equal(drawings.size, FISH_SPECIES_IDS.length);
  const named = renderToStaticMarkup(createElement(FishIcon, { species: "fish_silverfin", label: "Серебринка" }));
  assert.match(named, /role="img" aria-label="Серебринка"/); assert.doesNotMatch(named, /aria-hidden/);
});
