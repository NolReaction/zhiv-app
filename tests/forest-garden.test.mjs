import assert from "node:assert/strict";
import { withPlacedBushArtwork } from "./helpers/forest-bush-fixture.mjs";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root,
  resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false } });
after(() => vite.close());
const { createForestGarden, advanceForestGarden, gardenActionAvailable, growForestBerries, cancelForestGarden } =
  await vite.ssrLoadModule("/features/world/forest-garden.ts");
const { requestForestDirective, advanceForestDirector, noticeForestDirector, cancelForestDirector } =
  await vite.ssrLoadModule("/features/world/forest-director.ts");
const { connectForestSession } = await vite.ssrLoadModule("/features/world/forest-session.ts");
const { TILED_WORLD } = await vite.ssrLoadModule("/features/world/presentation.ts");
const { previewWorldScene } = await vite.ssrLoadModule("/features/world/tiled/preview-state.ts");
const { isWalkable, createWorldNavigation } = await vite.ssrLoadModule("/features/world/navigation.ts");
const { isForestGroundClear } = await vite.ssrLoadModule("/features/world/forest-ground-weather.ts");
const calm = { autoLife: false, blocked: false, dusk: 0, rain: 0, homeAvailable: true };
function scene(level = 1, size = 50) {
  const map = withPlacedBushArtwork(previewWorldScene(TILED_WORLD, { home: level })); map.actor.size = size; return map;
}
function create(level = 1, size = 50) {
  const session = connectForestSession(undefined, scene(level, size), "circle", 0, 0, () => {});
  session.release(); return session.state;
}
function advance(state, seconds, options = calm, inspect) {
  for (let elapsed = 0; elapsed < seconds - 1e-9; elapsed += .025) {
    advanceForestDirector(state, Math.min(.025, seconds - elapsed), options); inspect?.(state);
  }
}
function until(state, predicate, seconds = 90, options = calm, inspect) {
  for (let elapsed = 0; elapsed < seconds && !predicate(state); elapsed += .025) {
    advanceForestDirector(state, .025, options); inspect?.(state);
  }
  assert.ok(predicate(state), `condition not reached: ${state.director.reason}, ${state.clearing.stage}, ${JSON.stringify(state.life.garden.routine)}`);
}
const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

test("actual DEV scale rejects unreachable care and resizing mid-harvest preserves the crop", () => {
  for (const heroScale of [.5, 2]) for (const kind of ["water-bush", "harvest-berries"]) {
    const state = create();
    if (kind === "harvest-berries") growForestBerries(state.life.garden);
    const feet = { ...state.clearing.position };
    requestForestDirective(state, kind, { ...calm, heroScale });
    advance(state, .2, { ...calm, heroScale });
    assert.equal(state.life.garden.routine, null);
    assert.match(state.director.reason, /текущим размером/);
    assert.equal(state.life.garden.basket.berries, 0);
    assert.deepEqual(state.clearing.position, feet);
  }
  for (const heroScale of [1, 1.12]) {
    const state = create(), settings = { ...calm, heroScale };
    growForestBerries(state.life.garden);
    requestForestDirective(state, "harvest-berries", settings);
    until(state, current => current.life.garden.routine?.phase === "collect", 90, settings);
    const feet = { ...state.clearing.position };
    advance(state, .025, { ...settings, heroScale: .5 });
    assert.equal(state.life.garden.routine, null);
    assert.equal(state.life.garden.bushes[0].growth, 1);
    assert.equal(state.life.garden.basket.berries, 0);
    assert.deepEqual(state.clearing.position, feet);
  }
});

