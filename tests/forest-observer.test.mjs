import assert from "node:assert/strict";
import { withPlacedBushArtwork } from "./helpers/forest-bush-fixture.mjs";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root,
  resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false } });
after(() => vite.close());
const { connectForestSession } = await vite.ssrLoadModule("/features/world/forest-session.ts");
const { forestObservationFrame, getForestObservation, getServerForestObservation, publishForestObservation, subscribeForestObservation } =
  await vite.ssrLoadModule("/features/world/forest-observer.ts");
const { forestPersistenceOverridden } = await vite.ssrLoadModule("/features/world/forest-dev-memory.ts");
const { WORLD_DEV_DEFAULTS } = await vite.ssrLoadModule("/features/world/dev/world-dev-store.ts");
const { TILED_WORLD } = await vite.ssrLoadModule("/features/world/presentation.ts");
const connect = (key, view = "circle", scene = TILED_WORLD) => connectForestSession(key, scene, view, 0, 0, () => {}, { persistence: false });

test("observations are isolated, bounded and detached; last renderer removes an account's snapshot", async () => {
  const a = connect("observer-a"), b = connect("observer-b"), world = connect("observer-a", "world");
  let notifications = 0;
  const unsubscribe = subscribeForestObservation("observer-a", () => notifications++);
  try {
    assert.equal(getServerForestObservation(), null); assert.equal(getForestObservation(undefined), null);
    a.state.clearing.behavior.mind.needs.energy = .23;
    a.state.clearing.behavior.mind.arousal = .63;
    publishForestObservation("observer-a", a.state, { now: 0 });
    publishForestObservation("observer-b", b.state, { now: 0 });
    const snapshot = getForestObservation("observer-a");
    a.state.clearing.behavior.mind.needs.energy = .9;
    a.state.clearing.behavior.mind.arousal = .1;
    assert.equal(snapshot.needs.energy, .23);
    assert.ok(Object.isFrozen(snapshot.needs)); assert.ok(Object.isFrozen(snapshot.diagnostics.events));
    assert.equal(snapshot.diagnostics.motives.arousal, .63);
    assert.ok(Object.isFrozen(snapshot.diagnostics.motives));
    assert.notEqual(getForestObservation("observer-b").needs.energy, .23);
    await Promise.resolve(); assert.equal(notifications, 1);
    a.release(); assert.equal(getForestObservation("observer-a"), snapshot);
    world.release(); await Promise.resolve(); assert.equal(getForestObservation("observer-a"), null);
    assert.ok(getForestObservation("observer-b")); assert.equal(notifications, 2);
  } finally { unsubscribe(); a.release(); world.release(); b.release(); }
});

test("render frames do not spam subscribers, but a sleeping/waking transition is immediate", async () => {
  const session = connect("observer-frequency"); let calls = 0;
  const unsubscribe = subscribeForestObservation("observer-frequency", () => calls++);
  try {
    publishForestObservation("observer-frequency", session.state, { now: 0 }); await Promise.resolve();
    const first = getForestObservation("observer-frequency");
    for (let now = 1; now < 500; now++) {
      session.state.clearing.behavior.mind.needs.energy -= .00001;
      publishForestObservation("observer-frequency", session.state, { now });
    }
    await Promise.resolve(); assert.equal(calls, 1); assert.equal(getForestObservation("observer-frequency"), first);
    session.state.clearing.stage = "home-sleep";
    publishForestObservation("observer-frequency", session.state, { now: 100 }); await Promise.resolve();
    assert.equal(calls, 2); assert.equal(getForestObservation("observer-frequency").activity, "Спит в домике");
    session.state.clearing.stage = "exiting";
    publishForestObservation("observer-frequency", session.state, { now: 101 }); await Promise.resolve();
    assert.equal(calls, 3); assert.equal(getForestObservation("observer-frequency").activity, "Возвращается на полянку");
  } finally { unsubscribe(); session.release(); }
});

test("player state explains the actual encounter phase and distinguishes intention from home sleep", () => {
  const session = connect("observer-phases"), state = session.state;
  try {
    state.clearing.behavior.mind.intention = { key: "home-sleep", action: "home-sleep", reason: "Устал", source: "director", startedAt: 0 };
    assert.equal(forestObservationFrame(state).sleeping, false);
    state.fauna.encounter = { kind: "butterfly", phase: "approach" };
    assert.equal(forestObservationFrame(state).activity, "Заметил бабочку");
    state.fauna.encounter.phase = "perch";
    assert.equal(forestObservationFrame(state).activity, "Играет с бабочкой");
    state.fauna.encounter.phase = "release";
    assert.equal(forestObservationFrame(state).activity, "Провожает бабочку");
    state.pendingAttention = true;
    assert.equal(forestObservationFrame(state).activity, "Отвлекается на тебя");
    assert.equal(forestObservationFrame(state, { manual: true }).activity, "Показывает анимацию");
  } finally { session.release(); }
});

