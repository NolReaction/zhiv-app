import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root,
  resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false } });
after(() => vite.close());
const { createPleskMind, advancePleskMind, pleskMindFrame, requestPleskTrade, requestPleskHome, requestPleskWalk,
  noticePleskMind, requestPleskSocialVisit, cancelPleskSocialVisit, pleskAvailableForLeisure, pleskCanPausePassing, pleskCanReceiveVisit } = await vite.ssrLoadModule("/features/world/characters/plesk/plesk-mind.ts");
const { pleskPersonalHome } = await vite.ssrLoadModule("/features/world/characters/plesk/plesk-home.ts");
const { pleskLocalPlaces, PLESK } = await vite.ssrLoadModule("/features/world/characters/plesk/plesk-resident.ts");
const { createWorldNavigation, canTraverse } = await vite.ssrLoadModule("/features/world/navigation/navigation.ts");
const { TILED_WORLD: world } = await vite.ssrLoadModule("/features/world/scene/presentation.ts");
const day = { rain: 0, dusk: 0 };
function tick(mind, seconds, env = day, scene = world) {
  for (let t = 0; t < seconds - 1e-8; t += .1) advancePleskMind(mind, scene, Math.min(.1, seconds - t), env);
}
function until(mind, condition, seconds = 180, env = day) {
  for (let t = 0; t < seconds; t += .1) { if (condition(mind)) return; advancePleskMind(mind, world, .1, env); }
  assert.fail(`condition not reached: ${mind.home.phase}/${mind.stage.action}/${mind.reason}`);
}
const rect = (id, p, r = 7) => ({ id, points: [{ x: p.x - r, y: p.y - r }, { x: p.x + r, y: p.y - r },
  { x: p.x + r, y: p.y + r }, { x: p.x - r, y: p.y + r }] });

test("Plesk's real threshold opens only its own narrow corridor and preserves water and unrelated collision", () => {
  const before = JSON.stringify(world), nav = createWorldNavigation(world), home = pleskPersonalHome(world, nav);
  assert.ok(home); assert.ok(canTraverse(home.navigation, home.entry, home.doorway));
  assert.equal(canTraverse(nav, home.entry, home.doorway), false, "ordinary traffic still sees the house");
  assert.deepEqual(home.entry, world.sites.find(site => site.id === "plesk-shop").entry);
  const middle = { x: (home.entry.x + home.doorway.x) / 2, y: (home.entry.y + home.doorway.y) / 2 };
  const blocked = { ...world, navigation: { ...world.navigation, obstacles: [...world.navigation.obstacles, rect("foreign-wall", middle)] } };
  const flooded = { ...world, water: { ...world.water, surfaces: [...world.water.surfaces, rect("flooded-threshold", middle)] } };
  for (const scene of [blocked, flooded]) assert.equal(pleskPersonalHome(scene, createWorldNavigation(scene)), null);
  const missing = { ...world, sites: world.sites.filter(site => site.id !== "plesk-shop") };
  assert.equal(pleskPersonalHome(missing, createWorldNavigation(missing)), null);
  assert.equal(JSON.stringify(world), before, "private navigation never mutates the authored scene");
});

test("Plesk walks through the actual doorway, rests invisibly and naturally returns to fishing", () => {
  const mind = createPleskMind(world), places = pleskLocalPlaces(world), start = { ...mind.position };
  assert.equal(requestPleskHome(mind), true); assert.deepEqual(mind.position, start);
  assert.equal(mind.home.phase, "approach"); assert.equal(pleskAvailableForLeisure(mind), false);
  until(mind, item => item.home.phase === "enter" && item.home.progress > .2);
  const frame = pleskMindFrame(mind, world, false);
  assert.equal(frame.action, "walk"); assert.ok(frame.opacity > 0 && frame.opacity < 1);
  const previous = { ...mind.position }; tick(mind, .1);
  assert.ok(canTraverse(mind.home.door.navigation, previous, mind.position));
  assert.ok(Math.hypot(mind.position.x - previous.x, mind.position.y - previous.y) <= PLESK.speed * .1 + 1e-6);
  until(mind, item => item.home.phase === "inside");
  assert.equal(pleskMindFrame(mind, world, false), null); assert.deepEqual(mind.position, mind.home.door.doorway);
  const clock = mind.elapsed, feet = { ...mind.position }; tick(mind, 20);
  assert.equal(mind.home.phase, "inside"); assert.deepEqual(mind.position, feet); assert.ok(mind.elapsed > clock + 19.99);
  until(mind, item => item.home.phase === "outside", 80);
  until(mind, item => item.stage.action === "fish", 180);
  assert.deepEqual(mind.position, places.base.position); assert.equal(mind.home.phase, "outside");
});

