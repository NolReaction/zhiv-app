import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root,
  resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false } });
after(() => vite.close());
const { TILED_WORLD } = await vite.ssrLoadModule("/features/world/presentation.ts");
const { connectForestSession } = await vite.ssrLoadModule("/features/world/forest-session.ts");
const { advanceForestDirector, requestForestDirective, noticeForestDirector } = await vite.ssrLoadModule("/features/world/forest-director.ts");
const { requestClearingPoint, releaseClearingPoint, advanceClearingActivity, isClearingAtPoint,
  clearingActivityFrame } = await vite.ssrLoadModule("/features/world/clearing-activity.ts");
const { compileWorldInteractions } = await vite.ssrLoadModule("/features/world/interaction-navigation.ts");
const { canTraverse, isWalkable } = await vite.ssrLoadModule("/features/world/navigation.ts");
const quiet = { autoLife: false, blocked: false, homeAvailable: true, dusk: 0, rain: 0 };
const dt = .025;
const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

function create() {
  const scene = structuredClone(TILED_WORLD);
  scene.paths = [];
  scene.mushrooms = [{ id: "eastern-mushroom", position: { x: 670, y: 705 } }];
  const session = connectForestSession(undefined, scene, "circle", 0, 0, () => {});
  session.release();
  session.state.clearing.seed = 41;
  return { state: session.state, scene };
}
function tick(state, options = quiet) {
  const before = { ...state.clearing.position };
  advanceForestDirector(state, dt, options);
  assert.ok(distance(before, state.clearing.position) <= state.clearing.size * 1.1 * dt + 1e-7,
    `interaction teleported during ${state.clearing.stage}`);
}
function until(state, predicate, options = quiet, inspect = () => {}, seconds = 45) {
  for (let t = 0; t < seconds && !predicate(state); t += dt) { tick(state, options); inspect(); }
  assert.ok(predicate(state), `stalled: ${state.clearing.stage}; ${state.director.reason}`);
}
function moveToEasternGrass(state) {
  const clearing = state.clearing, destination = { x: 665, y: 701 };
  assert.equal(requestClearingPoint(clearing, destination), true);
  for (let t = 0; t < 20 && !isClearingAtPoint(clearing, destination); t += dt) {
    const before = { ...clearing.position };
    advanceClearingActivity(clearing, dt, { enabled: true, blocked: false, homeAvailable: true, dusk: 0, rain: 0 });
    assert.ok(canTraverse(clearing.navigation, before, clearing.position));
  }
  assert.ok(isClearingAtPoint(clearing, destination));
  releaseClearingPoint(clearing);
}

test("the edited map reaches home and bush from current grass without Routes or a detour to spawn", () => {
  for (const kind of ["home-sleep", "bush"]) {
    const { state } = create();
    moveToEasternGrass(state);
    const from = { ...state.clearing.position };
    requestForestDirective(state, kind, quiet);
    assert.deepEqual(state.clearing.position, from, "requesting an action cannot move the resident");
    const reached = () => state.clearing.stage === (kind === "home-sleep" ? "home-sleep" : "bush-hidden");
    until(state, reached, quiet, () => {
      assert.ok(distance(state.clearing.position, state.clearing.home) > 8,
        "the resident must approach the interaction from its current location");
    });
    assert.equal(state.pendingLife, null);
    assert.equal(state.clearing.routes.length, 0);
  }
});

