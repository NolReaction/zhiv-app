import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root,
  resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false } });
after(() => vite.close());
const { createBuilderMind, advanceBuilderMind, builderMindFrame, builderSleepIndicator, rehydrateBuilderMind,
  requestBuilderVisit, noticeBuilderMind } = await vite.ssrLoadModule("/features/world/characters/builder/builder-mind.ts");
const { builderLocalPlaces, builderWorkStops } = await vite.ssrLoadModule("/features/world/characters/builder/builder-navigation.ts");
const { canTraverse, isWalkable } = await vite.ssrLoadModule("/features/world/navigation/navigation.ts");
const { BUILDER } = await vite.ssrLoadModule("/features/world/characters/builder/builder-types.ts");
const { TILED_WORLD } = await vite.ssrLoadModule("/features/world/scene/presentation.ts");
const { previewWorldScene, initialPreviewLevels } = await vite.ssrLoadModule("/features/world/tiled/preview-state.ts");
const rect = (x, y, width, height) => [{ x, y }, { x: x + width, y }, { x: x + width, y: y + height }, { x, y: y + height }];
const start = Date.parse("2026-10-07T22:00:00Z"), finish = start + 3600_000;
const order = { id: "confirmed", stationId: "home", targetLevel: 2,
  startedAt: new Date(start).toISOString(), finishesAt: new Date(finish).toISOString() };
const snapshot = (jobs = [], revision = 1) => ({ ownerPublicId: "builder-owner", revision, jobs });
const environment = (extra = {}) => ({ now: start, night: true, construction: snapshot(), ...extra });
const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
function fixture() {
  const home = { bounds: { x: 220, y: 40, width: 90, height: 105 }, anchor: { x: 265, y: 90 },
    entry: { x: 265, y: 150 }, doorway: { x: 265, y: 125 }, hitArea: rect(220, 40, 90, 105), collision: rect(225, 50, 80, 90) };
  const own = { bounds: { x: 40, y: 30, width: 60, height: 70 }, anchor: { x: 70, y: 80 },
    entry: { x: 70, y: 110 }, doorway: { x: 70, y: 80 }, hitArea: rect(40, 30, 60, 70), collision: rect(50, 45, 40, 50) };
  return { schemaVersion: 1, id: "builder-house-test", width: 360, height: 280, terrain: [], paths: [],
    focus: { x: 0, y: 0, width: 360, height: 280 }, actor: { spawn: { x: 270, y: 235 }, size: 40 },
    sites: [{ id: "home", label: "Дом", initialLevel: 1, ...home,
      states: [{ level: 1, image: "/home.webp" }, { level: 2, image: "/home-2.webp", geometry: structuredClone(home) }] },
    { id: "builder-home", label: "Дом Шишколапа", initialLevel: 1, ...own, states: [{ level: 1, image: "/builder-home.png" }] }],
    destinations: [{ id: "builder-rest", position: { x: 65, y: 205 } }],
    navigation: { version: 1, cellSize: 6, areas: [{ id: "land", points: rect(0, 0, 360, 280) }],
      obstacles: [{ id: "wall", points: rect(145, 30, 12, 145) }], interests: [{ id: "look", position: { x: 290, y: 200 } }] } };
}
function step(mind, scene, env = environment(), dt = .1) {
  const before = { ...mind.position }, phase = mind.sleepPhase;
  advanceBuilderMind(mind, scene, dt, env);
  assert.ok(distance(before, mind.position) <= BUILDER.speed * dt + 1e-6, "each visible step is continuous");
  if (mind.available && ![phase, mind.sleepPhase].some(value => ["enter", "sleep", "exit"].includes(value))) {
    assert.ok(canTraverse(builderLocalPlaces(scene).navigation, before, mind.position), "ordinary routes keep the house collider");
  }
}
function until(mind, scene, predicate, env = environment(), seconds = 60) {
  for (let elapsed = 0; elapsed < seconds && !predicate(mind); elapsed += .1) step(mind, scene, env);
  assert.ok(predicate(mind), `state reached within ${seconds}s; actual ${mind.sleepPhase}/${mind.action}`);
}