test("rain and night keep a resting Plesk home, while the shop invitation brings her outside safely", () => {
  const mind = createPleskMind(world, 7); requestPleskHome(mind);
  until(mind, item => item.home.phase === "inside"); const feet = { ...mind.position };
  tick(mind, 120, { rain: .8, dusk: 1 });
  assert.equal(mind.home.phase, "inside"); assert.deepEqual(mind.position, feet);
  requestPleskTrade(mind); advancePleskMind(mind, world, 0, day);
  assert.deepEqual(mind.position, feet); assert.equal(pleskMindFrame(mind, world, false), null);
  tick(mind, .1, { rain: .8, dusk: 1 });
  assert.equal(mind.home.phase, "exit"); assert.ok(pleskMindFrame(mind, world, false).opacity > 0);
  until(mind, item => item.stage.action === "trade", 45, { rain: .8, dusk: 1 });
  assert.deepEqual(mind.position, pleskLocalPlaces(world).trade.position); assert.equal(mind.catchCount, 0);
});

test("an evening Plesk leaves her finished home rest and resumes fishing without waiting for dawn", () => {
  const mind = createPleskMind(world, 7), evening = { rain: 0, dusk: 1, localHour: 21 };
  mind.elapsed = 110;
  requestPleskHome(mind);
  until(mind, item => item.home.phase === "inside", 60, evening);
  const feet = { ...mind.position };
  tick(mind, 120, { ...evening, localHour: 2 });
  assert.equal(mind.home.phase, "inside"); assert.deepEqual(mind.position, feet);
  until(mind, item => item.home.phase === "outside", 100, evening);
  until(mind, item => item.stage.action === "fish", 100, evening);
  assert.equal(mind.home.phase, "outside");
  assert.ok(pleskMindFrame(mind, world, false));
  const paused = structuredClone(mind);
  for (let sample = 0; sample < 10; sample++) {
    advancePleskMind(mind, world, 0, evening);
    pleskMindFrame(mind, world, true);
  }
  assert.deepEqual(mind, paused, "paused/reduced-motion reads do not consume an evening activity window");
});

test("a shop call reverses a partly completed entry without jumping feet or opacity at dt zero", () => {
  const mind = createPleskMind(world); requestPleskHome(mind);
  until(mind, item => item.home.phase === "enter" && item.home.progress > .3);
  const frame = pleskMindFrame(mind, world, false), feet = { ...mind.position };
  requestPleskTrade(mind); advancePleskMind(mind, world, 0, day);
  assert.deepEqual(mind.position, feet); assert.equal(pleskMindFrame(mind, world, false).opacity, frame.opacity);
  tick(mind, .1); assert.equal(mind.home.phase, "exit");
  assert.ok(pleskMindFrame(mind, world, false).opacity > frame.opacity);
  assert.ok(Math.hypot(mind.position.x - feet.x, mind.position.y - feet.y) <= PLESK.speed * .1 + 1e-6);
  until(mind, item => item.stage.action === "trade", 45);
});

test("an occupied exit keeps Plesk concealed until the same physical doorway clears", () => {
  const mind = createPleskMind(world); requestPleskHome(mind); until(mind, item => item.home.phase === "inside");
  const feet = { ...mind.position }, entry = mind.home.door.entry;
  requestPleskTrade(mind);
  tick(mind, 8, { ...day, occupants: [{ id: "mochlik", position: entry, size: 50, moving: false }] });
  assert.deepEqual(mind.position, feet); assert.equal(mind.home.progress, 1);
  assert.equal(pleskMindFrame(mind, world, false).opacity, 0); assert.equal(mind.trafficWaiting, true);
  until(mind, item => item.home.phase === "outside", 5);
  assert.deepEqual(mind.position, entry);
});

