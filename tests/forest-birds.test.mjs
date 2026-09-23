import assert from "node:assert/strict";
import test, { after } from "node:test";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root,
  resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false } });
after(() => vite.close());
const { forestBirdFrame, forestBirdPerches, FOREST_BIRD_FLIGHT_DURATION, FOREST_BIRD_LIMIT }
  = await vite.ssrLoadModule("/features/world/forest-birds.ts");
const { drawForestBird } = await vite.ssrLoadModule("/features/world/forest-wildlife.ts");
const scene = JSON.parse(await readFile(new URL("../features/world/tiled/forest.generated.json", import.meta.url)));
const options = { elapsed: 0, dusk: 0, rain: 0, reducedMotion: false };
const sample = (time, changed = scene, birdSeed = 0) => forestBirdFrame(changed, { ...options, birdElapsed: time, birdSeed });
const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

function assertFiniteBird(bird) {
  for (const [key, value] of Object.entries(bird)) if (typeof value === "number")
    assert.ok(Number.isFinite(value), `${key} must remain finite`);
  assert.ok(bird.size > 0 && bird.opacity > 0 && bird.opacity <= 1);
  assert.ok(bird.wingFold >= 0 && bird.wingFold <= 1);
  assert.ok(bird.legReach >= 0 && bird.legReach <= 1);
}

test("DEV birds arrive from outside the map, reach real trees and contain a complete living cycle", () => {
  assert.deepEqual(sample(0), []);
  assert.ok(sample(5).some(b => b.x >= scene.focus.x && b.x < scene.focus.x + scene.focus.width
    && b.y >= scene.focus.y && b.y < scene.focus.y + scene.focus.height), "exterior approach reaches the clearing promptly");
  const states = new Set();
  for (let time = 0; time < FOREST_BIRD_FLIGHT_DURATION; time += .1) {
    const birds = sample(time);
    assert.ok(birds.length <= FOREST_BIRD_LIMIT);
    birds.forEach(bird => { assertFiniteBird(bird); states.add(bird.state); });
  }
  for (const state of ["flap", "glide", "landing", "perched", "preen", "hop", "takeoff"])
    assert.ok(states.has(state), `${state} is visible in the manual visit`);
  assert.deepEqual(sample(FOREST_BIRD_FLIGHT_DURATION), []);
  assert.ok(sample(28).some(b => b.x < scene.focus.x || b.x > scene.focus.x + scene.focus.width),
    "birds fly on through the wider world after leaving their tree");
});

test("perched feet stay on inspected tree crowns, including a tiny local hop", () => {
  const perches = forestBirdPerches(scene);
  assert.ok(perches.length >= 4, "canopies cover several areas of the forest");
  assert.ok(Math.max(...perches.map(p => p.x)) - Math.min(...perches.map(p => p.x)) > scene.width * .6);
  for (const bird of sample(10)) {
    const perch = perches.find(p => p.id === bird.perchId);
    assert.ok(perch);
    assert.ok(Math.abs(bird.x - perch.x) < 1e-9);
    assert.ok(Math.abs(bird.y + bird.size * 3.3 - perch.y) < 1e-9,
      "drawn feet contact the crown; the bird body never floats above an arbitrary air point");
    assert.equal(bird.wingFold, 1);
  }
  const before = sample(15.3)[0], top = sample(15.65)[0], after = sample(16)[0];
  assert.equal(top.state, "hop");
  assert.ok(top.y < before.y - 3);
  assert.ok(Math.abs(top.x - before.x) < 4, "hop stays within the same supporting branch");
  assert.ok(distance(before, after) < .001, "the hop returns to its tree");
});

test("landing, settling, preening, hopping and takeoff do not teleport the bird", () => {
  const boundaries = [4.7, 7, 7.7, 11.1, 13.3, 15.3, 16, 19.5, 19.95, 21.9];
  for (const time of boundaries) {
    const before = sample(time - .0001), after = sample(time + .0001);
    assert.equal(after.length, before.length);
    before.forEach((bird, i) => assert.ok(distance(bird, after[i]) < .03, `continuous at ${time}s`));
  }
  const earlyLandingSpeed = distance(sample(5.5)[0], sample(5.6)[0]);
  const lateLandingSpeed = distance(sample(6.9)[0], sample(7)[0]);
  assert.ok(lateLandingSpeed < earlyLandingSpeed * .2, "the approach brakes before the feet touch down");
  const push = distance(sample(19.5)[0], sample(19.6)[0]);
  const departing = distance(sample(21)[0], sample(21.1)[0]);
  assert.ok(departing > push * 8, "takeoff accelerates from rest on the crown");
});

