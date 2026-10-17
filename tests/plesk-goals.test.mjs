import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root,
  resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false } });
after(() => vite.close());
const { createPleskMind, advancePleskMind, requestPleskWalk, requestPleskTrade, noticePleskMind, PLESK_MIND_LIMITS }
  = await vite.ssrLoadModule("/features/world/characters/plesk/plesk-mind.ts");
const { pleskLocalPlaces, PLESK } = await vite.ssrLoadModule("/features/world/characters/plesk/plesk-resident.ts");
const { canTraverse } = await vite.ssrLoadModule("/features/world/navigation/navigation.ts");
const { TILED_WORLD } = await vite.ssrLoadModule("/features/world/scene/presentation.ts");
const day = { rain: 0, dusk: 0 };
const point = (x, y) => ({ x, y });
const rect = (x, y, width, height) => [point(x, y), point(x + width, y), point(x + width, y + height), point(x, y + height)];
function sceneFixture() {
  return { schemaVersion: 1, id: "plesk-goal-corridor", width: 600, height: 300, terrain: [], sites: [], paths: [],
    focus: { x: 0, y: 0, width: 600, height: 300 }, actor: { spawn: point(70, 120), size: 50 },
    destinations: [{ id: "plesk-fishing", position: point(80, 120), pauseSeconds: 4 },
      { id: "plesk-trade", position: point(500, 120), pauseSeconds: 4 },
      { id: "plesk-rest", position: point(80, 230), pauseSeconds: 4 }],
    navigation: { version: 1, cellSize: 5, areas: [{ id: "porch", points: rect(40, 80, 110, 180) },
      { id: "narrow-trail", points: rect(100, 108, 440, 24) }], obstacles: [], interests: [] },
    water: { surfaces: [], exclusions: [] } };
}
function step(mind, scene, env = day, dt = .1) {
  const before = { ...mind.position };
  advancePleskMind(mind, scene, dt, env);
  assert.ok(Math.hypot(mind.position.x - before.x, mind.position.y - before.y) <= PLESK.speed * dt + .001, "real feet never teleport");
  assert.ok(canTraverse(pleskLocalPlaces(scene).nav, before, mind.position), "every executed segment stays on checked ground");
}
function advance(mind, scene, seconds, env = day) { for (let i = 0; i < seconds * 10 - 1e-8; i++) step(mind, scene, env); }
function until(mind, scene, predicate, env = day, seconds = 60) {
  for (let i = 0; i < seconds * 10 && !predicate(); i++) step(mind, scene, env);
  assert.ok(predicate(), JSON.stringify(mind.observation));
}
function blockedWalk() {
  const scene = sceneFixture(), mind = createPleskMind(scene, 9), places = pleskLocalPlaces(scene);
  const blocker = { id: "mochlik", position: point(260, 120), size: 50, moving: false };
  assert.equal(requestPleskWalk(mind, scene, places.trade), true);
  until(mind, scene, () => mind.trafficWaiting, { ...day, occupants: [blocker] });
  return { scene, mind, places, blocker };
}

test("a temporary blocked optional route keeps the exact goal and resumes from its actual feet", () => {
  const { scene, mind, places, blocker } = blockedWalk(), target = mind.stage.target, queue = mind.queue;
  advance(mind, scene, 2, { ...day, occupants: [blocker] });
  assert.equal(mind.stage.target, target); assert.equal(mind.queue, queue); assert.equal(mind.intent, "walk");
  assert.equal(mind.avoidStopId, null); assert.ok(mind.walkBlockedFor > 1);
  until(mind, scene, () => mind.stopId === places.trade.id);
  assert.equal(mind.walkBlockedFor, 0); assert.equal(mind.catchCount, 0);
});

test("a long optional obstruction cools down that stop instead of repeatedly choosing it", () => {
  const { scene, mind, places, blocker } = blockedWalk(), goal = mind.stage.target.id, before = { ...mind.position };
  advance(mind, scene, PLESK_MIND_LIMITS.leisurePatience + .2, { ...day, occupants: [blocker] });
  assert.equal(mind.stage.trail, undefined); assert.equal(mind.stage.target.id, "plesk-leisure-pause");
  assert.deepEqual(mind.position, before); assert.equal(mind.avoidStopId, goal);
  assert.ok(mind.avoidStopUntil > mind.elapsed + 40); assert.equal(mind.catchCount, 0);
  mind.walkAfter = 0; mind.tradeAfter = Infinity; mind.leisureStep = 2;
  until(mind, scene, () => mind.stage.action === "walk", { ...day, occupants: [blocker] }, 10);
  assert.notEqual(mind.stage.target.id, places.trade.id, "the failed destination is excluded even when its rhythm turn comes first");
});