test("only the active world observes shared motion while the hidden circle cannot report pause", () => {
  const circle = connect("observer-owner"), world = connect("observer-owner", "world");
  try {
    circle.configure("circle", true); world.configure("world", true);
    assert.equal(world.isObservationOwner(), true); assert.equal(circle.isObservationOwner(), false);
    world.configure("world", false);
    assert.equal(circle.isObservationOwner(), true); assert.equal(world.isObservationOwner(), false);
    circle.configure("circle", false); assert.equal(circle.isObservationOwner(), true);
  } finally { world.release(); circle.release(); }
});

test("memory status does not promise persistence when DEV disables writes or storage fails", () => {
  const session = connect("observer-memory");
  try {
    Object.assign(session.state.memory, { mode: "local", enabled: true, restored: true, lastSavedAt: 2000 });
    assert.equal(forestObservationFrame(session.state).memory.status, "restored");
    session.state.memory.enabled = false;
    assert.equal(forestObservationFrame(session.state).memory.status, "session");
    session.state.memory.mode = "unavailable";
    assert.equal(forestObservationFrame(session.state).memory.status, "unavailable");
  } finally { session.release(); }
});

test("remote writer pauses observation and publishes lease changes immediately without exposing mutable state", () => {
  const session = connect("observer-server-memory");
  try {
    session.state.memory.sync = { mode: "synced", revision: 1, serverSavedAt: 1234, canTakeOver: false };
    publishForestObservation("observer-server-memory", session.state, { now: 0 });
    session.state.memory.sync = { mode: "other-device", revision: 2, serverSavedAt: 1234, canTakeOver: true };
    publishForestObservation("observer-server-memory", session.state, { now: 1 });
    const snapshot = getForestObservation("observer-server-memory");
    assert.equal(snapshot.paused, true); assert.equal(snapshot.memory.sync.canTakeOver, true);
    session.state.memory.sync.revision = 99;
    assert.equal(snapshot.memory.sync.revision, 2); assert.ok(Object.isFrozen(snapshot.memory.sync));
  } finally { session.release(); }
});

test("DEV inspection preserves memory, forced actions and simulation conditions disable it", () => {
  const levels = WORLD_DEV_DEFAULTS.levels;
  for (const patch of [{}, { paused: true }, { debugNavigation: true, debugWater: true, debugFauna: true },
    { cameraEvent: { id: 1, action: "pet" }, equipment: { palette: "test", head: null, neck: null } }])
    assert.equal(forestPersistenceOverridden({ ...WORLD_DEV_DEFAULTS, ...patch }, levels), false);
  for (const patch of [{ weather: "rain" }, { timeOfDay: "night" }, { navigationMode: "routes" },
    { autoLife: false }, { pose: "sleep" }, { lifeEvent: { id: 1, kind: "home-sleep" } }, { birdEvent: 1 },
    ...["water-bush", "harvest-berries", "grow-berries"].map(kind => ({ lifeEvent: { id: 1, kind } })),
    { reducedMotion: "on" }, { animation: { id: 1, pose: "jump" } }, { levels: { ...levels, home: 99 } }])
    assert.equal(forestPersistenceOverridden({ ...WORLD_DEV_DEFAULTS, ...patch }, levels), true, JSON.stringify(patch));
});