test("home and partial fade are read-only across camera sampling, paused steps and harmless art changes", () => {
  const mind = createPleskMind(world); requestPleskHome(mind);
  until(mind, item => item.home.phase === "enter" && item.home.progress > .3);
  const snapshot = JSON.stringify(mind), first = pleskMindFrame(mind, world, false);
  for (let i = 0; i < 8; i++) {
    const still = pleskMindFrame(mind, world, true); assert.equal(still.frame, 0); assert.equal(still.opacity, first.opacity);
    assert.deepEqual({ x: still.x, y: still.y }, mind.position);
    for (const dt of [0, -1, NaN, Infinity]) advancePleskMind(mind, world, dt, day);
  }
  assert.equal(JSON.stringify(mind), snapshot);
  const art = { ...world, sites: world.sites.map(site => site.id === "plesk-shop" ? { ...site, label: "New art label" } : site) };
  advancePleskMind(mind, art, 0, day); assert.equal(JSON.stringify(mind), snapshot);
  const feet = { ...mind.position }; advancePleskMind(mind, art, .01, day);
  assert.equal(mind.available, true); assert.ok(Math.hypot(mind.position.x - feet.x, mind.position.y - feet.y) <= PLESK.speed * .01 + 1e-6);
});

test("optional walking can pause for a passing conversation and resume the exact route", () => {
  const mind = createPleskMind(world), target = pleskLocalPlaces(world).rest;
  assert.equal(requestPleskWalk(mind, world, target), true); tick(mind, 2);
  assert.equal(pleskCanPausePassing(mind), true);
  const stage = mind.stage, age = mind.age, feet = { ...mind.position };
  tick(mind, 20, { ...day, socialHold: true });
  assert.equal(mind.stage, stage); assert.equal(mind.age, age); assert.deepEqual(mind.position, feet);
  tick(mind, .1); assert.equal(mind.stage, stage); assert.ok(mind.age > age);
});

test("a finite accepted visit pauses a waiting cast without creating fish or replaying the cast", () => {
  const mind = createPleskMind(world, 9); until(mind, item => item.stage.action === "fish" && item.age > 2);
  assert.equal(pleskCanReceiveVisit(mind), true);
  const stage = mind.stage, age = mind.age, queue = [...mind.queue], feet = { ...mind.position }, catches = mind.catchCount;
  tick(mind, 25, { ...day, socialHold: true });
  assert.equal(mind.stage, stage); assert.equal(mind.age, age); assert.deepEqual(mind.queue, queue);
  assert.deepEqual(mind.position, feet); assert.equal(mind.catchCount, catches);
  tick(mind, .1); assert.equal(mind.stage, stage); assert.ok(mind.age > age);
});

test("Plesk visits a neighbour and walks back to the exact paused harmless route after cancellation", () => {
  const mind = createPleskMind(world), places = pleskLocalPlaces(world);
  requestPleskWalk(mind, world, places.rest); tick(mind, 1);
  const saved = { stage: mind.stage, age: mind.age, feet: { ...mind.position }, queue: [...mind.queue] };
  const target = { id: "builder", position: places.trade.position, size: 38 };
  assert.equal(requestPleskSocialVisit(mind, world, target), true); assert.deepEqual(mind.position, saved.feet);
  assert.equal(requestPleskSocialVisit(mind, world, target), false);
  until(mind, item => item.socialVisit?.phase === "wait", 60);
  assert.equal(mind.stage.action, "greet"); assert.equal(mind.catchCount, 0);
  const visited = { ...mind.position }; tick(mind, 3, { ...day, socialHold: true }); assert.deepEqual(mind.position, visited);
  cancelPleskSocialVisit(mind); assert.deepEqual(mind.position, visited); assert.equal(mind.socialVisit.phase, "return");
  until(mind, item => !item.socialVisit, 60);
  assert.ok(Math.hypot(mind.position.x - saved.feet.x, mind.position.y - saved.feet.y) <= PLESK.speed * .1 + 1e-6, "only the remaining frame time may resume the original walk");
  assert.equal(mind.stage, saved.stage);
  assert.ok(Math.abs(mind.age - saved.age) <= .1 + 1e-6); assert.deepEqual(mind.queue, saved.queue);
  tick(mind, .1); assert.equal(mind.home.phase, "outside"); assert.ok(mind.age > saved.age);
});

