import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "vite";
const root = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const vite = await createServer({ configFile: false, root, resolve: { alias: { "@": root } },
  server: { middlewareMode: true, hmr: false, ws: false }, optimizeDeps: { noDiscovery: true, include: [] } });
const { TILED_WORLD: scene } = await vite.ssrLoadModule("/features/world/scene/presentation.ts");
const { connectForestSession } = await vite.ssrLoadModule("/features/world/state/forest-session.ts");
const { syncForestBoatTravel: sync, forestBoatWalking: walking, forestBoatActorAway: away, forestFishingBoatFrame: frame } = await vite.ssrLoadModule("/features/world/activities/fishing/forest-boat-travel.ts");
const { fishingBoatRoute: route, fishingBoatPathPoint: point } = await vite.ssrLoadModule("/features/world/objects/fishing-boat/fishing-boat-navigation.ts");
const { fishingBoatMapObject } = await vite.ssrLoadModule("/features/world/objects/fishing-boat/fishing-boat-interaction.ts");
const { economySceneBoatTiming: timing } = await vite.ssrLoadModule("/features/world/state/economy/economy-boat-fishing-state.ts");
const { advanceClearingActivity } = await vite.ssrLoadModule("/features/world/simulation/clearing-activity.ts");
const { canTraverse, isWalkable } = await vite.ssrLoadModule("/features/world/navigation/navigation.ts");
await vite.close();
const date = value => new Date(value).toISOString();
const start = 1_000_000;
const boat = () => ({ level: 1, upgrades: ["crate", "oars"], artifacts: ["landing_net", "telescope"],
  voyage: { id: "boat-test", departedAt: date(start), arrivesAt: date(start + 120_000), fishingUntil: date(start + 600_000), inboundSeconds: 120 } });
function session() { return connectForestSession(undefined, scene, "world", start, 0, () => {}, { persistence: false, sync: false }); }
function advance(state, value, from, seconds, still = false) {
  for (let tick = 0; tick < seconds * 10; tick++) {
    const now = from + tick * 100; sync(state, scene, value, now, still);
    state.director.elapsed += .1; state.elapsed += .1;
    advanceClearingActivity(state.clearing, .1, { enabled: !still, blocked: !walking(state), dusk: 0, rain: 0, homeAvailable: true, idleEligible: false });
  }
  sync(state, scene, value, from + seconds * 1000, still);
}

test("actual map mooring and full water path fit the unchanged authored collision masks", () => {
  const path = route(scene); assert.ok(path);
  assert.equal(route(scene), path, "navigation is cached, never rebuilt per frame");
  assert.ok(Math.hypot(path.dock.x - 892, path.dock.y - 948) > 150, "trader berth remains separate");
  assert.ok(Math.hypot(path.dock.x - 705, path.dock.y - 1102) > 300, "trade ship berth remains separate");
  for (let index = 1; index < path.sail.points.length; index++) assert.ok(canTraverse(path.water, path.sail.points[index - 1], path.sail.points[index]));
  for (let index = 0; index <= 100; index++) assert.ok(isWalkable(path.water, point(path.sail, index / 100)));
  assert.equal(fishingBoatMapObject(scene).place, "fishing-boat");
  const changed = { ...scene, navigation: { ...scene.navigation, areas: [] } };
  assert.equal(route(changed), null, "invalid future map geometry cannot invent a crossing");
});

