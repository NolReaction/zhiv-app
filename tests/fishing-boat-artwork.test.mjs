import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "vite";

const root = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const vite = await createServer({ configFile: false, root, resolve: { alias: { "@": root } },
  server: { middlewareMode: true, hmr: false, ws: false }, optimizeDeps: { noDiscovery: true, include: [] } });
const { createFishingBoatArtwork } = await vite.ssrLoadModule("/features/world/objects/fishing-boat/fishing-boat-artwork-loader.ts");
const { BOAT_ART_PARTS, BOAT_BROKEN_HULL, boatArtworkLayers } = await vite.ssrLoadModule("/features/world/objects/fishing-boat/fishing-boat-artwork.ts");
const { drawFishingBoat } = await vite.ssrLoadModule("/features/world/objects/fishing-boat/fishing-boat-painter.ts");
await vite.close();
const flush = () => new Promise(resolve => setImmediate(resolve));
const valid = src => ({ src, naturalWidth: 1536, naturalHeight: 1024 });

test("boat artwork follows the installed loadout and invalidates a still scene only when visible parts arrive", async () => {
  const requests = [], finish = new Map(); let redraws = 0;
  const art = createFishingBoatArtwork(src => {
    requests.push(src); return new Promise(resolve => finish.set(src, resolve));
  }, () => redraws++);
  art.update({ repaired: false }); art.update({ repaired: false });
  assert.deepEqual(requests, [BOAT_BROKEN_HULL.src], "the same pending part is loaded once");
  art.update({ repaired: true, upgrades: ["crate"] });
  finish.get(BOAT_BROKEN_HULL.src)(valid(BOAT_BROKEN_HULL.src)); await flush();
  assert.equal(redraws, 0, "a replaced hull cannot invalidate the current scene");
  for (const src of [BOAT_ART_PARTS.repair.src, BOAT_ART_PARTS.crate.src]) { finish.get(src)(valid(src)); await flush(); }
  assert.equal(redraws, 2);
  art.update({ repaired: true, upgrades: ["crate"] });
  assert.equal(requests.length, 3, "loaded parts are reused between frames");
  assert.ok(art.getImages().has(BOAT_ART_PARTS.crate.src));
  art.update(null); art.retry(); assert.equal(requests.length, 3);
  art.dispose();
});

test("failed parts are throttled, explicit network retries work, and disposal ignores pending completions", async () => {
  let now = 100, requests = 0, failures = 0, redraws = 0, complete;
  const art = createFishingBoatArtwork(() => {
    requests++;
    if (requests === 1) return Promise.reject(new Error("offline"));
    return new Promise(resolve => { complete = resolve; });
  }, () => redraws++, () => failures++, () => now);
  art.update({ repaired: true }); await flush();
  assert.equal(failures, 1);
  for (let frame = 0; frame < 100; frame++) { now++; art.update({ repaired: true }); }
  assert.equal(requests, 1, "render frequency cannot create a request storm");
  art.retry(); assert.equal(requests, 2, "an online/focus event can retry without waiting");
  art.dispose(); complete(valid(BOAT_ART_PARTS.repair.src)); await flush();
  assert.equal(redraws, 0); assert.equal(art.getImages().size, 0);
  art.update({ repaired: true }); art.retry(); assert.equal(requests, 2);
});

test("invalid decoded images are rejected and an inactive camera does not load a boat", async () => {
  let requests = 0, failures = 0, redraws = 0;
  const art = createFishingBoatArtwork(async () => { requests++; return { naturalWidth: 0, naturalHeight: 0 }; },
    () => redraws++, () => failures++);
  art.update(null); assert.equal(requests, 0);
  art.update({ repaired: false }); await flush();
  assert.equal(failures, 1); assert.equal(redraws, 0); assert.equal(art.getImages().size, 0);
  art.dispose();
});

test("map boat draws the real installed raster modules and front hull without a procedural replacement", () => {
  const calls = [];
  const ctx = new Proxy({ globalAlpha: 1 }, { get(target, key) {
    if (key in target) return target[key];
    return (...args) => calls.push({ method: key, args });
  } });
  const loadout = { repaired: true, upgrades: ["crate", "oars"], artifacts: ["landing_net", "telescope"] };
  const layers = boatArtworkLayers(loadout);
  const art = new Map(layers.map(layer => [layer.src, valid(layer.src)]));
  const frame = { x: 100, y: 200, heading: 0, opacity: 1, passenger: false, moving: false,
    age: 1, width: 44, level: 1, ...loadout, gangway: { from: { x: 100, y: 180 }, to: { x: 100, y: 200 } } };
  drawFishingBoat(ctx, frame, undefined, 32, true, art);
  const draws = calls.filter(call => call.method === "drawImage");
  assert.equal(draws.length, 6, "five parts plus the real front planks used as an occluder");
  for (const layer of layers) {
    const draw = draws.find(call => call.args[0] === art.get(layer.src));
    assert.deepEqual(draw.args.slice(1), [...layer.crop, ...layer.box]);
  }
  assert.equal(draws.at(-1).args[0], art.get(BOAT_ART_PARTS.oars.src));
  assert.equal(calls.filter(call => call.method === "moveTo" || call.method === "lineTo").length, 0,
    "no code-drawn hull or equipment remains");
  calls.length = 0; drawFishingBoat(ctx, { ...frame, level: 0, upgrades: [], artifacts: [] }, undefined, 32, true,
    new Map([[BOAT_BROKEN_HULL.src, valid(BOAT_BROKEN_HULL.src)]]));
  assert.ok(calls.filter(call => call.method === "drawImage").every(call => call.args[0].src === BOAT_BROKEN_HULL.src));
});
