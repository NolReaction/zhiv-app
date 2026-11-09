import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ root, configFile: false, appType: "custom", resolve: { alias: { "@": root } },
  server: { middlewareMode: true, hmr: false, ws: false }, optimizeDeps: { noDiscovery: true, include: [] } });
after(() => vite.close());
const { fishingHullContactPoint, fishingHullWaterFrame, fishingBoatWaterSample, FISHING_BOAT_DRAFT, paintFishingBoatDisplacement, paintFishingHullImmersion } =
  await vite.ssrLoadModule("/features/economy/ui/boat/scene/fishing-scene-hull-water.ts");
const { fishingBoatMotion, fishingWaterWave } = await vite.ssrLoadModule("/features/economy/ui/boat/scene/fishing-scene-buoyancy.ts");
const points = frame => [...frame.contact, ...frame.ripples.flatMap(stroke => stroke.points), ...frame.reflections.flatMap(stroke => stroke.points)];

test("the wet seam follows the new side hull's real keel and stops below the raised dry bow", () => {
  const stern = fishingHullContactPoint(0, 0), middle = fishingHullContactPoint(.5, 0), bow = fishingHullContactPoint(1, 0);
  assert.ok(stern.x > 150 && stern.x < 160);
  assert.equal(middle.y, 535, "the actual protruding keel is on the authored waterline");
  assert.ok(bow.x > 825 && bow.x < 840 && bow.y > 520 && bow.y < 530,
    "foam stops near the keel curve and does not climb to the high bow tip");
  for (let position = .001; position <= 1; position += .001) {
    const before = fishingHullContactPoint(position - .001, 1), after = fishingHullContactPoint(position, 1);
    assert.ok(Math.hypot(after.x - before.x, after.y - before.y) < .8, `continuous hull joint at ${position}`);
    assert.deepEqual(after, fishingHullContactPoint(position, 500), "the seam cannot add a second swell on top of the moving hull");
  }
});

test("the contact stays on the sampled world water while the hull settles through it", () => {
  const surface = 350, scale = .67;
  const base = { x: 120, y: surface - (535 - FISHING_BOAT_DRAFT) * scale, scale, roll: 0 };
  const settled = fishingBoatWaterSample(base, 500, 0, true, surface);
  const raised = fishingBoatWaterSample({ ...base, y: base.y - 5 }, 500, 0, true, surface);
  assert.equal(settled.depth, FISHING_BOAT_DRAFT);
  assert.ok(Math.abs(settled.point.y - surface) < 1e-9);
  assert.ok(Math.abs(raised.point.y - surface) < 1e-9, "water cannot be dragged upwards with the boat");
  assert.ok(raised.depth < settled.depth, "a raised hull displaces less water");
  for (const time of [0, .1, 2.2, 18.7, 1000]) {
    const motion = fishingBoatMotion(time, false), boat = { ...base, y: base.y + motion.bob, roll: motion.roll };
    const frame = fishingHullWaterFrame(boat, time, false, surface);
    assert.ok(frame.contact.length > 25 && frame.contact.length < frame.samples.length, "raised dry bow never gets a water outline");
    for (const point of frame.contact) assert.ok(Math.abs(point.y - surface - fishingWaterWave(point.x, time).height) < 1e-4);
    assert.ok(frame.samples.filter(sample => sample.depth < 0).every(sample => sample.local.x > 760), "dry samples are at the raised bow");
  }
});

test("paused and reduced-motion hull water stays frozen while active wavelets advance without popping", () => {
  const boat = { x: 100, y: 20, scale: .7, roll: .008 };
  assert.deepEqual(fishingHullWaterFrame(boat, 0, true), fishingHullWaterFrame(boat, 500, true));
  assert.deepEqual(fishingHullWaterFrame(boat, NaN), fishingHullWaterFrame(boat, 0));
  assert.notDeepEqual(fishingHullWaterFrame(boat, 0), fishingHullWaterFrame(boat, .5));
  const first = fishingHullWaterFrame(boat, 0).ripples[0];
  assert.equal(first.opacity, 0);
  assert.ok(fishingHullWaterFrame(boat, .5 / .22).ripples[0].opacity > .08);
  assert.ok(fishingHullWaterFrame(boat, (1 - 1e-6) / .22).ripples[0].opacity < .001);
  const resting = fishingHullWaterFrame(boat, .5 / .22, false, undefined, 0).ripples[0];
  const disturbed = fishingHullWaterFrame(boat, .5 / .22, false, undefined, 1).ripples[0];
  assert.ok(disturbed.opacity > resting.opacity && disturbed.opacity < .2, "line effort increases pressure ripples without continuous speedboat foam");
  for (const time of [0, .5, 10, 500]) {
    const frame = fishingHullWaterFrame(boat, time);
    assert.ok(points(frame).every(point => Number.isFinite(point.x + point.y)));
    assert.ok([...frame.ripples, ...frame.reflections].every(stroke => stroke.opacity >= 0 && stroke.opacity <= .3));
  }
});

