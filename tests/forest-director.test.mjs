import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root,
  resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false } });
after(() => vite.close());
const { advanceForestDirector, requestForestDirective, noticeForestDirector, cancelForestDirector } =
  await vite.ssrLoadModule("/features/world/forest-director.ts");
const { connectForestSession } = await vite.ssrLoadModule("/features/world/forest-session.ts");
const { clearingActivityFrame, requestClearingPoint } = await vite.ssrLoadModule("/features/world/clearing-activity.ts");
const { faunaRenderFrame } = await vite.ssrLoadModule("/features/world/forest-fauna.ts");
const { isWalkable } = await vite.ssrLoadModule("/features/world/navigation.ts");
const rectangle = (x, y, width, height) => [{ x, y }, { x: x + width, y }, { x: x + width, y: y + height }, { x, y: y + height }];
const fixture = {
  schemaVersion: 1, id: "director-fixture", width: 300, height: 300, terrain: [],
  focus: { x: 20, y: 20, width: 260, height: 260 }, actor: { spawn: { x: 150, y: 165 }, size: 56 },
  sites: [], water: { surfaces: [], exclusions: [] },
  paths: [{ id: "old-look", behavior: "clearing", activity: "look", points: [{ x: 150, y: 165 }, { x: 125, y: 175 }] }],
  navigation: { version: 1, cellSize: 8, areas: [{ id: "clearing", points: rectangle(40, 40, 220, 220) }],
    obstacles: [{ id: "rock", points: rectangle(173, 130, 15, 48) }],
    interests: [{ id: "flowers", activity: "sniff", position: { x: 215, y: 210 } }] },
  mushrooms: [{ id: "far-mushroom", position: { x: 220, y: 205 } }],
  habitats: [
    { id: "flowers", species: "butterfly", capacity: 3, points: rectangle(115, 105, 80, 70),
      anchors: [{ id: "leaf", kind: "rest", position: { x: 125, y: 135 } }, { id: "bush", kind: "shelter", position: { x: 115, y: 110 } }] },
    { id: "grass", species: "firefly", capacity: 3, points: rectangle(110, 105, 85, 90),
      anchors: [{ id: "grass-tip", kind: "rest", position: { x: 180, y: 155 } }, { id: "grass-base", kind: "shelter", position: { x: 185, y: 180 } }] },
  ],
};
const calm = { autoLife: false, blocked: false, dusk: 0, rain: 0, homeAvailable: false };
const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
function create(override) {
  const session = connectForestSession(undefined, { ...structuredClone(fixture), ...override }, "circle", 0, 0, () => {});
  session.release(); return session.state;
}
function advance(state, seconds, options = calm, inspect) {
  for (let elapsed = 0; elapsed < seconds - 1e-9; elapsed += .025) {
    advanceForestDirector(state, Math.min(.025, seconds - elapsed), options); inspect?.(state);
  }
}
function until(state, predicate, seconds = 20, options = calm) {
  for (let elapsed = 0; elapsed < seconds && !predicate(state); elapsed += .025) advanceForestDirector(state, .025, options);
  assert.ok(predicate(state), `condition not reached: ${state.director.reason}, ${state.clearing.stage}`);
}

test("explicit butterfly and firefly requests reserve existing bodies and never create a legacy insect routine", () => {
  for (const species of ["butterfly", "firefly"]) {
    const state = create(), options = { ...calm, dusk: species === "firefly" ? 1 : 0 };
    const ids = state.fauna.entities.map(entity => entity.id), origin = { ...state.clearing.position };
    requestForestDirective(state, species, options); advance(state, .025, options);
    assert.equal(state.fauna.encounter?.kind, species);
    const id = state.fauna.encounter.entityId, body = state.fauna.entities.find(entity => entity.id === id);
    assert.ok(ids.includes(id)); assert.equal(state.life.routine, null);
    let perched = false;
    advance(state, 20, options, () => {
      assert.equal(state.life.routine, null, "the director delegates all insects to persistent fauna");
      assert.deepEqual(state.fauna.entities.map(entity => entity.id), ids);
      assert.equal(state.fauna.entities.find(entity => entity.id === id), body);
      const group = faunaRenderFrame(state.fauna)[species === "butterfly" ? "butterflies" : "fireflies"];
      assert.equal(group.filter(entity => entity.id === id).length, 1);
      assert.deepEqual(state.clearing.position, origin, "contact keeps the actor's real feet");
      if (state.fauna.encounter?.phase === "perch") perched = true;
    });
    assert.ok(perched); assert.equal(state.fauna.encounter, null); assert.equal(state.director.activeKey, null);
    assert.ok(state.director.recent.some(item => item.key === species));
  }
});

