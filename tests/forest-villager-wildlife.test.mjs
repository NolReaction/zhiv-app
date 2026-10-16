import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root,
  resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false } });
after(() => vite.close());
const { createForestFauna, advanceForestFauna, residentFaunaEncounter, faunaRenderFrame,
  reconcileResidentFaunaEncounters } = await vite.ssrLoadModule("/features/world/environment/wildlife/forest-fauna.ts");
const { forestVillagerFaunaVisitors, forestVillagerWildlifeHand, createVillagerWildlife, advanceVillagerWildlife, villagerWildlifeAvailable,
  reconcileVillagerWildlife, villagerWildlifeHolds, villagerWildlifeFrame, villagerBirdwatchEvent } =
  await vite.ssrLoadModule("/features/world/characters/villagers/villager-wildlife.ts");
const rect = (x, y, width, height) => [{ x, y }, { x: x + width, y }, { x: x + width, y: y + height }, { x, y: y + height }];
const scene = { id: "wildlife", width: 420, height: 320, focus: { x: 0, y: 0, width: 420, height: 320 }, habitats: [
  { id: "day", species: "butterfly", points: rect(1, 1, 418, 318), capacity: 6, anchors: [] },
  { id: "night", species: "firefly", points: rect(1, 1, 418, 318), capacity: 12, anchors: [] },
] };
const actor = (id = "lopukh", patch = {}) => ({ id, x: 160, y: 165, size: 44, direction: "front", action: "idle",
  frame: 0, phase: 0, available: true, hand: { x: 170, y: 146 }, ...patch });
const bird = (id = "robin-actual-visit", patch = {}) => ({ id, x: 190, y: 150, size: 3, opacity: 1,
  phase: .2, angle: 0, state: "perched", perchId: "branch", ...patch });
function fauna() {
  const state = createForestFauna(scene); state.nextVisitorAt = 0;
  for (const e of state.entities) Object.assign(e, { x: 180, y: 143, vx: 0, vy: 0, mode: "fly", cooldownUntil: 0, nextRestAt: Infinity });
  return state;
}
function advance(state, seconds, options) {
  for (let t = 0; t < seconds - 1e-9; t += .025) advanceForestFauna(state, .025, { dusk: 0, rain: 0, ...options });
}
function advanceBird(state, seconds, env) {
  for (let t = 0; t < seconds - 1e-9; t += .05) advanceVillagerWildlife(state, .05, env);
}

test("every wildlife paw is the actual free greeting palm at the painted sole in all directions", async () => {
  const modules = await Promise.all(["lopukh", "kamneshmyg", "leaftail"].map(id =>
    vite.ssrLoadModule(`/features/world/characters/${id}/${id}-sprite.ts`)));
  const previous = Object.getOwnPropertyDescriptor(globalThis, "document");
  globalThis.document = { createElement() {
    const canvas = { width: 0, height: 0 }, context = { fillStyle: "", fillRect() {} };
    canvas.getContext = () => context; return canvas;
  } };
  try {
    for (const [index, id] of ["lopukh", "kamneshmyg", "leaftail"].entries()) for (const direction of ["front", "back", "left", "right"]) {
      const frame = actor(id, { direction, frame: 17, phase: .9, size: 71 }); delete frame.hand;
      const sprite = modules[index][`${id}Sprite`]("greet", direction, 0, .5);
      const rig = modules[index][`${id}SpriteRig`](sprite), palm = rig.arms.find(arm => arm.hand === "left").palm;
      const expected = { x: frame.x + (palm.x - 24) * frame.size / 48,
        y: frame.y + (palm.y - rig.contact.bottom) * frame.size / 48 };
      assert.deepEqual(forestVillagerWildlifeHand(frame), expected, `${id}/${direction}`);
      assert.deepEqual(forestVillagerWildlifeHand({ ...frame, action: "greet", frame: 0, phase: .5 }), expected,
        "switching from idle to the greeting cannot move the reserved perch");
      assert.deepEqual(forestVillagerFaunaVisitors([frame])[0].hand, expected);
    }
  } finally {
    if (previous) Object.defineProperty(globalThis, "document", previous); else delete globalThis.document;
  }
});