test("the builder approaches his own house, fades at its validated door, sleeps hidden and walks outside at dawn", () => {
  const scene = fixture(), mind = createBuilderMind(scene), places = builderLocalPlaces(scene), seen = new Set();
  assert.ok(places.home); assert.equal(isWalkable(places.navigation, places.home.doorway), false);
  assert.equal(canTraverse(places.navigation, places.home.entry, places.home.doorway), false, "shared navigation never gains a hole");
  for (let i = 0; i < 200 && mind.sleepPhase !== "sleep"; i++) {
    step(mind, scene); seen.add(mind.sleepPhase);
    const frame = builderMindFrame(mind, scene, false);
    if (mind.sleepPhase === "enter") {
      assert.ok(frame.opacity >= 0 && frame.opacity <= 1);
      assert.equal(requestBuilderVisit(mind, scene, { id: "mochlik", position: { x: 110, y: 125 }, size: 40 }), false);
      noticeBuilderMind(mind); assert.equal(mind.noticePending, false);
    }
  }
  assert.deepEqual([...seen], ["approach", "enter", "sleep"]);
  assert.deepEqual(mind.position, places.home.doorway); assert.equal(builderMindFrame(mind, scene, false), null);
  const cue = builderSleepIndicator(mind, scene); assert.equal(cue.x, places.home.doorway.x); assert.equal(cue.y, places.home.doorway.y);
  const position = { ...mind.position };
  for (let i = 0; i < 100; i++) step(mind, scene);
  assert.deepEqual(mind.position, position); assert.equal(mind.job, null);
  advanceBuilderMind(mind, scene, 0, environment({ night: false }));
  assert.equal(mind.sleepPhase, "exit"); assert.deepEqual(mind.position, position);
  until(mind, scene, mind => mind.sleepPhase === "awake", environment({ night: false }));
  assert.deepEqual(mind.position, places.home.entry); assert.ok(builderMindFrame(mind, scene, false));
  until(mind, scene, mind => !mind.route, environment({ night: false }));
  assert.deepEqual(mind.position, places.rest.position);
});

test("a confirmed order interrupts every sleep stage from actual feet; ready work stays assigned until claim", () => {
  for (const phase of ["approach", "enter", "sleep", "exit"]) {
    const scene = fixture(), mind = createBuilderMind(scene);
    until(mind, scene, mind => mind.sleepPhase === (phase === "exit" ? "sleep" : phase));
    if (phase === "exit") step(mind, scene, environment({ night: false }));
    if (phase === "enter") step(mind, scene);
    const position = { ...mind.position }, env = environment({ construction: snapshot([order], 2), now: finish });
    advanceBuilderMind(mind, scene, 0, env);
    assert.deepEqual(mind.position, position); assert.equal(mind.job.id, order.id);
    if (["enter", "sleep", "exit"].includes(phase)) assert.equal(mind.sleepPhase, "exit");
    until(mind, scene, mind => mind.sleepPhase === "awake" && !mind.route && !mind.blocked, env);
    assert.equal(mind.ready, true); assert.equal(mind.action, "idle");
    assert.ok(builderWorkStops(scene, order).some(stop => distance(stop.position, mind.position) < .001));
    const working = { ...mind.position };
    for (let i = 0; i < 100; i++) step(mind, scene, env);
    assert.deepEqual(mind.position, working); assert.equal(mind.sleepPhase, "awake");
    until(mind, scene, mind => mind.sleepPhase === "sleep", environment({ construction: snapshot([], 3), now: finish }));
  }
});

test("a sleeping builder waits inside an occupied exit and only fades out into clear resident space", () => {
  const scene = fixture(), mind = createBuilderMind(scene), home = builderLocalPlaces(scene).home;
  until(mind, scene, mind => mind.sleepPhase === "sleep");
  const env = environment({ night: false, occupants: [{ id: "mochlik", position: home.entry, size: 40 }] });
  for (let i = 0; i < 50; i++) step(mind, scene, env);
  assert.equal(mind.sleepPhase, "exit"); assert.equal(mind.sleepProgress, 1); assert.deepEqual(mind.position, home.doorway);
  assert.equal(builderMindFrame(mind, scene, false), null); assert.equal(mind.trafficWaiting, true);
  until(mind, scene, mind => mind.sleepPhase === "awake", environment({ night: false }));
});

test("cold authoritative jobs keep their exterior restoration while empty cold entry walks to bed", () => {
  const scene = fixture();
  for (const now of [start, finish]) {
    const mind = createBuilderMind(scene, { awaitConstruction: true });
    advanceBuilderMind(mind, scene, 1, environment({ construction: null, now }));
    assert.equal(mind.constructionPending, true); assert.equal(builderMindFrame(mind, scene, false), null);
    advanceBuilderMind(mind, scene, 0, environment({ construction: snapshot([order]), now }));
    assert.equal(mind.sleepPhase, "awake"); assert.deepEqual(mind.position, mind.target.position); assert.equal(mind.route, null);
    assert.equal(mind.action, now === finish ? "idle" : "work");
  }
  const mind = createBuilderMind(scene, { awaitConstruction: true }), before = { ...mind.position };
  advanceBuilderMind(mind, scene, 0, environment());
  assert.deepEqual(mind.position, before); assert.equal(mind.sleepPhase, "approach");
  until(mind, scene, mind => mind.sleepPhase === "sleep");
});