test("visible taps preserve Plesk's accepted visit but an explicit cancellation still returns her", () => {
  const mind = createPleskMind(world), places = pleskLocalPlaces(world);
  requestPleskWalk(mind, world, places.rest); tick(mind, 1);
  const target = { id: "builder", position: places.trade.position, size: 38 };
  assert.equal(requestPleskSocialVisit(mind, world, target), true);
  const visit = mind.socialVisit, stage = mind.stage;
  for (let tap = 0; tap < 100; tap++) noticePleskMind(mind, { preserveActivity: true });
  assert.equal(mind.socialVisit, visit); assert.equal(mind.stage, stage); assert.equal(mind.noticePending, false);
  until(mind, item => item.socialVisit?.phase === "wait", 60);
  const feet = { ...mind.position };
  for (let tap = 0; tap < 30; tap++) {
    noticePleskMind(mind, { preserveActivity: true }); tick(mind, .1, { ...day, socialHold: true });
    assert.equal(mind.socialVisit, visit); assert.equal(mind.socialVisit.phase, "wait");
    assert.deepEqual(mind.position, feet);
  }
  cancelPleskSocialVisit(mind); assert.equal(mind.socialVisit.phase, "return");
});

test("visible taps preserve Plesk's home approach and threshold while an explicit call still wakes her", () => {
  const mind = createPleskMind(world);
  assert.equal(requestPleskHome(mind), true);
  for (let count = 0; count < 1200 && mind.home.phase !== "inside"; count++) {
    const home = mind.home, stage = mind.stage;
    noticePleskMind(mind, { preserveActivity: true });
    assert.equal(mind.noticePending, false); assert.equal(mind.home, home); assert.equal(mind.stage, stage);
    tick(mind, .1); assert.notEqual(mind.home.phase, "exit");
  }
  assert.equal(mind.home.phase, "inside");
  noticePleskMind(mind, { preserveActivity: true }); assert.equal(mind.noticePending, false);
  noticePleskMind(mind); tick(mind, .1); assert.equal(mind.home.phase, "exit");
});

test("a conversation or real insect visit ignores its partner and ordinary walkers but yields to work", () => {
  const point = (x, y) => ({ x, y });
  const scene = { schemaVersion: 1, id: "plesk-optional-passage", width: 400, height: 240, terrain: [], sites: [], paths: [],
    focus: { x: 0, y: 0, width: 400, height: 240 }, actor: { spawn: point(80, 120), size: 50 },
    destinations: [{ id: "plesk-fishing", position: point(230, 120), pauseSeconds: 4 }],
    navigation: { version: 1, cellSize: 5, areas: [rect("grass", point(200, 120), 120)], obstacles: [], interests: [] } };
  const passer = priority => ({ id: "builder", position: point(190, 120), size: 38, moving: true,
    intent: { points: [point(190, 120), point(300, 120)], target: point(300, 120), priority } });
  for (const hold of ["socialHold", "wildlife"]) {
    const mind = createPleskMind(scene), stage = mind.stage, feet = { ...mind.position };
    advancePleskMind(mind, scene, .1, { ...day, [hold]: true, occupants: [passer(1)] });
    assert.equal(mind.stage, stage); assert.deepEqual(mind.position, feet);
    if (hold === "socialHold") {
      advancePleskMind(mind, scene, .1, { ...day, socialHold: true, socialPartnerId: "builder", occupants: [passer(2)] });
      assert.equal(mind.stage, stage); assert.deepEqual(mind.position, feet);
    }
    advancePleskMind(mind, scene, .1, { ...day, [hold]: true, occupants: [passer(3)] });
    assert.equal(mind.stage.action, "walk"); assert.equal(mind.stage.target.id, "plesk-yield");
    assert.ok(Math.hypot(mind.position.x - feet.x, mind.position.y - feet.y) <= PLESK.speed * .1 + 1e-6);
  }
});


test("the remainder after leaving home belongs to the same clock even with a stale leisure hold", () => {
  for (const hold of ["socialHold", "wildlife"]) {
    const mind = createPleskMind(world); requestPleskHome(mind); until(mind, item => item.home.phase === "inside");
    mind.home.until = mind.elapsed;
    until(mind, item => item.home.phase === "exit" && item.home.progress < .04, 5);
    const before = mind.elapsed;
    advancePleskMind(mind, world, .1, { ...day, [hold]: true });
    assert.equal(mind.home.phase, "outside"); assert.ok(Math.abs(mind.elapsed - before - .1) < 1e-8);
  }
});