test("only a quiet, visible outside resident can offer a free paw; input is never moved", () => {
  const original = actor(), before = structuredClone(original);
  assert.equal(villagerWildlifeAvailable(original), true);
  assert.deepEqual(forestVillagerFaunaVisitors([original]).map(v => [v.id, v.reach, v.maxDuration]), [["lopukh", 160, 16]]);
  for (const change of [{ available: false }, { job: true }, { inside: true }, { social: true }, { noticed: true },
    { sleeping: true }, { arriving: true }, { opacity: .9 }, { size: 0 }, { x: NaN },
    ...["walk", "carry", "work", "trade"].map(action => ({ action }))]) {
    assert.equal(villagerWildlifeAvailable(actor("lopukh", change)), false, JSON.stringify(change));
    assert.deepEqual(forestVillagerFaunaVisitors([actor("lopukh", change)]), []);
  }
  assert.deepEqual(original, before);
});

test("each new neighbour meets the same living day/night individual and never adds an animal", () => {
  for (const id of ["lopukh", "kamneshmyg", "leaftail"]) for (const dusk of [0, 1]) {
    const state = fauna(), visitors = forestVillagerFaunaVisitors([actor(id)]), beforeIds = state.entities.map(e => e.id);
    advance(state, .025, { dusk, visitors });
    const visit = residentFaunaEncounter(state, id), entity = state.entities.find(e => e.id === visit.entityId);
    const identity = { id: entity.id, size: entity.size, phase: entity.phase };
    assert.equal(visit.kind, dusk ? "firefly" : "butterfly");
    assert.equal(state.encounter, null, "Mochlik owns no part of a neighbour's visit");
    assert.deepEqual(villagerWildlifeHolds(null, state), [id]);
    assert.deepEqual(villagerWildlifeFrame(null, state, actor(id)), { action: "greet", frame: 0, phase: .5, direction: "front" });
    let perched = false;
    for (let t = 0; t < 14; t += .025) {
      advance(state, .025, { dusk, visitors });
      if (residentFaunaEncounter(state, id)?.phase === "perch") {
        perched = true; assert.ok(Math.hypot(entity.x - visitors[0].hand.x, entity.y - visitors[0].hand.y) < .7);
      }
      assert.equal(faunaRenderFrame(state)[dusk ? "fireflies" : "butterflies"].filter(e => e.id === entity.id).length, 1);
      assert.deepEqual({ id: entity.id, size: entity.size, phase: entity.phase }, identity);
    }
    assert.equal(perched, true); assert.equal(residentFaunaEncounter(state, id), null);
    assert.deepEqual(state.entities.map(e => e.id), beforeIds); assert.deepEqual(villagerWildlifeHolds(null, state), []);
  }
});

test("job, door, touch, social and weather preemption release a still contract without physical jumps", () => {
  for (const patch of [{ job: true }, { inside: true }, { noticed: true }, { social: true }, { sleeping: true },
    { x: 164 }, { hand: { x: 175, y: 146 } }]) {
    const state = fauna(), visitors = forestVillagerFaunaVisitors([actor()]); advance(state, 1, { visitors });
    const visit = residentFaunaEncounter(state, "lopukh"), entity = state.entities.find(e => e.id === visit.entityId);
    const physical = { x: entity.x, y: entity.y, vx: entity.vx, vy: entity.vy, phase: entity.phase }, elapsed = state.elapsed;
    reconcileResidentFaunaEncounters(state, forestVillagerFaunaVisitors([actor("lopukh", patch)]));
    assert.equal(visit.phase, "interrupt"); assert.deepEqual(villagerWildlifeHolds(null, state), []);
    assert.equal(state.elapsed, elapsed); assert.deepEqual({ x: entity.x, y: entity.y, vx: entity.vx, vy: entity.vy, phase: entity.phase }, physical);
    assert.equal(entity.mode, "depart");
    advance(state, .7, { visitors: [] }); assert.equal(residentFaunaEncounter(state, "lopukh"), null);
  }
  for (const conditions of [{ dusk: 1, rain: 0 }, { dusk: 0, rain: 1 }, { dusk: 0, rain: 0, butterflies: "off" }]) {
    const state = fauna(), visitors = forestVillagerFaunaVisitors([actor()]); advance(state, .5, { visitors });
    const elapsed = state.elapsed;
    reconcileResidentFaunaEncounters(state, visitors, conditions);
    assert.equal(residentFaunaEncounter(state, "lopukh").phase, "interrupt"); assert.equal(state.elapsed, elapsed);
  }
});

