import assert from "node:assert/strict";
import test, { after } from "node:test";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root,
  resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false } });
after(() => vite.close());
const { createBirdReactions, advanceBirdReactions, applyBirdReactions }
  = await vite.ssrLoadModule("/features/world/forest-bird-reactions.ts");
const { forestBirdFrame } = await vite.ssrLoadModule("/features/world/forest-birds.ts");
const scene = JSON.parse(await readFile(new URL("../features/world/tiled/forest.generated.json", import.meta.url)));
const bounds = { width: scene.width, height: scene.height };
const sample = (birdElapsed, birdSeed = 0) => forestBirdFrame(scene,
  { elapsed: 0, birdElapsed, birdSeed, dusk: 0, rain: 0, reducedMotion: false });
const sound = (bird, kind = "footstep") => ({ kind, position: { x: bird.x - 4, y: bird.y + 2 } });
const bird = (id, x, y, state = "perched") => ({ id, x, y, state, size: 2, opacity: 1,
  angle: 0, phase: 3, species: "robin", perchId: `tree-${id}`, headTurn: 0, tailFlick: 0,
  preen: state === "preen" ? 1 : 0, wingFold: 1, wingLift: .35, legReach: 1 });
const poseOnly = frame => frame.map(bird => {
  const rest = { ...bird };
  delete rest.headTurn; delete rest.tailFlick; delete rest.preen;
  return rest;
});

test("one sound draws only the nearest actual resting bird's attention", () => {
  const state = createBirdReactions();
  const birds = [bird("far", 230, 100), bird("near", 110, 100, "preen"), bird("other", 120, 100),
    bird("airborne", 101, 100, "flap")];
  const before = structuredClone(birds);
  advanceBirdReactions(state, birds, .02, { kind: "footstep", position: { x: 100, y: 100 } }, bounds);
  assert.deepEqual(applyBirdReactions(state, birds), birds, "the look begins at the current pose");
  advanceBirdReactions(state, birds, .2);
  const result = applyBirdReactions(state, birds);
  assert.ok(result[1].headTurn < -.65, "bird turns toward a sound behind it");
  assert.ok(result[1].preen < .1, "preening pauses while listening");
  assert.ok(result[1].tailFlick > 0, "a small initial tail flinch accompanies the look");
  for (const i of [0, 2, 3]) assert.equal(result[i], birds[i]);
  assert.deepEqual(poseOnly(result), poseOnly(birds), "attention never replaces the authored body motion");
  assert.deepEqual(birds, before, "shared frame input remains immutable");
});

test("footsteps have a smaller local range than a bush rustle and silent events do nothing", () => {
  const birds = [bird("resting", 100, 100)];
  for (const event of [
    { kind: "footstep", position: { x: 190, y: 100 } },
    { kind: "bush-rustle", position: { x: 213, y: 100 } },
    { ...sound(birds[0]), intensity: 0 },
    { ...sound(birds[0]), intensity: NaN },
    { ...sound(birds[0]), position: { x: NaN, y: 100 } },
    { ...sound(birds[0]), position: { x: -1, y: 100 } },
  ]) {
    const state = createBirdReactions();
    advanceBirdReactions(state, birds, .02, event, bounds);
    advanceBirdReactions(state, birds, .2);
    assert.deepEqual(applyBirdReactions(state, birds), birds);
  }
  const state = createBirdReactions();
  advanceBirdReactions(state, birds, .02, { kind: "bush-rustle", position: { x: 190, y: 100 } }, bounds);
  advanceBirdReactions(state, birds, .2);
  assert.ok(applyBirdReactions(state, birds)[0].headTurn > .3);
});

test("positive shared time is required; rendering and camera order never consume the response", () => {
  const birds = sample(12), state = createBirdReactions();
  for (const dt of [0, -1, NaN, Infinity]) advanceBirdReactions(state, birds, dt, sound(birds[0]), bounds);
  assert.deepEqual(applyBirdReactions(state, birds), birds);
  assert.equal(state.elapsed, 0);
  advanceBirdReactions(state, birds, .02, sound(birds[0]), bounds);
  advanceBirdReactions(state, birds, .2);
  const expected = applyBirdReactions(state, birds), frozen = structuredClone(state);
  for (let camera = 0; camera < 4; camera++) {
    advanceBirdReactions(state, birds, 0, sound(birds[1], "bush-rustle"), bounds);
    assert.deepEqual(applyBirdReactions(state, birds), expected);
  }
  assert.deepEqual(state, frozen, "paused and reduced-motion callers retain the exact attention frame");
});