test("garden reuses authored bushes and places its basket clear of every house level and route", () => {
  for (const level of [1, 2, 3, 4, 5]) for (const size of [50, 56]) {
    const map = scene(level, size), garden = createForestGarden(map), basket = garden.basket;
    assert.equal(garden.bushes.length, map.bushes.length); assert.ok(basket, `level ${level}, size ${size}`);
    assert.deepEqual(garden.bushes[0].position, map.bushes[0].entry);
    assert.notEqual(garden.bushes[0].position, map.bushes[0].entry);
    assert.ok(isForestGroundClear(map, basket.position, size * .085));
    assert.ok(isWalkable(createWorldNavigation(map), basket.position));
    assert.ok(isWalkable(createWorldNavigation(map), basket.approach));
  }
  const unavailable = scene(); unavailable.navigation = undefined;
  assert.equal(createForestGarden(unavailable).bushes.length, unavailable.bushes.length);
  assert.equal(createForestGarden(unavailable).bushes[0].workPosition, null);
  assert.equal(createForestGarden(unavailable).basket, null);
  assert.equal(gardenActionAvailable(createForestGarden(unavailable), "water-bush"), false);
});

test("berries grow over active minutes, rain waters, dry bushes survive, and cooldown cannot be spammed", () => {
  const dry = createForestGarden(scene()), wet = structuredClone(dry);
  dry.bushes[0].growth = 0; dry.bushes[0].moisture = 0;
  wet.bushes[0].growth = 0; wet.bushes[0].moisture = 1; wet.bushes[0].waterIn = 600;
  const frozen = structuredClone(dry);
  for (const dt of [0, -1, NaN, Infinity]) advanceForestGarden(dry, dt, { rain: 1 });
  assert.deepEqual(dry, frozen);
  for (let i = 0; i < 6000; i++) {
    advanceForestGarden(dry, .1, { rain: 0 }); advanceForestGarden(wet, .1, { rain: 1 });
  }
  assert.ok(dry.bushes[0].growth > .16 && dry.bushes[0].growth < .17);
  assert.ok(wet.bushes[0].growth > .33 && wet.bushes[0].growth < .34);
  assert.equal(dry.bushes[0].moisture, 0); assert.equal(wet.bushes[0].moisture, 1);
  assert.ok(wet.bushes[0].waterIn < .001); assert.equal(gardenActionAvailable(wet, "water-bush"), false);
  assert.equal(gardenActionAvailable(dry, "water-bush"), true);
  const before = dry.bushes[0].growth;
  advanceForestGarden(dry, 36000, { rain: 0 });
  assert.ok(dry.bushes[0].growth - before < .001, "a wall-time gap is not offline growth");
});

test("water action reaches a safe point near the foliage before pouring and commits moisture only once", () => {
  const state = create(), garden = state.life.garden;
  requestForestDirective(state, "water-bush", calm);
  let previous = { ...state.clearing.position }, sawWater = false;
  until(state, current => current.director.recent.some(item => item.key.startsWith("water-bush:")), 60, calm, () => {
    assert.ok(distance(state.clearing.position, previous) < 1.5, "movement stays continuous");
    assert.ok(isWalkable(state.clearing.navigation, state.clearing.position));
    if (garden.routine?.phase === "water") {
      sawWater = true; assert.ok(distance(state.clearing.position, garden.bushes[0].workPosition) < .5);
      assert.ok(garden.bushes[0].moisture < .58, "nothing commits before pouring is finished");
    }
    previous = { ...state.clearing.position };
  });
  assert.ok(sawWater); assert.ok(garden.bushes[0].moisture > .99);
  assert.ok(garden.bushes[0].waterIn > 590); assert.equal(garden.routine, null);
  requestForestDirective(state, "water-bush", calm); advance(state, .1);
  assert.equal(garden.routine, null); assert.equal(state.pendingLife, null);
  assert.match(state.director.reason, /уже полит/);
});