test("garden observation is bounded and detached, while phases keep a stable purpose and immediate detail", async () => {
  const session = connect("observer-garden"), state = session.state, garden = state.life.garden;
  let calls = 0;
  const unsubscribe = subscribeForestObservation("observer-garden", () => calls++);
  try {
    assert.ok(garden.bushes.length);
    garden.bushes[0].growth = .54; garden.bushes[0].moisture = .32;
    garden.routine = { kind: "harvest-berries", bushId: garden.bushes[0].id, phase: "approach-basket", elapsed: 0, totalElapsed: 0, carryingBasket: false };
    publishForestObservation("observer-garden", state, { now: 0 }); await Promise.resolve();
    const first = getForestObservation("observer-garden");
    assert.equal(first.activity, "Собирает ягоды в корзинку");
    assert.match(first.detail, /Идёт за корзинкой/);
    assert.equal(first.diagnostics.garden.bushes[0].growth, .54);
    garden.bushes[0].growth = Infinity; garden.bushes[0].moisture = -2;
    garden.basket.berries = 300;
    garden.routine.phase = "collect"; garden.routine.carryingBasket = true;
    publishForestObservation("observer-garden", state, { now: 1 }); await Promise.resolve();
    const next = getForestObservation("observer-garden");
    assert.equal(calls, 2, "semantic phase changes do not wait for the meter throttle");
    assert.equal(next.activity, first.activity, "the main label follows the purpose, not every small motion");
    assert.match(next.detail, /снимает спелые ягоды/);
    assert.equal(next.diagnostics.garden.bushes[0].growth, 0);
    assert.equal(next.diagnostics.garden.bushes[0].moisture, 0);
    assert.equal(next.diagnostics.garden.basket.berries, 12);
    assert.equal(first.diagnostics.garden.bushes[0].growth, .54);
    assert.equal(first.diagnostics.garden.activity.phase, "approach-basket");
    for (const value of [first.diagnostics.garden, first.diagnostics.garden.bushes, first.diagnostics.garden.bushes[0], first.diagnostics.garden.basket, first.diagnostics.garden.activity])
      assert.ok(Object.isFrozen(value));
    state.pendingAttention = true;
    assert.equal(forestObservationFrame(state).activity, "Отвлекается на тебя");
    state.pendingAttention = false; garden.routine = null;
    state.director.reason = "Точка подхода к кусту недоступна";
    assert.equal(forestObservationFrame(state).diagnostics.reason, state.director.reason);
  } finally { unsubscribe(); session.release(); }
});

test("garden availability explains ripe, watered, full and missing basket states without changing progress", () => {
  const session = connect("observer-garden-availability", "circle", withPlacedBushArtwork(TILED_WORLD)), state = session.state, garden = state.life.garden;
  try {
    const read = () => forestObservationFrame(state).diagnostics.garden;
    const before = structuredClone(garden);
    assert.equal(read().waterReason, null);
    assert.match(read().harvestReason, /ещё растут/);
    assert.deepEqual(garden, before);
    garden.bushes[0].growth = 1;
    assert.equal(read().harvestReason, null);
    assert.match(read().waterReason, /уже созрели/);
    garden.basket.berries = 12;
    assert.match(read().harvestReason, /заполнена/);
    garden.basket = null;
    assert.match(read().harvestReason, /свободное место/);
    garden.bushes = [];
    assert.match(read().waterReason, /Нет ягодного куста/);
  } finally { session.release(); }
});

test("unreachable ripe bushes explain the missing work position instead of recommending more growth", () => {
  const session = connect("observer-garden-unreachable", "circle", withPlacedBushArtwork(TILED_WORLD)), state = session.state, garden = state.life.garden;
  try {
    assert.ok(garden.bushes.length);
    for (const bush of garden.bushes) { bush.growth = 1; bush.workPosition = null; }
    const before = structuredClone(garden), observation = forestObservationFrame(state).diagnostics.garden;
    for (const reason of [observation.waterReason, observation.harvestReason]) {
      assert.match(reason, /Нет безопасной точки подхода к кусту/);
      assert.doesNotMatch(reason, /ещё растут|влажный|уже созрели|Созреть ягодам/);
    }
    assert.deepEqual(garden, before, "diagnostics cannot create a work position or change ripe fruit");
  } finally { session.release(); }
});

test("the unplaced shrub explains missing artwork rather than directing the author to change navigation", () => {
  const session = connect("observer-garden-pending");
  try {
    const before = structuredClone(session.state.life.garden), garden = forestObservationFrame(session.state).diagnostics.garden;
    assert.match(garden.waterReason, /Разместите картинку куста/);
    assert.equal(garden.waterReason, garden.harvestReason);
    assert.deepEqual(session.state.life.garden, before);
  } finally { session.release(); }
});

test("birdwatch transitions publish immediately and do not claim an insect encounter", async () => {
  const session = connect("observer-birdwatch"), state = session.state;
  try {
    publishForestObservation("observer-birdwatch", state, { now: 0 });
    state.director.birdwatch = { birdId: "branch-bird", target: { x: 500, y: 600 }, lookTarget: { x: 500, y: 600 }, elapsed: 1, duration: 6, missingSeconds: 0 };
    publishForestObservation("observer-birdwatch", state, { now: 1 });
    assert.equal(getForestObservation("observer-birdwatch").activity, "Наблюдает за птицей");
    assert.equal(state.fauna.encounter, null);
    state.director.birdwatch = null;
    publishForestObservation("observer-birdwatch", state, { now: 2 });
    assert.notEqual(getForestObservation("observer-birdwatch").activity, "Наблюдает за птицей");
  } finally { session.release(); }
});