test("unknown, changed, resized or obscured terrain never receives a guessed perch", () => {
  const terrain = scene.terrain[0];
  const changedScenes = [
    { ...scene, id: "other-world" },
    { ...scene, terrain: [] },
    { ...scene, width: scene.width + 1 },
    { ...scene, terrain: [{ ...terrain, image: terrain.image + "-new" }] },
    { ...scene, terrain: [{ ...terrain, bounds: { ...terrain.bounds, x: 3 } }] },
  ];
  for (const edited of changedScenes) {
    assert.deepEqual(forestBirdPerches(edited), []);
    for (const time of [0, 7, 10, 18, 24])
      assert.ok(sample(time, edited).every(b => !b.perchId && ["flap", "glide"].includes(b.state)));
  }
  const first = forestBirdPerches(scene)[0];
  const blocked = { ...scene, sites: [{ bounds: { x: first.x - 5, y: first.y - 5, width: 10, height: 10 } }] };
  assert.ok(!forestBirdPerches(blocked).some(p => p.id === first.id), "a moved building excludes its covered canopy");
});

test("automatic birds alternate broad corridors and several tree visits within a small mobile budget", () => {
  const perches = new Set(), corridors = new Set();
  let visibleSeconds = 0, run = [];
  for (let elapsed = 0; elapsed < 3800; elapsed += .5) {
    const birds = forestBirdFrame(scene, { ...options, elapsed });
    assert.ok(birds.length <= FOREST_BIRD_LIMIT);
    if (birds.length) {
      visibleSeconds += .5;
      for (const bird of birds) { assertFiniteBird(bird); if (bird.state === "perched") perches.add(bird.perchId); }
      run.push(birds[0]);
    } else if (run.length) {
      if (!run[0].perchId) {
        const dx = Math.abs(run.at(-1).x - run[0].x) / scene.width;
        const dy = Math.abs(run.at(-1).y - run[0].y) / scene.height;
        if (dx > .8 && dy < .25) corridors.add("horizontal");
        if (dy > .8 && dx < .25) corridors.add("vertical");
        if (dx > .8 && dy > .6) corridors.add("diagonal");
      }
      run = [];
    }
  }
  assert.ok(visibleSeconds < 3800 / 4, "most of the forest remains quiet between brief visits");
  assert.ok(perches.size >= 4, "automatic visits are not confined to the clearing");
  assert.deepEqual([...corridors].sort(), ["diagonal", "horizontal", "vertical"]);
});

test("shared clocks, camera order and replay cannot drift or consume bird state", () => {
  const expected = sample(12.5);
  forestBirdFrame({ ...scene, id: "another-map" }, { ...options, elapsed: 900 });
  assert.deepEqual(sample(12.5), expected);
  assert.deepEqual(forestBirdFrame(scene, { ...options, elapsed: 999999, rain: 1, dusk: 1, birdElapsed: 12.5 }), expected,
    "manual replay ignores weather and absolute clock but follows the same scene seconds");
  for (const birds of ["off", false]) assert.deepEqual(forestBirdFrame(scene, { ...options, birds, birdElapsed: 12.5 }), []);
  for (const reducedMotion of [true]) assert.deepEqual(forestBirdFrame(scene, { ...options, reducedMotion, birdElapsed: 12.5 }), []);
  for (const birdElapsed of [-1, NaN, Infinity, FOREST_BIRD_FLIGHT_DURATION]) assert.deepEqual(sample(birdElapsed), []);
  assert.deepEqual(forestBirdFrame(scene, { ...options, dusk: 1 }), []);
  assert.deepEqual(forestBirdFrame(scene, { ...options, rain: 1 }), []);
});

test("the painter supports folded wings, extended feet and preening without leaking canvas state", () => {
  for (const time of [2, 6.8, 10, 12, 15.65, 20, 27]) {
    let depth = 0;
    const calls = [], stack = [];
    const ctx = { globalAlpha: .4, fillStyle: "blue", strokeStyle: "red", lineWidth: 5 };
    for (const name of ["beginPath", "closePath", "moveTo", "lineTo", "ellipse", "bezierCurveTo", "fill", "stroke", "translate", "rotate"])
      ctx[name] = (...args) => { args.forEach(value => { if (typeof value === "number") assert.ok(Number.isFinite(value)); }); calls.push([name, ...args]); };
    const snapshot = () => ({ globalAlpha: ctx.globalAlpha, fillStyle: ctx.fillStyle, strokeStyle: ctx.strokeStyle, lineWidth: ctx.lineWidth });
    const initial = snapshot();
    ctx.save = () => { depth++; stack.push(snapshot()); };
    ctx.restore = () => { depth--; Object.assign(ctx, stack.pop()); };
    drawForestBird(ctx, sample(time)[0]);
    assert.equal(depth, 0);
    assert.deepEqual(snapshot(), initial);
    assert.ok(calls.filter(c => c[0] === "ellipse").length >= 6, "body, folded feathering and head remain shaped");
    if (time === 10) assert.ok(calls.some(c => c[0] === "stroke"), "perched feet are drawn on the canopy");
  }
});


