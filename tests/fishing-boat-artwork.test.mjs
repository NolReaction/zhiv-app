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
  assert.deepEqual(requests, boatArtworkLayers({ repaired: false }).map(layer => layer.src), "the same pending parts are loaded once");
  art.update({ repaired: true, upgrades: ["crate"] });
  finish.get(BOAT_BROKEN_HULL.src)(valid(BOAT_BROKEN_HULL.src)); await flush();
  assert.equal(redraws, 0, "a replaced hull cannot invalidate the current scene");
  for (const layer of boatArtworkLayers({ repaired: true })) { finish.get(layer.src)(valid(layer.src)); await flush(); }
  assert.equal(redraws, 4);
  art.update({ repaired: true, upgrades: ["crate"] });
  assert.equal(requests.length, 5, "loaded parts are reused between frames");
  assert.ok(art.getImages().has(BOAT_ART_PARTS.engine.src));
  assert.ok(requests.every(src => !src.includes("crate")), "capacity never requests crate artwork");
  art.update(null); art.retry(); assert.equal(requests.length, 5);
  art.dispose();
});

test("failed parts are throttled, explicit network retries work, and disposal ignores pending completions", async () => {
  let now = 100, failures = 0, redraws = 0; const requests = [], complete = new Map();
  const art = createFishingBoatArtwork(src => {
    requests.push(src);
    if (requests.filter(value => value === src).length === 1) return Promise.reject(new Error("offline"));
    return new Promise(resolve => { complete.set(src, resolve); });
  }, () => redraws++, () => failures++, () => now);
  art.update({ repaired: true }); await flush();
  assert.equal(failures, 4);
  for (let frame = 0; frame < 100; frame++) { now++; art.update({ repaired: true }); }
  assert.equal(requests.length, 4, "render frequency cannot create a request storm");
  art.retry(); assert.equal(requests.length, 8, "an online/focus event can retry without waiting");
  art.dispose(); for (const [src, finish] of complete) finish(valid(src)); await flush();
  assert.equal(redraws, 0); assert.equal(art.getImages().size, 0);
  art.update({ repaired: true }); art.retry(); assert.equal(requests.length, 8);
});

test("invalid decoded images are rejected and an inactive camera does not load a boat", async () => {
  let requests = 0, failures = 0, redraws = 0;
  const art = createFishingBoatArtwork(async () => { requests++; return { naturalWidth: 0, naturalHeight: 0 }; },
    () => redraws++, () => failures++);
  art.update(null); assert.equal(requests, 0);
  art.update({ repaired: false }); await flush();
  assert.equal(failures, 4); assert.equal(redraws, 0); assert.equal(art.getImages().size, 0);
  art.dispose();
});

test("map boat draws the real installed modules and front hull without a procedural replacement", () => {
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
  assert.equal(draws.length, layers.length + 1, "visible parts plus the real front planks used as an occluder");
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


test("capacity is non-visual for owned loadouts and fitting previews; all base parts use the same SVG transform", () => {
  const baseline = boatArtworkLayers({ repaired: true });
  for (const loadout of [{ repaired: true, upgrades: ["crate"] }, { repaired: true, previewModule: "crate" },
    { repaired: true, upgrades: ["crate"], previewModule: "crate" }]) assert.deepEqual(boatArtworkLayers(loadout), baseline);
  assert.deepEqual(baseline.map(layer => layer.id), ["repair", "fuel_hose", "engine", "tank"]);
  assert.deepEqual(baseline[0].box, [0, 185, 1000, 400]);
  assert.deepEqual(BOAT_ART_PARTS.engine.box, [0, 219.375, 162.5, 356.25]);
  assert.deepEqual(BOAT_ART_PARTS.tank.box, [218.75, 222.5, 187.5, 143.75]);
  for (const layer of baseline) assert.match(layer.src, /\/modular\/.*\.svg$/);
});