test("a promised conversation and paused steps do not spend an optional route's traffic patience", () => {
  const { scene, mind, blocker } = blockedWalk();
  advance(mind, scene, 1, { ...day, occupants: [blocker] });
  const target = mind.stage.target, age = mind.age, feet = { ...mind.position }, blocked = mind.walkBlockedFor;
  advance(mind, scene, 20, { ...day, socialHold: true, occupants: [blocker] });
  assert.equal(mind.stage.target, target); assert.equal(mind.age, age); assert.deepEqual(mind.position, feet);
  assert.equal(mind.walkBlockedFor, blocked); assert.equal(mind.avoidStopId, null);
  const frozen = JSON.stringify(mind);
  for (const dt of [0, -1, NaN, Infinity]) advancePleskMind(mind, scene, dt, { ...day, occupants: [blocker] });
  assert.equal(JSON.stringify(mind), frozen);
  step(mind, scene); assert.equal(mind.stage.target, target); assert.ok(mind.age > age);
});

test("player, trade and severe weather interrupt only the harmless optional walk", () => {
  for (const request of [noticePleskMind, requestPleskTrade]) {
    const { scene, mind, blocker } = blockedWalk(), feet = { ...mind.position };
    request(mind); step(mind, scene, { ...day, occupants: [blocker] });
    assert.equal(mind.catchCount, 0); assert.equal(mind.avoidStopId, null);
    assert.ok(Math.hypot(mind.position.x - feet.x, mind.position.y - feet.y) <= PLESK.speed * .1 + .001);
    assert.equal(request === noticePleskMind ? mind.stage.action : mind.intent, request === noticePleskMind ? "greet" : "trade");
  }
  const mind = createPleskMind(TILED_WORLD, 9), places = pleskLocalPlaces(TILED_WORLD);
  assert.equal(requestPleskWalk(mind, TILED_WORLD, places.rest), true); advance(mind, TILED_WORLD, 1);
  step(mind, TILED_WORLD, { rain: 1, dusk: 0 });
  assert.equal(mind.home.phase, "approach"); assert.equal(mind.intent, "rest"); assert.equal(mind.catchCount, 0);
});

test("a real shop approach survives a long obstruction and cannot be discarded as leisure", () => {
  const scene = sceneFixture(), mind = createPleskMind(scene, 9), places = pleskLocalPlaces(scene);
  const blocker = { id: "mochlik", position: point(260, 120), size: 50, moving: false };
  requestPleskTrade(mind); until(mind, scene, () => mind.trafficWaiting, { ...day, occupants: [blocker] });
  const goal = mind.stage.target;
  advance(mind, scene, 20, { ...day, occupants: [blocker] });
  assert.equal(mind.intent, "trade"); assert.equal(mind.stage.target, goal); assert.equal(mind.avoidStopId, null);
  until(mind, scene, () => mind.stage.action === "trade"); assert.equal(mind.stopId, places.trade.id);
});

test("personal shore walks rotate tackle rest, the pier and the stall without fake catches or sales", () => {
  const scene = sceneFixture(), mind = createPleskMind(scene, 9), places = pleskLocalPlaces(scene), seen = [], pauses = [];
  mind.tradeAfter = Infinity;
  for (const expected of [places.rest.id, places.base.id, places.trade.id]) {
    mind.walkAfter = 0;
    until(mind, scene, () => mind.stage.action === "walk");
    seen.push(mind.stage.target.id); assert.equal(mind.stage.target.id, expected);
    const delay = mind.walkAfter - mind.elapsed; pauses.push(Math.round(delay));
    until(mind, scene, () => !mind.stage.trail);
    assert.equal(mind.catchCount, 0);
    assert.ok([mind.stage, ...mind.queue].every(stage => !stage.deposit && !stage.sell && !stage.caught && !stage.outcome));
    if (expected === places.rest.id) assert.ok(mind.queue.some(stage => stage.action === "rest"));
    else assert.equal(mind.stage.variation, expected === places.base.id ? "calm" : "check");
  }
  assert.equal(new Set(seen).size, 3); assert.equal(new Set(pauses).size, 3);
});