test("all six DEV scenarios enter and leave at map edges with whole-sprite culling and staggered groups", () => {
  const groupSizes = new Set(), species = new Set(), scenarios = new Set();
  const nearEdge = b => b.x <= b.size * 10 || b.y <= b.size * 10
    || b.x >= scene.width - b.size * 10 || b.y >= scene.height - b.size * 10;
  for (let seed = 0; seed < 6; seed++) {
    assert.deepEqual(sample(0, scene, seed), []);
    const firstSeen = new Map(), lastSeen = new Map();
    let previous = new Map(), maxGroup = 0;
    for (let time = 0; time <= FOREST_BIRD_FLIGHT_DURATION; time += .02) {
      const frame = sample(time, scene, seed);
      maxGroup = Math.max(maxGroup, frame.length);
      assert.ok(frame.length <= FOREST_BIRD_LIMIT);
      for (const bird of frame) {
        assertFiniteBird(bird); species.add(bird.species); scenarios.add(bird.scenario);
        if (!firstSeen.has(bird.id)) {
          assert.ok(nearEdge(bird), `${bird.scenario} first appears only at the world edge`);
          firstSeen.set(bird.id, time);
        }
        const before = previous.get(bird.id);
        if (before) assert.ok(distance(before, bird) < 12, "visible birds never teleport between stages");
        lastSeen.set(bird.id, bird);
      }
      previous = new Map(frame.map(b => [b.id, b]));
    }
    assert.ok(firstSeen.size > 0);
    for (const bird of lastSeen.values()) assert.ok(nearEdge(bird), `${bird.scenario} exits before the replay timer ends`);
    if (firstSeen.size > 1) assert.ok(new Set(firstSeen.values()).size > 1, "a group arrives progressively");
    groupSizes.add(maxGroup);
  }
  assert.deepEqual([...groupSizes].sort(), [1, 2, 3, 5]);
  assert.deepEqual([...species].sort(), ["blue-tit", "finch", "robin", "swallow"]);
  assert.equal(scenarios.size, 6);
});

test("DEV replay seed changes the visit while a paused shared clock stays identical", () => {
  const first = sample(10, scene, 0), next = sample(10, scene, 1);
  assert.notDeepEqual(first, next);
  assert.deepEqual(sample(10, scene, 0), first);
  assert.deepEqual(forestBirdFrame(scene, { ...options, elapsed: 999999, birdElapsed: 10, birdSeed: 1 }), next);
  assert.notDeepEqual(sample(11, scene, 1), next, "motion resumes only when the shared clock advances");
  const transfers = new Map();
  for (const time of [10, 15]) transfers.set(time, sample(time, scene, 5));
  for (const bird of transfers.get(10)) {
    const later = transfers.get(15).find(nextBird => nextBird.id === bird.id);
    assert.notEqual(later.perchId, bird.perchId, "branch-transfer visits a second verified crown");
  }
});

test("species painters have different plumage and wing/tail silhouettes", () => {
  const draws = new Map();
  for (const species of ["robin", "blue-tit", "swallow", "finch"]) {
    const colors = new Set(), shapes = [];
    const ctx = { fillStyle: "", globalAlpha: 1 };
    for (const name of ["save", "restore", "beginPath", "closePath", "moveTo", "lineTo", "ellipse", "bezierCurveTo", "stroke", "translate", "rotate"])
      ctx[name] = (...args) => shapes.push([name, ...args]);
    ctx.fill = () => colors.add(ctx.fillStyle);
    drawForestBird(ctx, { x: 0, y: 0, size: 2, opacity: 1, phase: 0, angle: 0, species });
    draws.set(species, { colors: [...colors], shapes });
  }
  for (const [species, drawing] of draws) {
    if (species !== "finch") assert.notDeepEqual(drawing.colors, draws.get("finch").colors);
  }
  assert.notDeepEqual(draws.get("swallow").shapes, draws.get("robin").shapes,
    "swallows have pointed wings and a longer forked tail, beyond palette variation");
});