test("each of five houses with size 50 and 56 supports the full berry round trip without teleports or duplicate deposits", () => {
  for (const level of [1, 2, 3, 4, 5]) for (const size of [50, 56]) {
    const state = create(level, size), garden = state.life.garden, phases = new Set(); growForestBerries(garden);
    const destination = { ...garden.basket.homePosition }; let previous = { ...state.clearing.position };
    requestForestDirective(state, "harvest-berries", calm);
    until(state, current => current.director.recent.some(item => item.key.startsWith("harvest-berries:")), 90, calm, () => {
      assert.ok(distance(state.clearing.position, previous) < 1.5, `level ${level}, size ${size}: continuous walking`);
      assert.ok(isWalkable(state.clearing.navigation, state.clearing.position));
      if (garden.routine) phases.add(garden.routine.phase);
      if (garden.routine?.phase === "collect" || garden.routine?.phase === "return-basket") {
        assert.equal(garden.basket.berries, 0); assert.equal(garden.bushes[0].growth, 1);
      }
      previous = { ...state.clearing.position };
    });
    for (const phase of ["approach-basket", "take-basket", "approach-bush", "collect", "return-basket", "deposit", "settle"]) assert.ok(phases.has(phase), phase);
    assert.equal(garden.basket.berries, 3); assert.ok(garden.bushes[0].growth < .001);
    assert.deepEqual(garden.basket.position, destination); assert.equal(state.clearing.requestedPoint, null);
    advance(state, 3); assert.equal(garden.basket.berries, 3);
  }
});

test("interrupting before deposit restores the untouched harvest and drops the same basket at real feet", () => {
  for (const phase of ["take-basket", "approach-bush", "collect", "return-basket", "deposit"]) {
    const state = create(), garden = state.life.garden; growForestBerries(garden);
    requestForestDirective(state, "harvest-berries", calm);
    until(state, () => garden.routine?.phase === phase);
    const foot = { ...state.clearing.position }, carrying = garden.routine.carryingBasket;
    noticeForestDirector(state); noticeForestDirector(state);
    assert.deepEqual(state.clearing.position, foot); assert.equal(garden.routine, null);
    assert.equal(garden.basket.berries, 0); assert.equal(garden.bushes[0].growth, 1);
    if (carrying) assert.deepEqual(garden.basket.position, foot);
    advance(state, 3); assert.equal(state.pendingAttention, false);
    requestForestDirective(state, "harvest-berries", calm);
    until(state, () => garden.basket.berries === 3);
    assert.ok(garden.bushes[0].growth < .001); assert.deepEqual(garden.basket.position, garden.basket.homePosition);
  }
});

test("full baskets and inaccessible bushes fail cleanly without consuming the crop", () => {
  for (const failure of ["full", "blocked", "routes", "rain"]) {
    const state = create(), garden = state.life.garden; growForestBerries(garden);
    if (failure === "full") garden.basket.berries = 12;
    if (failure === "blocked") garden.bushes[0].workPosition = { x: 0, y: 0 };
    const options = { ...calm, ...(failure === "routes" ? { navigationMode: "routes" } : {}), ...(failure === "rain" ? { rain: 1 } : {}) };
    requestForestDirective(state, "harvest-berries", options); advance(state, .2, options);
    assert.equal(state.pendingLife, null); assert.equal(garden.routine, null); assert.equal(garden.bushes[0].growth, 1);
    assert.equal(garden.basket.berries, failure === "full" ? 12 : 0);
    assert.equal(state.clearing.requestedPoint, null); assert.ok(state.director.reason.length);
  }
});

test("manual pose freezes work, reduced motion freezes the whole cycle, cancellation preserves the crop", () => {
  const state = create(), garden = state.life.garden; growForestBerries(garden);
  requestForestDirective(state, "harvest-berries", calm); until(state, () => garden.routine?.phase === "collect");
  const frozen = structuredClone(state); advance(state, 2, { ...calm, reducedMotion: true }); assert.deepEqual(state, frozen);
  const work = structuredClone(garden.routine), foot = { ...state.clearing.position };
  advance(state, 2, { ...calm, blocked: true });
  assert.deepEqual(garden.routine, work); assert.deepEqual(state.clearing.position, foot);
  cancelForestDirector(state); assert.equal(garden.routine, null); assert.equal(garden.basket.berries, 0);
  assert.equal(garden.bushes[0].growth, 1); assert.equal(state.clearing.requestedPoint, null);
});