test("the response rejoins the live preening clock without stale coordinates or a second bird", () => {
  const state = createBirdReactions(), initial = sample(12);
  advanceBirdReactions(state, initial, .02, sound(initial[0]), bounds);
  let final;
  for (let tick = 1; tick <= 170; tick++) {
    const base = sample(12 + tick * .01);
    advanceBirdReactions(state, base, .01);
    final = applyBirdReactions(state, base);
    assert.deepEqual(poseOnly(final), poseOnly(base));
    assert.equal(new Set(final.map(bird => bird.id)).size, final.length);
    if (tick === 20) assert.notEqual(final[0].preen, base[0].preen);
  }
  assert.deepEqual(final, sample(13.7), "return blends to the current authored pose, not a captured frame");
  assert.notDeepEqual(final, initial);
});

test("authored departure and branch transfer keep their exact lift, wings, feet and position", () => {
  for (const [seed, start] of [[0, 19.35], [5, 11.35]]) {
    const state = createBirdReactions(), initial = sample(start, seed);
    advanceBirdReactions(state, initial, .02, sound(initial[0], "bush-rustle"), bounds);
    let previous = applyBirdReactions(state, initial)[0];
    for (let tick = 1; tick <= 90; tick++) {
      const base = sample(start + tick * .01, seed);
      advanceBirdReactions(state, base, .01);
      const result = applyBirdReactions(state, base);
      assert.deepEqual(poseOnly(result), poseOnly(base));
      assert.ok(Math.hypot(result[0].x - previous.x, result[0].y - previous.y) < 4,
        "taking flight never returns to the reaction's first perch position");
      previous = result[0];
      if (tick === 70) assert.deepEqual(result, base, "attention has smoothly cleared during departure");
    }
  }
});

test("repeated steps cannot restart the look or cascade through the whole nearby flock", () => {
  const state = createBirdReactions(), birds = [bird("a", 100, 100), bird("b", 105, 100)];
  const event = sound(birds[0]);
  advanceBirdReactions(state, birds, .02, event, bounds);
  for (let tick = 0; tick < 30; tick++) advanceBirdReactions(state, birds, .1, event, bounds);
  assert.equal(state.attention.size, 1);
  assert.deepEqual(applyBirdReactions(state, birds), birds, "repeated footsteps do not prolong the completed look");
  advanceBirdReactions(state, [birds[0]], .7, event, bounds);
  assert.equal(state.attention.size, 1, "the same bird also has an individual cooldown");
  advanceBirdReactions(state, [birds[0]], 5, event, bounds);
  advanceBirdReactions(state, [birds[0]], .2);
  assert.notEqual(applyBirdReactions(state, [birds[0]])[0].headTurn, birds[0].headTurn);
});

test("ties are stable across frame order and only identified birds at real perches can listen", () => {
  const a = bird("a", 100, 100), b = bird("b", 100, 100);
  for (const birds of [[a, b], [b, a]]) {
    const state = createBirdReactions();
    advanceBirdReactions(state, birds, .02, sound(a), bounds);
    assert.deepEqual([...state.attention.keys()], ["a"]);
  }
  const state = createBirdReactions(), unknown = [{ ...a, id: undefined }, { ...b, perchId: undefined }];
  advanceBirdReactions(state, unknown, .02, sound(a), bounds);
  assert.equal(state.attention.size, 0);
  advanceBirdReactions(state, [a], .02, sound(a), bounds);
  advanceBirdReactions(state, [], 9);
  assert.equal(state.attention.size, 0, "expired visits leave no permanent registry entries");
  assert.deepEqual(applyBirdReactions(state, []), [], "attention never spawns a hidden or duplicate bird");
});
