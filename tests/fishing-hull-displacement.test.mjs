import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ root, configFile: false, appType: "custom", resolve: { alias: { "@": root } },
  server: { middlewareMode: true, hmr: false, ws: false }, optimizeDeps: { noDiscovery: true, include: [] } });
after(() => vite.close());
const { fishingHullContactPoint, fishingHullWaterFrame, paintFishingBoatDisplacement, paintFishingHullImmersion } =
  await vite.ssrLoadModule("/features/economy/ui/boat/scene/fishing-scene-hull-water.ts");
const { fishingBoatMotion, transformFishingBoatPoint } = await vite.ssrLoadModule("/features/economy/ui/boat/scene/fishing-scene-buoyancy.ts");
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

test("displacement and reflections inherit the whole hull transform instead of sliding beneath a rolling boat", () => {
  const untransformed = { x: 0, y: 0, scale: 1, roll: 0 };
  for (const time of [0, .1, 2.2, 18.7, 1000]) {
    const motion = fishingBoatMotion(time, false), boat = { x: 120, y: 50 + motion.bob, scale: .67, roll: motion.roll };
    const local = points(fishingHullWaterFrame(untransformed, time)), actual = points(fishingHullWaterFrame(boat, time));
    assert.equal(actual.length, local.length);
    for (let index = 0; index < actual.length; index++) {
      const expected = transformFishingBoatPoint(local[index], boat);
      assert.ok(Math.hypot(actual[index].x - expected.x, actual[index].y - expected.y) < 1e-8);
    }
  }
});

test("paused and reduced-motion hull water stays frozen while active wavelets advance without popping", () => {
  const boat = { x: 100, y: 20, scale: .7, roll: .008 };
  assert.deepEqual(fishingHullWaterFrame(boat, 0, true), fishingHullWaterFrame(boat, 500, true));
  assert.deepEqual(fishingHullWaterFrame(boat, NaN), fishingHullWaterFrame(boat, 0));
  assert.notDeepEqual(fishingHullWaterFrame(boat, 0), fishingHullWaterFrame(boat, .5));
  const first = fishingHullWaterFrame(boat, 0).ripples[0];
  assert.equal(first.opacity, 0);
  assert.ok(fishingHullWaterFrame(boat, .5 / .22).ripples[0].opacity > .15);
  assert.ok(fishingHullWaterFrame(boat, (1 - 1e-6) / .22).ripples[0].opacity < .001);
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