test("paused, reduced-motion and zero delta preserve a valid individual and valid bird observation", () => {
  const state = fauna(), wildlife = createVillagerWildlife(), actors = [actor()], visitors = forestVillagerFaunaVisitors(actors);
  advance(state, .5, { visitors });
  const snapshot = structuredClone(state);
  for (const option of [{ paused: true }, { reducedMotion: true }]) advance(state, 1, { visitors, ...option });
  advanceForestFauna(state, 0, { dusk: 0, rain: 0, visitors });
  reconcileResidentFaunaEncounters(state, visitors); assert.deepEqual(state, snapshot);
  const noVisit = fauna(); wildlife.nextBirdAt = 0;
  const env = { actors, birds: [bird()], fauna: noVisit };
  advanceVillagerWildlife(wildlife, .05, env); const birdSnapshot = structuredClone(wildlife);
  for (const option of [{ paused: true }, { reducedMotion: true }]) advanceBird(wildlife, 1, { ...env, ...option });
  for (const delta of [0, -1, NaN, Infinity]) advanceVillagerWildlife(wildlife, delta, env);
  reconcileVillagerWildlife(wildlife, actors, noVisit); assert.deepEqual(wildlife, birdSnapshot);
});

test("visitor fairness is stable across camera order and a recently met resident cannot monopolise wildlife", () => {
  for (const reverse of [false, true]) {
    const state = fauna(), actors = [actor("lopukh"), actor("leaftail")]; if (reverse) actors.reverse();
    const visitors = forestVillagerFaunaVisitors(actors); advance(state, .025, { visitors });
    assert.equal(state.visitorEncounters[0].visitorId, "leaftail");
    reconcileResidentFaunaEncounters(state, []); advance(state, .7, { visitors: [] });
    state.nextVisitorAt = state.elapsed; advance(state, .025, { visitors });
    assert.equal(state.visitorEncounters[0].visitorId, "lopukh");
    reconcileResidentFaunaEncounters(state, []); advance(state, .7, { visitors: [] });
    state.nextVisitorAt = state.elapsed; advance(state, .025, { visitors });
    assert.equal(state.visitorEncounters.length, 0, "both individual cooldowns survive the end of the shared quiet period");
  }
});

test("new neighbours refuse far-away invitations and short approach contracts expire without waiting forever", () => {
  const state = fauna(), visitors = forestVillagerFaunaVisitors([actor()]);
  for (const e of state.entities) Object.assign(e, { x: 410, y: 300 });
  advance(state, 1, { visitors }); assert.equal(state.visitorEncounters.length, 0);
  const near = fauna(), short = [{ ...visitors[0], hand: { x: 50, y: 120 }, maxDuration: 1 }];
  advance(near, .025, { visitors: short }); assert.equal(near.visitorEncounters.length, 1);
  advance(near, 1.2, { visitors: short }); assert.equal(near.visitorEncounters[0].phase, "interrupt");
  advance(near, .7, { visitors: short }); assert.equal(near.visitorEncounters.length, 0);
});