test("one hero walks to the boat, boards, sails away, returns over the gangway and walks home", () => {
  const handle = session(), state = handle.state, value = boat();
  try {
    sync(state, scene, value, start, false);
    assert.equal(state.boatTravel.phase, "approach"); assert.equal(away(state), false);
    const phases = new Set(); let boarded;
    for (let step = 0; step < 1200; step++) {
      advance(state, value, start + step * 100, .1);
      phases.add(state.boatTravel.phase);
      if (state.boatTravel.phase === "boarding") boarded = frame(state, scene, value, start + step * 100);
    }
    assert.ok(phases.has("boarding")); assert.ok(phases.has("outward")); assert.ok(phases.has("away"));
    assert.ok(boarded.crossing); assert.equal(boarded.passenger, false, "crossing owns the only hero");
    assert.equal(away(state), true); assert.equal(frame(state, scene, value, start + 130_000).opacity, 0);
    const inbound = frame(state, scene, value, start + 710_000);
    assert.equal(inbound.passenger, true); assert.ok(inbound.opacity > 0);
    const returnPhases = new Set();
    for (let step = 0; step < 900; step++) { advance(state, value, start + 720_000 + step * 100, .1); returnPhases.add(state.boatTravel.phase); }
    assert.ok(returnPhases.has("landing")); assert.ok(returnPhases.has("returning")); assert.ok(returnPhases.has("complete"));
    assert.equal(away(state), false); assert.ok(Math.hypot(state.clearing.position.x - state.clearing.home.x, state.clearing.position.y - state.clearing.home.y) < .5);
    sync(state, scene, { ...value, voyage: undefined }, start + 810_000, false);
    assert.equal(state.boatTravel, undefined, "claim releases only completed cosmetic ownership");
  } finally { handle.release(); }
});

test("server timestamps recover automatic return without reopening or replaying an old departure", () => {
  const value = boat();
  assert.equal(timing(value, start + 119_999).phase, "outbound");
  assert.equal(timing(value, start + 120_000).phase, "fishing");
  assert.equal(timing(value, start + 600_000).phase, "inbound");
  assert.equal(timing(value, start + 720_000).phase, "ready");
  const handle = session();
  try {
    sync(handle.state, scene, value, start + 710_000, false);
    assert.equal(handle.state.boatTravel.phase, "away"); assert.equal(away(handle.state), true);
    assert.equal(frame(handle.state, scene, value, start + 710_000).passenger, true);
  } finally { handle.release(); }
  const ready = session();
  try { sync(ready.state, scene, value, start + 800_000, false); assert.equal(ready.state.boatTravel.phase, "complete"); assert.equal(away(ready.state), false); }
  finally { ready.release(); }
});

test("reduced motion and early server return keep finite static poses and never block claim cleanup", () => {
  const handle = session(), value = boat();
  try {
    value.voyage.returnStartedAt = date(start + 200_000); value.voyage.returnsAt = date(start + 320_000);
    sync(handle.state, scene, value, start, true); assert.equal(away(handle.state), true);
    sync(handle.state, scene, value, start + 320_000, true); assert.equal(away(handle.state), false);
    const still = frame(handle.state, scene, value, start + 320_000, true); assert.equal(still.moving, false); assert.equal(still.passenger, false);
    assert.ok(Number.isFinite(still.x) && Number.isFinite(still.y));
    sync(handle.state, scene, { ...value, voyage: undefined }, start + 320_000, true); assert.equal(handle.state.boatTravel, undefined);
  } finally { handle.release(); }
});

test("a camera awaiting its account snapshot cannot finish the saved voyage", () => {
  const handle = session(), value = boat();
  try {
    sync(handle.state, scene, value, start + 140_000, false);
    const shared = handle.state.boatTravel;
    sync(handle.state, scene, null, start + 150_000, false);
    assert.equal(handle.state.boatTravel, shared);
    assert.equal(shared.phase, "away");
    assert.equal(frame(handle.state, scene, undefined, start + 710_000).passenger, true);
    assert.equal(away(handle.state), true);
  } finally { handle.release(); }
});

test("departing from a garden carry parks the actual basket and keeps its contents", () => {
  const handle = session(), state = handle.state, value = boat();
  try {
    const basket = state.life.garden.basket; assert.ok(basket);
    basket.held = true; basket.berries = 7;
    sync(state, scene, value, start, false);
    assert.equal(state.life.garden.basket, basket);
    assert.equal(basket.held, false);
    assert.equal(basket.berries, 7);
    assert.equal(state.life.garden.routine, null);
    assert.ok(Math.hypot(basket.position.x - state.clearing.position.x, basket.position.y - state.clearing.position.y) < state.clearing.size);
  } finally { handle.release(); }
});