test("a deposit remains committed when interrupted during settle; cancelling a completed action cannot pay twice", () => {
  const state = create(), garden = state.life.garden; growForestBerries(garden);
  requestForestDirective(state, "harvest-berries", calm); until(state, () => garden.routine?.phase === "settle");
  noticeForestDirector(state); cancelForestGarden(garden, state.clearing.position);
  assert.equal(garden.basket.berries, 3); assert.ok(garden.bushes[0].growth < .001);
  advance(state, 3); assert.equal(garden.basket.berries, 3);
});

test("a care request from each house waits for a physical exit before starting work", () => {
  for (const level of [1, 2, 3, 4, 5]) {
    const state = create(level); requestForestDirective(state, "home-sleep", calm);
    until(state, current => current.clearing.stage === "home-sleep");
    const origin = { ...state.clearing.position }; requestForestDirective(state, "water-bush", calm);
    assert.deepEqual(state.clearing.position, origin);
    let sawExit = false, previous = origin;
    until(state, current => current.director.recent.some(item => item.key.startsWith("water-bush:")), 90, calm, () => {
      assert.ok(distance(state.clearing.position, previous) < 1.5);
      if (state.clearing.stage.includes("exit")) sawExit = true;
      if (state.life.garden.routine) assert.equal(state.clearing.routeKind, "clearing");
      previous = { ...state.clearing.position };
    });
    assert.ok(sawExit);
  }
});

test("autonomy chooses useful care in calm daytime but leaves it alone at night, rain or fatigue", () => {
  const active = create(); active.director.seed = 555; const garden = active.life.garden;
  until(active, current => current.director.recent.some(item => item.key.startsWith("water-bush:")), 120,
    { ...calm, autoLife: true });
  assert.ok(garden.bushes[0].moisture > .9);
  for (const constraint of ["night", "rain", "tired"]) {
    const state = create(); growForestBerries(state.life.garden);
    if (constraint === "tired") state.clearing.behavior.mind.needs.energy = .15;
    const options = { ...calm, autoLife: true, ...(constraint === "night" ? { dusk: 1 } : {}), ...(constraint === "rain" ? { rain: .6 } : {}) };
    advance(state, 20, options, () => assert.equal(state.life.garden.routine, null, constraint));
    assert.equal(state.life.garden.basket.berries, 0);
  }
});

test("capacity bounds repeated DEV harvests and leaves a fifth crop on its bush", () => {
  const state = create(), garden = state.life.garden;
  for (let round = 1; round <= 4; round++) {
    requestForestDirective(state, "grow-berries", calm);
    requestForestDirective(state, "harvest-berries", calm);
    until(state, () => garden.basket.berries === round * 3);
    until(state, () => garden.routine === null);
  }
  requestForestDirective(state, "grow-berries", calm); requestForestDirective(state, "harvest-berries", calm); advance(state, 2);
  assert.equal(garden.basket.berries, 12); assert.equal(garden.bushes[0].growth, 1);
  assert.equal(garden.routine, null); assert.match(state.director.reason, /наполнена/);
});

test("camera ownership shares one growing bush and one unfinished basket journey", () => {
  const map = scene(), circle = connectForestSession("garden-handoff", map, "circle", 0, 0, () => {});
  const world = connectForestSession("garden-handoff", map, "world", 1, 0, () => {});
  try {
    circle.configure("circle", true); growForestBerries(circle.state.life.garden);
    requestForestDirective(circle.state, "harvest-berries", calm);
    until(circle.state, current => current.life.garden.routine?.phase === "return-basket");
    const garden = circle.state.life.garden, routine = garden.routine, before = structuredClone(garden);
    world.configure("world", true);
    assert.equal(circle.isOwner(), false); assert.equal(world.isOwner(), true);
    assert.equal(world.state.life.garden, garden); assert.equal(world.state.life.garden.routine, routine);
    assert.deepEqual(garden, before);
    until(world.state, current => current.life.garden.basket.berries === 3);
    world.configure("world", false); assert.equal(circle.isOwner(), true);
    assert.equal(circle.state.life.garden.basket.berries, 3);
  } finally { world.release(); circle.release(); }
});