test("failed encounter requests respect absence, weather and species settings without fabricating participants", () => {
  for (const [override, options] of [[{ habitats: [] }, calm], [{}, { ...calm, rain: 1 }], [{}, { ...calm, butterflies: "off" }]]) {
    const state = create(override), ids = state.fauna.entities.map(entity => entity.id);
    requestForestDirective(state, "butterfly", options); advance(state, .05, options);
    assert.equal(state.pendingLife, null); assert.equal(state.fauna.encounter, null); assert.equal(state.life.routine, null);
    assert.deepEqual(state.fauna.entities.map(entity => entity.id), ids);
    assert.equal(state.director.reason, state.fauna.lastReason);
    assert.ok(state.director.reason.length > 0);
  }
});

test("a distant grown mushroom is approached through safe ground and held only after arrival", () => {
  const state = create(), mushroom = state.life.mushrooms[0], origin = { ...state.clearing.position };
  assert.equal(mushroom.reachable, false, "fixture exceeds the old spawn pickup radius");
  requestForestDirective(state, "mushroom", calm); advance(state, .025);
  assert.equal(state.pendingLife, "mushroom"); assert.equal(state.life.routine, null);
  const target = { ...state.director.target };
  assert.ok(distance(target, mushroom) < state.clearing.size * .2);
  let previous = { ...state.clearing.position }, walking = false;
  advance(state, 15, calm, () => {
    const foot = state.clearing.position;
    assert.ok(distance(foot, previous) < 1.5, "each approach step is continuous");
    assert.equal(isWalkable(state.clearing.navigation, foot), true);
    if (distance(foot, origin) > 1) walking = true;
    if (state.life.routine) assert.ok(distance(foot, target) <= .5, "the prop never teleports to a distant hero");
    previous = { ...foot };
  });
  assert.ok(walking); assert.equal(state.life.routine, null); assert.equal(state.clearing.requestedPoint, null);
  assert.ok(mushroom.regrowIn > 0); assert.ok(state.director.recent.some(item => item.key === "mushroom:far-mushroom"));
});

test("a manual mushroom request cannot grow or consume an immature or inaccessible prop", () => {
  for (const unreachable of [false, true]) {
    const state = create(unreachable ? { mushrooms: [{ id: "outside", position: { x: 295, y: 295 } }] } : {});
    if (!unreachable) state.life.mushrooms[0].growth = .2;
    requestForestDirective(state, "mushroom", calm); advance(state, .05);
    assert.equal(state.pendingLife, null); assert.equal(state.life.routine, null);
    assert.equal(state.life.mushrooms[0].regrowIn, 0);
    if (!unreachable) assert.ok(state.life.mushrooms[0].growth < .21);
    assert.match(state.director.reason, /Нет выросшего гриба/);
  }
});

test("tapping a held prop settles it before greeting and repeated taps do not restart the release", () => {
  const state = create(); requestForestDirective(state, "mushroom", calm);
  until(state, current => current.life.routine?.picked === true);
  const foot = { ...state.clearing.position };
  noticeForestDirector(state); assert.equal(state.pendingAttention, true);
  advance(state, .3); const cleanup = state.life.routine.interrupting.elapsed;
  noticeForestDirector(state); assert.equal(state.life.routine.interrupting.elapsed, cleanup);
  advance(state, .3);
  assert.equal(state.life.routine, null); assert.equal(state.pendingAttention, false);
  assert.equal(clearingActivityFrame(state.clearing).attention, true);
  assert.deepEqual(state.clearing.position, foot);
  assert.equal(state.life.mushrooms[0].growth, 1, "an untouched cap is returned rather than consumed or duplicated");
  assert.equal(state.life.mushrooms.length, 1);
});