test("an indoor mushroom request exits to navigable grass and continues without visiting spawn", () => {
  const { state, scene } = create(), dock = compileWorldInteractions(scene).home.dock;
  moveToEasternGrass(state);
  requestForestDirective(state, "home-sleep", quiet);
  until(state, () => state.clearing.stage === "home-sleep");
  requestForestDirective(state, "mushroom", quiet);
  let beganApproach = false;
  until(state, () => state.life.routine?.kind === "mushroom", quiet, () => {
    const frame = clearingActivityFrame(state.clearing);
    if (frame.residing) assert.equal(state.life.routine, null);
    if (!beganApproach && state.director.target) {
      beganApproach = true;
      assert.ok(distance(state.clearing.freeRoute.points[0], dock) < .001,
        "the new approach begins at the safe door dock");
    }
    assert.ok(distance(state.clearing.position, state.clearing.home) > 8, "no compulsory spawn return");
  });
  assert.ok(beganApproach);
  assert.equal(state.pendingLife, null);
  assert.ok(distance(state.clearing.position, state.life.mushrooms[0]) < state.clearing.size * .4);
});

test("an indoor insect request resolves after one local exit, preserving every existing participant", () => {
  for (const [kind, dusk] of [["butterfly", 0], ["firefly", 1]]) {
    const { state } = create(), options = { ...quiet, dusk };
    requestForestDirective(state, "home-sleep", options);
    until(state, () => state.clearing.stage === "home-sleep", options);
    const bodies = [...state.fauna.entities];
    requestForestDirective(state, kind, options);
    let episodes = 0, attentive = false;
    until(state, () => state.pendingLife === null, options, () => {
      const frame = clearingActivityFrame(state.clearing);
      if (frame.attention && !attentive) episodes++;
      attentive = frame.attention;
      if (frame.residing) assert.equal(state.fauna.encounter, null);
      assert.ok(distance(state.clearing.position, state.clearing.home) > 8);
      assert.equal(state.fauna.entities.length, bodies.length);
      state.fauna.entities.forEach((body, index) => assert.equal(body, bodies[index]));
    });
    assert.ok(episodes <= 1, "the waiting request must not restart greetings every frame");
    assert.equal(clearingActivityFrame(state.clearing).residing, false);
    if (state.fauna.encounter) assert.equal(state.fauna.encounter.kind, kind);
    else assert.ok(state.fauna.lastReason, "unavailable participants produce a reason instead of a stuck request");
  }
});

test("explicit home and bush requests hand off both ways with autonomous life disabled", () => {
  const { state } = create();
  moveToEasternGrass(state);
  for (const [kind, stage] of [["home-sleep", "home-sleep"], ["bush", "bush-hidden"], ["home-sleep", "home-sleep"]]) {
    requestForestDirective(state, kind, quiet);
    until(state, () => state.clearing.stage === stage, quiet, () => {
      assert.ok(distance(state.clearing.position, state.clearing.home) > 8);
    });
    assert.equal(state.pendingLife, null);
  }
});

test("blocked and reduced-motion director ticks freeze a pending home approach, which resumes afterwards", () => {
  const { state } = create();
  moveToEasternGrass(state);
  requestForestDirective(state, "home-sleep", quiet);
  for (let t = 0; t < .75; t += dt) tick(state);
  for (const options of [{ ...quiet, blocked: true }, { ...quiet, reducedMotion: true }]) {
    const before = { ...state.clearing.position };
    for (let t = 0; t < 3; t += dt) tick(state, options);
    assert.deepEqual(state.clearing.position, before);
  }
  until(state, () => state.clearing.stage === "home-sleep");
});

test("tapping in the short porch gap completes the physical exit even with autonomous life disabled", () => {
  const { state, scene } = create(), dock = compileWorldInteractions(scene).home.dock;
  requestForestDirective(state, "home-sleep", quiet);
  until(state, () => state.clearing.stage === "homebound" && !isWalkable(state.clearing.navigation, state.clearing.position));
  const before = { ...state.clearing.position };
  noticeForestDirector(state);
  assert.deepEqual(state.clearing.position, before);
  until(state, () => state.clearing.stage === "clearing" && !state.clearing.activeInteraction);
  assert.ok(distance(state.clearing.position, dock) < .001);
  assert.ok(isWalkable(state.clearing.navigation, state.clearing.position));
  assert.equal(state.clearing.retiring, false);
});