test("hull water draws only bounded open strokes and rejects invalid transforms", () => {
  const calls = [], ctx = new Proxy({}, { get(target, key) {
    if (key in target) return target[key];
    return (...args) => calls.push({ key, args });
  } });
  paintFishingBoatDisplacement(ctx, { x: 30, y: 40, scale: .7, roll: .01 }, 2);
  assert.equal(calls.filter(call => call.key === "stroke").length, 19);
  assert.equal(calls.some(call => ["fill", "fillRect", "ellipse", "drawImage", "createElement"].includes(call.key)), false);
  assert.ok(calls.length < 200);
  calls.length = 0;
  for (const scale of [0, -1, NaN, Infinity]) paintFishingBoatDisplacement(ctx, { x: 0, y: 0, scale }, 2);
  assert.equal(calls.length, 0);
});


test("immersion tints only the narrow authored hull lip, leaving the motor and open water unfilled", () => {
  const record = time => {
    const calls = [], stops = [], ctx = new Proxy({}, { get(target, key) {
      if (key in target) return target[key];
      if (key === "createLinearGradient") return (...args) => { calls.push({ key, args }); return { addColorStop: (...values) => stops.push(values) }; };
      return (...args) => calls.push({ key, args });
    }, set(target, key, value) { target[key] = value; if (key === "strokeStyle") calls.push({ key, args: [value] }); return true; } });
    paintFishingHullImmersion(ctx, time, true);
    return { calls, stops };
  };
  const result = record(0), fill = result.calls.findIndex(call => call.key === "fill");
  assert.equal(result.calls.filter(call => call.key === "fill").length, 1);
  assert.equal(result.calls.filter(call => call.key === "stroke").length, 3);
  assert.equal(result.calls.some(call => ["rect", "fillRect", "ellipse", "drawImage", "translate", "rotate"].includes(call.key)), false);
  const lip = result.calls.slice(0, fill).filter(call => call.key === "moveTo" || call.key === "lineTo");
  assert.ok(lip.length >= 60);
  for (const { args: [x, y] } of lip) {
    assert.ok(x > 175 && x < 831, "the painted lip cannot reach the motor at the stern");
    assert.ok(y >= 510 && y <= 535, "the fill stays within fourteen assembly pixels of the keel");
  }
  assert.equal(result.stops[0][1], "rgba(22,117,119,0)", "the wetting fades into the dry planks");
  assert.deepEqual(result, record(500), "reduced motion freezes the small contact glints too");
});

test("decoded hull water masks are cached across frames and a loadout change cannot reuse stale modules", async () => {
  const { fishingBoatWaterArtwork } = await vite.ssrLoadModule("/features/economy/ui/boat/scene/fishing-scene-water-artwork.ts");
  const previous = Object.getOwnPropertyDescriptor(globalThis, "document");
  const made = [], gradient = { addColorStop() {} };
  Object.defineProperty(globalThis, "document", { configurable: true, value: { createElement() {
    const canvas = { width: 0, height: 0, getContext: () => ({ drawImage() {}, fillRect() {}, createLinearGradient: () => gradient }) };
    made.push(canvas); return canvas;
  } } });
  try {
    const hull = { complete: true, naturalWidth: 1600 }, engine = { complete: true, naturalWidth: 260 };
    const layers = [{ src: "hull", crop: [0, 0, 1600, 640], box: [0, 185, 1000, 400] },
      { src: "engine", crop: [0, 0, 260, 570], box: [0, 219.375, 162.5, 356.25] }];
    const images = new Map([["hull", hull], ["engine", engine]]);
    const first = fishingBoatWaterArtwork(layers, images);
    assert.ok(first && first.plain !== first.submerged, "the original and submerged-alpha masks remain separate");
    for (let frame = 0; frame < 300; frame++) assert.equal(fishingBoatWaterArtwork(layers, images), first);
    assert.equal(made.length, 2, "ordinary render frames allocate no new canvas or pixel buffer");
    images.set("engine", { complete: false, naturalWidth: 0 });
    assert.equal(fishingBoatWaterArtwork(layers, images), null, "an unfinished replacement cannot reuse another motor");
    images.set("engine", { complete: true, naturalWidth: 260 });
    assert.notEqual(fishingBoatWaterArtwork(layers, images), first);
    assert.equal(made.length, 4);
  } finally {
    if (previous) Object.defineProperty(globalThis, "document", previous); else delete globalThis.document;
  }
});

test("fragmented reflections use one clipped bitmap draw per frame", async () => {
  const { paintFishingBoatReflection } = await vite.ssrLoadModule("/features/economy/ui/boat/scene/fishing-scene-water-artwork.ts");
  const calls = [], plain = { width: 1000, height: 650 };
  const ctx = new Proxy({ globalAlpha: 1 }, { get(target, key) {
    if (key in target) return target[key];
    return (...args) => calls.push({ key, args });
  } });
  const boat = { x: 100, y: -100, scale: .8, roll: .01 };
  paintFishingBoatReflection(ctx, boat, { plain }, 2, false, -100 + (535 - FISHING_BOAT_DRAFT) * .8);
  assert.equal(calls.filter(call => call.key === "drawImage").length, 1, "strip count must not multiply full bitmap draws");
  assert.equal(calls.filter(call => call.key === "clip").length, 1);
  assert.ok(calls.filter(call => call.key === "closePath").length > 2, "the single draw still has broken reflection strips");
  assert.equal(calls.some(call => call.key === "createElement" || call.key === "getImageData"), false);
  assert.ok(ctx.globalAlpha > 0 && ctx.globalAlpha <= .1);
});
