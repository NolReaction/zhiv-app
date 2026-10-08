import assert from "node:assert/strict";
import test, { after } from "node:test";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ configFile: false, appType: "custom", root, resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false } });
after(() => vite.close());
const { createForestCampfires, advanceForestCampfires, campfireReady, campfireVisitFrame } = await vite.ssrLoadModule("/features/world/activities/campfire/forest-campfire.ts");
const { connectForestSession } = await vite.ssrLoadModule("/features/world/state/forest-session.ts");
const { requestForestDirective, advanceForestDirector, noticeForestDirector, cancelForestDirector } = await vite.ssrLoadModule("/features/world/simulation/forest-director.ts");
const { previewWorldScene } = await vite.ssrLoadModule("/features/world/tiled/preview-state.ts");
const { createWorldNavigation, isWalkable, findWorldPath } = await vite.ssrLoadModule("/features/world/navigation/navigation.ts");
const { forestObservationFrame } = await vite.ssrLoadModule("/features/world/state/forest-observer.ts");
const { captureForestMemory } = await vite.ssrLoadModule("/features/world/state/memory/forest-memory.ts");
const source = JSON.parse(await readFile(new URL("../features/world/tiled/forest.generated.json", import.meta.url)));
const night = { autoLife: false, blocked: false, dusk: 1, rain: 0, homeAvailable: true };
function session(level = 1, size = 50) {
  const scene = previewWorldScene({ ...source, actor: { ...source.actor, size } }, { home: level });
  const handle = connectForestSession(undefined, scene, "circle", 0, 1, () => {}, { persistence: false });
  handle.release(); return { state: handle.state, scene };
}
function step(state, seconds, options = night) {
  for (let i = 0; i < Math.round(seconds / .05); i++) advanceForestDirector(state, .05, options);
}
function arrive(state) {
  requestForestDirective(state, "campfire", night);
  for (let i = 0; i < 700 && !state.director.campfireVisit; i++) advanceForestDirector(state, .05, night);
  assert.ok(state.director.campfireVisit, state.director.reason);
}
test("night ignition, rain extinction, wet delay and daylight are gradual and bounded", () => {
  const fires = createForestCampfires(source), fire = fires[0];
  const tick = (seconds, dusk, rain) => { for (let i = 0; i < seconds * 20; i++) advanceForestCampfires(fires, .05, dusk, rain); };
  tick(20, 0, 0); assert.equal(fire.flame, 0);
  tick(10, 1, 0); assert.ok(campfireReady(fire, 0, 1)); assert.ok(fire.flame > .9);
  const before = structuredClone(fire); advanceForestCampfires(fires, 0, 0, 1); assert.deepEqual(fire, before);
  advanceForestCampfires(fires, .05, 1, 1); assert.ok(fire.flame < before.flame && fire.flame > .8);
  tick(15, 1, 1); assert.ok(fire.flame < .01); assert.ok(fire.wetness > .65);
  tick(20, 1, 0); assert.equal(fire.lit, false, "soaked wood does not reignite immediately");
  tick(130, 1, 0); assert.ok(campfireReady(fire, 0, 1));
  tick(15, 0, 0); assert.ok(fire.flame < .01); assert.ok(fire.embers > fire.flame);
  for (const key of ["flame", "embers", "wetness"]) assert.ok(fire[key] >= 0 && fire[key] <= 1);
});
test("all five authored houses and both hero sizes retain a reachable seat outside the fire", () => {
  for (const level of [1, 2, 3, 4, 5]) for (const size of [50, 56]) {
    const { scene, state } = session(level, size), fire = scene.campfires[0];
    const nav = createWorldNavigation(scene, size * .1);
    assert.equal(isWalkable(nav, fire.position), false);
    assert.ok(isWalkable(nav, fire.seat));
    assert.ok(findWorldPath(nav, scene.actor.spawn, fire.seat));
    const start = { ...state.clearing.position };
    arrive(state);
    assert.notDeepEqual(state.clearing.position, start);
    assert.ok(Math.hypot(state.clearing.position.x - fire.seat.x, state.clearing.position.y - fire.seat.y) < 1);
    const feet = { ...state.clearing.position };
    step(state, 4); assert.deepEqual(state.clearing.position, feet);
    assert.equal(forestObservationFrame(state).activity, "Греется у костра");
    const frame = campfireVisitFrame(state.director.campfireVisit, state.life.campfires[0], feet);
    assert.equal(frame.pose, "crouch");
    step(state, 25);
    assert.equal(state.director.campfireVisit, null);
    assert.equal(state.clearing.behavior.mind.intention, null);
    assert.ok(state.clearing.behavior.mind.recent.some(item => item.action === "rest" && item.outcome === "completed"));
  }
});
test("tap, weather and DEV cancellation release the feet; pauses preserve the visit", () => {
  for (const interruption of ["tap", "rain", "day", "cancel"]) {
    const { state } = session(); arrive(state);
    const frozen = structuredClone(state.director.campfireVisit), feet = { ...state.clearing.position };
    step(state, 3, { ...night, blocked: true }); assert.deepEqual(state.director.campfireVisit, frozen);
    step(state, 3, { ...night, reducedMotion: true }); assert.deepEqual(state.director.campfireVisit, frozen);
    if (interruption === "tap") noticeForestDirector(state);
    else if (interruption === "cancel") cancelForestDirector(state);
    else step(state, .1, { ...night, ...(interruption === "day" ? { dusk: 0 } : { rain: 1 }) });
    assert.equal(state.director.campfireVisit, null);
    assert.deepEqual(state.clearing.position, feet, "interruption never teleports the actor");
  }
});
test("missing/unreachable campfires fail clearly and unfinished visits are not persisted", () => {
  const { state, scene } = session(); arrive(state);
  const memory = captureForestMemory(state, scene);
  assert.equal(memory.version, 2); assert.equal(Object.hasOwn(memory, "campfires"), false);
  assert.equal(JSON.stringify(memory).includes('"campfireVisit"'), false);
  cancelForestDirector(state); state.life.campfires = [];
  requestForestDirective(state, "campfire", night); step(state, .1);
  assert.equal(state.pendingLife, null); assert.match(state.director.reason, /Костёр/);
});