test("sleep and partial doorway progress survive geometry snapshots and local hydration without restoring stale jobs", () => {
  for (const phase of ["enter", "sleep", "exit"]) {
    const scene = fixture(), mind = createBuilderMind(scene);
    until(mind, scene, mind => mind.sleepPhase === (phase === "exit" ? "sleep" : phase));
    if (phase === "exit") step(mind, scene, environment({ night: false }));
    else if (phase === "enter") step(mind, scene);
    const position = { ...mind.position }, progress = mind.sleepProgress, changed = structuredClone(scene);
    const env = environment({ night: phase !== "exit" });
    advanceBuilderMind(mind, changed, 0, env);
    assert.equal(mind.available, true); assert.deepEqual(mind.position, position); assert.equal(mind.sleepProgress, progress);
    const restored = rehydrateBuilderMind(changed, mind);
    advanceBuilderMind(restored, changed, 0, env);
    assert.equal(restored.available, true); assert.deepEqual(restored.position, position);
    assert.equal(restored.sleepPhase, phase); assert.equal(restored.sleepProgress, progress);
    advanceBuilderMind(restored, changed, 0, environment({ construction: snapshot([order]) }));
    assert.deepEqual(restored.position, position); assert.equal(restored.sleepPhase, "exit");
    until(restored, changed, mind => mind.action === "work", environment({ construction: snapshot([order]) }));
  }
});

test("invalid private door corridors never bypass other blockers or teleport a sleeping builder", () => {
  for (const mutate of [
    scene => scene.navigation.obstacles.push({ id: "threshold-blocker", points: rect(66, 98, 8, 3) }),
    scene => { scene.sites[1].doorway = { x: 70, y: 170 }; },
    scene => { scene.sites[1].entry = { x: 70, y: 90 }; },
    scene => { scene.sites[1].doorway.x = NaN; },
  ]) {
    const scene = fixture(); mutate(scene);
    assert.equal(builderLocalPlaces(scene).home, null);
    const mind = createBuilderMind(scene);
    for (let i = 0; i < 100; i++) step(mind, scene);
    assert.equal(mind.sleepPhase, "awake");
  }
  const scene = fixture(), mind = createBuilderMind(scene);
  until(mind, scene, mind => mind.sleepPhase === "sleep");
  const position = { ...mind.position }, blocked = structuredClone(scene);
  blocked.navigation.obstacles.push({ id: "threshold-blocker", points: rect(66, 98, 8, 3) });
  advanceBuilderMind(mind, blocked, .1, environment());
  assert.deepEqual(mind.position, position); assert.equal(mind.available, false); assert.equal(builderMindFrame(mind, blocked, false), null);
  const hydrated = rehydrateBuilderMind(blocked, mind);
  advanceBuilderMind(hydrated, blocked, .1, environment());
  assert.deepEqual(hydrated.position, position); assert.equal(hydrated.available, false);
  advanceBuilderMind(hydrated, scene, 0, environment());
  assert.equal(hydrated.available, true); assert.deepEqual(hydrated.position, position);
});

test("zero-delta and reduced-motion reads do not advance sleep, door fades, or offline clocks", () => {
  const scene = fixture(), mind = createBuilderMind(scene);
  until(mind, scene, mind => mind.sleepPhase === "enter"); step(mind, scene);
  const before = structuredClone(mind);
  for (let i = 0; i < 30; i++) {
    const frame = builderMindFrame(mind, scene, true);
    assert.equal(frame.action, "idle"); assert.equal(frame.frame, 0); assert.equal(frame.opacity, 1 - mind.sleepProgress);
    advanceBuilderMind(mind, scene, 0, environment({ now: start + 86_400_000 }));
  }
  assert.deepEqual(mind, before);
});

test("actual builder house has a private validated door and a continuous return from every work host", () => {
  const scene = previewWorldScene(TILED_WORLD, initialPreviewLevels(TILED_WORLD)), places = builderLocalPlaces(scene);
  assert.ok(places.home, "authored builder-home entry and doorway compile");
  for (const stationId of ["home", "warehouse", "workshop", "kiln", "woodlot", "quarry", "garden", "dryer"]) {
    const mind = createBuilderMind(scene, { awaitConstruction: true });
    advanceBuilderMind(mind, scene, 0, environment({ construction: snapshot([{ ...order, stationId }]) }));
    assert.equal(mind.action, "work", `${stationId} restores its own checked work stop`);
    until(mind, scene, mind => mind.sleepPhase === "sleep", environment({ construction: snapshot([], 2) }), 180);
    assert.deepEqual(mind.position, places.home.doorway);
  }
});