test("a purposeful bird pause observes one actual perch, has a stable event and leaves all birds free", () => {
  const wildlife = createVillagerWildlife(), state = fauna(), actors = [actor("leaftail"), actor("lopukh")], birds = [bird()];
  wildlife.nextBirdAt = 0; const original = structuredClone(birds), env = { actors, birds, fauna: state };
  advanceVillagerWildlife(wildlife, .05, env);
  assert.equal(wildlife.birdwatch.visitorId, "leaftail"); assert.equal(wildlife.birdwatch.watch.birdId, birds[0].id);
  assert.deepEqual(villagerWildlifeHolds(wildlife, state), ["leaftail"]);
  assert.equal(forestVillagerFaunaVisitors(actors, wildlife).find(v => v.id === "leaftail").available, false);
  assert.equal(villagerBirdwatchEvent(wildlife), null);
  advanceBird(wildlife, .7, env); const event = villagerBirdwatchEvent(wildlife);
  assert.equal(event.speaker, "leaftail"); assert.equal(event.kind, "bird");
  for (let n = 0; n < 5; n++) {
    const before = structuredClone(wildlife);
    assert.deepEqual(villagerBirdwatchEvent(wildlife), event);
    assert.equal(villagerWildlifeFrame(wildlife, state, actors[0]).action, "inspect");
    assert.deepEqual(wildlife, before, "both cameras read the same observer without ticking it");
  }
  advanceBird(wildlife, 5.4, env); assert.equal(wildlife.birdwatch, null);
  assert.deepEqual(villagerWildlifeHolds(wildlife, state), []); assert.deepEqual(birds, original);
  assert.ok(wildlife.nextBirdAt > wildlife.elapsed + 44);
});

test("a departing bird is never replaced by a nearer arrival and its observer releases after a finite outro", () => {
  const wildlife = createVillagerWildlife(), state = fauna(), actors = [actor()], env = { actors, fauna: state, birds: [bird()] };
  wildlife.nextBirdAt = 0; advanceVillagerWildlife(wildlife, .05, env);
  const originalId = wildlife.birdwatch.watch.birdId;
  advanceBird(wildlife, .5, { ...env, birds: [bird("new-bird", { x: 165 })] });
  assert.equal(wildlife.birdwatch.watch.birdId, originalId); assert.equal(villagerBirdwatchEvent(wildlife), null);
  advanceBird(wildlife, .1, { ...env, birds: [bird("new-bird", { x: 165 })] });
  assert.equal(wildlife.birdwatch, null); assert.deepEqual(villagerWildlifeHolds(wildlife, state), []);
});

test("bird watching yields to Mochlik's real observation, fauna, bad weather and every resident occupation", () => {
  for (const extra of [{ reservedBirdIds: [bird().id] }, { rain: .4 }, { dusk: .8 }, { enabled: false }]) {
    const wildlife = createVillagerWildlife(), state = fauna(); wildlife.nextBirdAt = 0;
    advanceVillagerWildlife(wildlife, .05, { actors: [actor()], fauna: state, birds: [bird()], ...extra });
    assert.equal(wildlife.birdwatch, null);
  }
  const state = fauna(), actors = [actor()], visitors = forestVillagerFaunaVisitors(actors); advance(state, .025, { visitors });
  const wildlife = createVillagerWildlife(); wildlife.nextBirdAt = 0;
  advanceVillagerWildlife(wildlife, .05, { actors, fauna: state, birds: [bird()] }); assert.equal(wildlife.birdwatch, null);
  for (const patch of [{ job: true }, { noticed: true }, { inside: true }, { social: true }, { arriving: true }, { action: "walk" }, { x: 165 }]) {
    const fresh = createVillagerWildlife(), faunaState = fauna(); fresh.nextBirdAt = 0;
    advanceVillagerWildlife(fresh, .05, { actors, fauna: faunaState, birds: [bird()] });
    const elapsed = fresh.elapsed; reconcileVillagerWildlife(fresh, [actor("lopukh", patch)], faunaState);
    assert.equal(fresh.birdwatch, null); assert.equal(fresh.elapsed, elapsed);
  }
});