test("the hearth excludes puddles, authored walks and protected doorway transitions", async () => {
  const { isForestGroundClear } = await vite.ssrLoadModule("/features/world/environment/weather/forest-ground-weather.ts");
  const { compileWorldInteractions } = await vite.ssrLoadModule("/features/world/navigation/interaction-navigation.ts");
  const { clearingRouteDiagnostics } = await vite.ssrLoadModule("/features/world/simulation/clearing-activity.ts");
  const { scene } = session(), fire = scene.campfires[0];
  assert.equal(isForestGroundClear(scene, fire.position, 2), false);
  const home = scene.sites.find(site => site.id === "home");
  const blocked = { ...scene, campfires: [{ ...fire, position: { x: (home.entry.x + home.doorway.x) / 2, y: (home.entry.y + home.doorway.y) / 2 } }] };
  assert.equal(compileWorldInteractions(blocked).home, null, "a doorway cannot bypass fire collision");
  // Isolate the route/fire collision from the artist's house and hearth placement.
  const start = { x: scene.focus.x + scene.focus.width / 2, y: scene.focus.y + scene.focus.height / 2 };
  const end = { x: start.x + 30, y: start.y };
  const routeScene = { ...scene, sites: [], water: undefined, actor: { ...scene.actor, spawn: start },
    campfires: [{ ...fire, position: end }],
    paths: [{ id: "test-fire-walk", behavior: "clearing", activity: "look", points: [start, end] }] };
  assert.ok(clearingRouteDiagnostics(routeScene).some(item => item.reason === "campfire-collision"));
});