test("tapping a perched individual releases the hero once while the same insect keeps departing", () => {
  const state = create(); requestForestDirective(state, "butterfly", calm);
  until(state, current => current.fauna.encounter?.phase === "perch");
  const body = state.fauna.entities.find(entity => entity.id === state.fauna.encounter.entityId);
  const foot = { ...state.clearing.position }, bodyAt = { x: body.x, y: body.y };
  noticeForestDirector(state); assert.equal(state.pendingAttention, true);
  assert.deepEqual({ x: body.x, y: body.y }, bodyAt);
  advance(state, .3); const phaseElapsed = state.fauna.encounter.phaseElapsed;
  noticeForestDirector(state); assert.equal(state.fauna.encounter.phaseElapsed, phaseElapsed);
  advance(state, .3);
  assert.equal(state.fauna.encounter, null); assert.equal(state.pendingAttention, false);
  assert.equal(clearingActivityFrame(state.clearing).attention, true);
  assert.equal(body.mode, "depart"); assert.equal(state.life.routine, null);
  assert.deepEqual(state.clearing.position, foot);
  assert.equal(state.fauna.entities.find(entity => entity.id === body.id), body);
});

test("replacing a prop action waits for cleanup and never gives both interactions the actor", () => {
  const state = create({ navigation: undefined }); requestForestDirective(state, "leaf", calm);
  until(state, current => current.life.routine?.picked === true);
  requestForestDirective(state, "butterfly", calm);
  assert.equal(state.pendingLife, "butterfly"); assert.ok(state.life.routine.interrupting);
  advance(state, 1, calm, () => assert.equal(Boolean(state.life.routine && state.fauna.encounter), false));
  assert.equal(state.life.routine, null); assert.equal(state.fauna.encounter?.kind, "butterfly", JSON.stringify({ reason: state.director.reason, pending: state.pendingLife, stage: state.clearing.stage }));
});

test("reduced motion freezes the complete coordinator state and a static tap detaches a perched body in place", () => {
  const state = create(); requestForestDirective(state, "butterfly", calm);
  until(state, current => current.fauna.encounter?.phase === "perch");
  const frozen = structuredClone(state);
  advance(state, 10, { ...calm, reducedMotion: true }); assert.deepEqual(state, frozen);
  const bodies = state.fauna.entities.map(({ id, x, y }) => ({ id, x, y }));
  noticeForestDirector(state, true);
  assert.equal(state.fauna.encounter, null); assert.equal(state.pendingAttention, false);
  assert.deepEqual(state.fauna.entities.map(({ id, x, y }) => ({ id, x, y })), bodies);
  const staticState = structuredClone(state);
  advance(state, 5, { ...calm, reducedMotion: true }); assert.deepEqual(state, staticState);
});

test("manual cancellation releases a pending approach without moving either actor or wildlife", () => {
  const state = create(); requestForestDirective(state, "mushroom", calm); advance(state, 1);
  assert.equal(state.pendingLife, "mushroom"); assert.ok(state.clearing.requestedPoint);
  const foot = { ...state.clearing.position }, bodies = state.fauna.entities.map(({ id, x, y }) => ({ id, x, y }));
  cancelForestDirector(state);
  assert.equal(state.pendingLife, null); assert.equal(state.clearing.requestedPoint, null); assert.equal(state.director.target, null);
  assert.deepEqual(state.clearing.position, foot);
  assert.deepEqual(state.fauna.entities.map(({ id, x, y }) => ({ id, x, y })), bodies);
  advance(state, 2); assert.deepEqual(state.clearing.position, foot);
});

