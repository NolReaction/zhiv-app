import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root,
  resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false } });
after(() => vite.close());
const { previewForestResidents, RESIDENT_PREVIEW_SECONDS } = await vite.ssrLoadModule("/features/world/dev/forest-resident-preview.ts");
const { pleskResidentFrame, pleskRoutineDuration } = await vite.ssrLoadModule("/features/world/plesk-resident.ts");
const { TILED_WORLD } = await vite.ssrLoadModule("/features/world/presentation.ts");
const preview = (action, repeat = false, direction = "front") => ({ id: 17, action, repeat, direction });
const ordinary = (elapsed, still = false) => [pleskResidentFrame(TILED_WORLD, elapsed, still)];

test("a one-shot resident action uses preview time then resumes the untouched natural world clock", () => {
  const startedAt = 80, action = preview("catch"), seconds = RESIDENT_PREVIEW_SECONDS.catch;
  const before = ordinary(startedAt + seconds + 1);
  const start = previewForestResidents(TILED_WORLD, startedAt, false, action, startedAt)[0];
  const middle = previewForestResidents(TILED_WORLD, startedAt + seconds / 2, false, action, startedAt)[0];
  assert.equal(start.action, "catch"); assert.equal(start.phase, 0);
  assert.equal(middle.action, "catch"); assert.equal(middle.phase, .5); assert.equal(middle.carryingFish, true);
  assert.deepEqual(previewForestResidents(TILED_WORLD, startedAt + seconds, false, action, startedAt), ordinary(startedAt + seconds));
  assert.deepEqual(previewForestResidents(TILED_WORLD, startedAt + seconds + 1, false, action, startedAt), before);
  assert.deepEqual(previewForestResidents(TILED_WORLD, startedAt + 1, false, null, startedAt), ordinary(startedAt + 1),
    "cancelling a preview resumes the current routine, not its beginning");
  assert.deepEqual(ordinary(startedAt + seconds + 1), before, "DEV sampling has no effect on the world's resident state");
});

test("repeating actions wrap their own phase without moving the resident off his authored pier", () => {
  const startedAt = 120, base = pleskResidentFrame(TILED_WORLD, 0, true);
  const action = preview("walk", true, "left"), seconds = RESIDENT_PREVIEW_SECONDS.walk;
  for (const elapsed of [startedAt, startedAt + .7, startedAt + seconds * 20 + .4]) {
    const frame = previewForestResidents(TILED_WORLD, elapsed, false, action, startedAt)[0];
    assert.equal(frame.action, "walk"); assert.equal(frame.direction, "left");
    assert.deepEqual({ x: frame.x, y: frame.y }, { x: base.x, y: base.y });
    assert.equal(frame.destinationId, "plesk-fishing"); assert.equal(frame.carryingFish, false);
    assert.ok(frame.phase >= 0 && frame.phase < 1); assert.ok(frame.frame >= 0 && frame.frame < 8);
  }
  const catchAction = preview("catch", true), duration = RESIDENT_PREVIEW_SECONDS.catch;
  assert.deepEqual(previewForestResidents(TILED_WORLD, startedAt + .5, false, catchAction, startedAt),
    previewForestResidents(TILED_WORLD, startedAt + duration * 10 + .5, false, catchAction, startedAt));
});

test("turning a running preview changes direction while retaining its phase, feet and animation clock", () => {
  const startedAt = 100, elapsed = 101.25, original = preview("reel", true, "front");
  const before = previewForestResidents(TILED_WORLD, elapsed, false, original, startedAt)[0];
  for (const direction of ["front", "back", "left", "right"]) {
    const frame = previewForestResidents(TILED_WORLD, elapsed, false, { ...original, direction }, startedAt)[0];
    assert.equal(frame.direction, direction);
    assert.deepEqual({ ...frame, direction: before.direction }, before);
    assert.ok(frame.phase > 0, "turning does not restart the action");
  }
});

test("routine preview samples the actual complete local routine and resumes the natural clock at its end", () => {
  const duration = pleskRoutineDuration(TILED_WORLD), startedAt = 53;
  assert.ok(duration > 100 && duration < 1000);
  for (const age of [0, 23, 79, 123]) {
    assert.deepEqual(previewForestResidents(TILED_WORLD, startedAt + age, false, preview("routine"), startedAt),
      [pleskResidentFrame(TILED_WORLD, age, false)]);
  }
  assert.deepEqual(previewForestResidents(TILED_WORLD, startedAt + duration + .01, false, preview("routine"), startedAt),
    ordinary(startedAt + duration + .01));
  assert.deepEqual(previewForestResidents(TILED_WORLD, duration, false, preview("routine", true), 0),
    [pleskResidentFrame(TILED_WORLD, 0, false)], "repeat wraps at the full real routine duration");
  const worldTime = duration * 2 + 34;
  assert.deepEqual(previewForestResidents(TILED_WORLD, worldTime, false, null, startedAt), ordinary(worldTime));
});

test("every explicit action honors reduced motion, including repeated walking and fishing", () => {
  for (const action of Object.keys(RESIDENT_PREVIEW_SECONDS)) {
    const settings = preview(action, true, "back"), duration = RESIDENT_PREVIEW_SECONDS[action];
    const still = previewForestResidents(TILED_WORLD, 20, true, settings, 20);
    assert.equal(still[0].phase, .5); assert.equal(still[0].frame, 0); assert.equal(still[0].direction, "back");
    for (const age of [.2, duration * .75, duration * 20]) {
      assert.deepEqual(previewForestResidents(TILED_WORLD, 20 + age, true, settings, 20), still);
    }
  }
  assert.deepEqual(previewForestResidents(TILED_WORLD, 1000, true, preview("routine", true), 20), ordinary(0, true));
});

test("DEV cannot invent a resident on generic hero markers when his personal pier is missing or invalid", () => {
  const shared = TILED_WORLD.destinations.filter(marker => !marker.id.startsWith("plesk-"));
  const worlds = [
    { ...TILED_WORLD, destinations: shared },
    { ...TILED_WORLD, destinations: [] },
    { ...TILED_WORLD, destinations: undefined },
    { ...TILED_WORLD, destinations: [...shared, { id: "plesk-fishing", position: { x: -100, y: -100 }, pauseSeconds: 10 }] },
  ];
  for (const world of worlds) for (const settings of [null, preview("cast"), preview("rest", true), preview("routine", true)]) {
    assert.deepEqual(previewForestResidents(world, 100, false, settings, 100), []);
  }
});

test("invalid or backwards preview ages start at a finite first frame instead of leaking NaN", () => {
  const settings = preview("pack", true);
  const first = previewForestResidents(TILED_WORLD, 20, false, settings, 20);
  for (const [elapsed, startedAt] of [[19, 20], [Number.NaN, 20], [Infinity, 20], [20, Infinity]]) {
    assert.deepEqual(previewForestResidents(TILED_WORLD, elapsed, false, settings, startedAt), first);
  }
  assert.deepEqual(previewForestResidents(TILED_WORLD, 150, false, settings),
    previewForestResidents(TILED_WORLD, 150, false, settings, 150), "an omitted start time begins now");
});
