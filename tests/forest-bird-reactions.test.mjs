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

test("a resting visitor grows used to passing steps but still notices an abrupt rustle", () => {
  const birds=[bird('visitor',100,100)],state=createBirdReactions(),event=sound(birds[0]);
  advanceBirdReactions(state,birds,.02,event,bounds);
  advanceBirdReactions(state,birds,.2);
  const first=Math.abs(applyBirdReactions(state,birds)[0].headTurn);
  // Frequent sounds teach familiarity without extending or restarting the first look.
  for(let i=0;i<30;i++)advanceBirdReactions(state,birds,.25,event,bounds);
  advanceBirdReactions(state,birds,1);
  advanceBirdReactions(state,birds,.02,event,bounds);
  advanceBirdReactions(state,birds,.2);
  const familiar=Math.abs(applyBirdReactions(state,birds)[0].headTurn);
  assert.ok(familiar<first*.8,'ordinary passing footsteps draw a softer glance');
  advanceBirdReactions(state,birds,9);
  advanceBirdReactions(state,birds,.02,sound(birds[0],'bush-rustle'),bounds);
  advanceBirdReactions(state,birds,.2);
  assert.ok(Math.abs(applyBirdReactions(state,birds)[0].headTurn)>first*.95,
    'a different, sudden sound retains the full response');
  assert.deepEqual(poseOnly(applyBirdReactions(state,birds)),poseOnly(birds));
});

test("bird familiarity recovers in quiet active time and expires with the individual visit", () => {
  const birds=[bird('visitor',100,100)],state=createBirdReactions(),event=sound(birds[0]);
  for(let i=0;i<10;i++)advanceBirdReactions(state,birds,1.6,event,bounds);
  const learned=state.familiarity.get('visitor').footsteps;
  assert.ok(learned>.5);
  const frozen=structuredClone(state);
  advanceBirdReactions(state,birds,0,event,bounds);applyBirdReactions(state,birds);
  assert.deepEqual(state,frozen,'pause and rendering never teach or forget');
  advanceBirdReactions(state,birds,150);
  assert.ok(state.familiarity.get('visitor').footsteps<learned*.15);
  advanceBirdReactions(state,[],13);
  assert.equal(state.familiarity.size,0,'departed bird history cannot accumulate indefinitely');
  const newcomer=[bird('newcomer',100,100)];
  advanceBirdReactions(state,newcomer,.02,sound(newcomer[0]),bounds);
  advanceBirdReactions(state,newcomer,.2);
  assert.ok(Math.abs(applyBirdReactions(state,newcomer)[0].headTurn)>.95);
});

test("a close moving visitor causes a continuous single departure without returning to the old perch", () => {
  const state = createBirdReactions(), birds = [bird("one", 100, 100), bird("two", 110, 100)];
  const visitor = { x: 105, y: 125, size: 50, moving: true };
  let previous = birds[0], first;
  for (let i = 0; i < 350; i++) {
    advanceBirdReactions(state, birds, .05, undefined, { width: 300, height: 300 }, visitor);
    const frame = applyBirdReactions(state, birds);
    assert.equal(new Set(frame.map(item => item.id)).size, frame.length);
    const current = frame.find(item => item.id === "one");
    if (current && previous) assert.ok(Math.hypot(current.x - previous.x, current.y - previous.y) < 20, "no teleport at takeoff");
    if (state.escapes.size && !first) { first = [...state.escapes.keys()]; assert.equal(first.length, 1); }
    previous = current;
  }
  assert.equal(state.escapes.size, 2); assert.equal(applyBirdReactions(state, birds).length, 0, "old authored visits stay suppressed");
  const frozen = structuredClone(state); applyBirdReactions(state, birds); assert.deepEqual(state, frozen);
  for (let i = 0; i < 260; i++) advanceBirdReactions(state, [], .05);
  assert.equal(state.escapes.size, 0); assert.equal(state.proximity.size, 0);
});
test("quiet observation builds tolerance for that visitor without protecting a dangerously close approach", () => {
  const birds = [bird("calm", 100, 100)], bounds = { width: 300, height: 300 };
  const visitor = { x: 100, y: 152, size: 50, moving: false };
  const calm = createBirdReactions(), fresh = createBirdReactions();
  for (let i = 0; i < 220; i++) advanceBirdReactions(calm, birds, .05, undefined, bounds, visitor);
  assert.equal(calm.escapes.size, 0);
  for (let i = 0; i < 30; i++) for (const state of [calm, fresh])
    advanceBirdReactions(state, birds, .05, undefined, bounds, { ...visitor, moving: true });
  assert.equal(fresh.escapes.size, 1); assert.equal(calm.escapes.size, 0);
  for (let i = 0; i < 30; i++) advanceBirdReactions(calm, birds, .05, undefined, bounds, { ...visitor, y: 113, moving: true });
  assert.equal(calm.escapes.size, 1);
});