test("shared camera ownership preserves the same coordinator, reservation and entity objects", () => {
  const circle = connectForestSession("director-handoff", fixture, "circle", 100, 0, () => {});
  const world = connectForestSession("director-handoff", fixture, "world", 9000, 1, () => {});
  try {
    circle.configure("circle", true); requestForestDirective(circle.state, "butterfly", calm); advance(circle.state, 1);
    const reservation = circle.state.fauna.encounter, bodies = [...circle.state.fauna.entities], frame = structuredClone(circle.state.fauna);
    world.configure("world", true);
    assert.equal(circle.isOwner(), false); assert.equal(world.isOwner(), true); assert.equal(world.state, circle.state);
    assert.equal(world.state.fauna.encounter, reservation); assert.deepEqual(world.state.fauna, frame);
    world.state.fauna.entities.forEach((body, index) => assert.equal(body, bodies[index]));
    world.configure("world", false); assert.equal(circle.isOwner(), true);
    assert.equal(circle.state.fauna.encounter, reservation);
  } finally { world.release(); circle.release(); }
});

test("DEV route comparison returns physically to spawn before switching navigation ownership", () => {
  const state = create({ habitats: [], mushrooms: [] }); state.life.leaf = null;
  assert.equal(requestClearingPoint(state.clearing, { x: 220, y: 210 }), true);
  advance(state, 1, { ...calm, autoLife: true }); const before = { ...state.clearing.position };
  assert.ok(distance(before, fixture.actor.spawn) > 1);
  let previous = before;
  until(state, current => current.clearing.navigationEnabled === false, 20, { ...calm, autoLife: true, navigationMode: "routes" });
  assert.ok(distance(state.clearing.position, fixture.actor.spawn) < 1);
  advance(state, 8, { ...calm, autoLife: true, navigationMode: "routes" }, () => {
    assert.equal(state.clearing.navigationEnabled, false);
    previous = { ...state.clearing.position };
  });
  assert.ok(distance(previous, fixture.actor.spawn) > 1, "the legacy authored route remains available");
  until(state, current => current.clearing.navigationEnabled === true, 20, { ...calm, autoLife: true, navigationMode: "auto" });
  assert.ok(distance(state.clearing.position, fixture.actor.spawn) < 1);
});

test("switching to legacy routes cannot start a distant mushroom pickup at spawn", () => {
  const state = create(); requestForestDirective(state, "mushroom", calm); advance(state, 1);
  assert.equal(state.pendingLife, "mushroom"); assert.equal(state.life.mushrooms[0].reachable, false);
  const legacy = { ...calm, navigationMode: "routes" };
  until(state, current => !current.clearing.navigationEnabled, 20, legacy);
  advance(state, 2, legacy);
  assert.equal(state.pendingLife, null); assert.equal(state.life.routine, null);
  assert.equal(state.life.mushrooms[0].growth, 1); assert.equal(state.life.mushrooms[0].regrowIn, 0);
  assert.ok(distance(state.clearing.position, fixture.actor.spawn) < .5);
});

const homeSite = { id: "home", label: "Home", bounds: { x: 140, y: 110, width: 50, height: 45 },
  anchor: { x: 165, y: 150 }, entry: { x: 165, y: 155 }, doorway: { x: 165, y: 145 },
  hitArea: rectangle(140, 110, 50, 45), collision: rectangle(155, 120, 25, 26), initialLevel: 1, states: [] };
const homePath = { id: "home-approach", behavior: "home", siteId: "home", points: [{ x: 150, y: 165 }, { x: 165, y: 155 }] };

test("autonomous stationary props preserve the visible inactivity clock and allow home sleep", () => {
  const state = create({ navigation: undefined, habitats: [], sites: [homeSite], paths: [homePath],
    mushrooms: [{ id: "near-mushroom", position: { x: 155, y: 170 } }] });
  const options = { ...calm, autoLife: true, homeAvailable: true };
  let sawRoutine = false, previousIdle = 0;
  advance(state, 240, options, () => {
    if (state.life.routine) sawRoutine = true;
    assert.ok(state.clearing.idleSeconds >= previousIdle, "autonomous props cannot act as user activity");
    previousIdle = state.clearing.idleSeconds;
  });
  assert.ok(sawRoutine); assert.equal(clearingActivityFrame(state.clearing).homeSleeping, true);
});

test("a prop requested indoors waits for the physical exit before any pickup", () => {
  const state = create({ sites: [homeSite], paths: [homePath], habitats: [] });
  const options = { ...calm, homeAvailable: true };
  requestForestDirective(state, "home-sleep", options);
  until(state, current => clearingActivityFrame(current.clearing).homeSleeping, 20, options);
  assert.equal(clearingActivityFrame(state.clearing).opacity, 0);
  requestForestDirective(state, "leaf", options);
  let previous = { ...state.clearing.position }, sawExit = false;
  for (let elapsed = 0; elapsed < 30 && !state.life.routine; elapsed += .025) {
    advanceForestDirector(state, .025, options);
    const frame = clearingActivityFrame(state.clearing);
    if (frame.residing) assert.equal(state.life.routine, null);
    if (frame.opacity > 0) sawExit = true;
    assert.ok(distance(state.clearing.position, previous) < 1.5, "the doorway exit remains continuous");
    previous = { ...state.clearing.position };
  }
  assert.ok(sawExit); assert.equal(state.life.routine?.kind, "leaf");
  assert.equal(clearingActivityFrame(state.clearing).residing, false);
});

test("the exported living clearing can settle into home sleep after five active minutes", async () => {
  const { TILED_WORLD } = await vite.ssrLoadModule("/features/world/presentation.ts");
  const state = create(TILED_WORLD); state.clearing.seed = 41;
  const options = { ...calm, autoLife: true, homeAvailable: true };
  until(state, current => clearingActivityFrame(current.clearing).homeSleeping, 300, options);
  assert.equal(state.life.routine, null); assert.equal(state.fauna.encounter, null);
});

test("an indoor butterfly request exits once without repeated attention or replacement participants", async () => {
  const { TILED_WORLD } = await vite.ssrLoadModule("/features/world/presentation.ts");
  const state = create(TILED_WORLD), options = { ...calm, homeAvailable: true };
  requestForestDirective(state, "home-sleep", options);
  until(state, current => clearingActivityFrame(current.clearing).homeSleeping, 30, options);
  const bodies = [...state.fauna.entities], ids = bodies.map(body => body.id);
  const sleepingAt = { ...state.clearing.position };
  requestForestDirective(state, "butterfly", options);
  assert.deepEqual(state.clearing.position, sleepingAt, "the request itself never teleports the sleeping resident");
  let previous = sleepingAt, wasAttentive = false, attentionEpisodes = 0;
  for (let elapsed = 0; elapsed < 36 && state.pendingLife; elapsed += .025) {
    advanceForestDirector(state, .025, options);
    const frame = clearingActivityFrame(state.clearing);
    if (frame.attention && !wasAttentive) attentionEpisodes++;
    wasAttentive = frame.attention;
    assert.ok(distance(state.clearing.position, previous) <= state.clearing.size * .36 * .025 + 1e-7,
      "leaving the doorway and returning to the clearing retain bounded displacement");
    previous = { ...state.clearing.position };
    assert.deepEqual(state.fauna.entities.map(body => body.id), ids);
    state.fauna.entities.forEach((body, index) => assert.equal(body, bodies[index]));
    assert.equal(state.life.routine, null, "an indoor request cannot create a transient insect routine");
  }
  assert.equal(state.pendingLife, null, "the requested meeting resolves after the safe exit");
  assert.ok(attentionEpisodes <= 1, "resident ticks cannot restart greeting sequences during the same exit");
  assert.equal(clearingActivityFrame(state.clearing).residing, false);
  if (state.fauna.encounter) {
    assert.equal(state.fauna.encounter.kind, "butterfly");
    assert.ok(ids.includes(state.fauna.encounter.entityId));
    assert.equal(state.fauna.sequence, 1);
  } else {
    assert.ok(state.fauna.lastReason, "without a suitable participant the request explains why it ended");
    assert.equal(state.director.reason, state.fauna.lastReason);
  }
});
