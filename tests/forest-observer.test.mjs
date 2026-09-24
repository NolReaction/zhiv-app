import assert from "node:assert/strict";
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
const connect = (key, view = "circle") => connectForestSession(key, TILED_WORLD, view, 0, 0, () => {}, { persistence: false });

test("observations are isolated, bounded and detached; last renderer removes an account's snapshot", async () => {
  const a = connect("observer-a"), b = connect("observer-b"), world = connect("observer-a", "world");
  let notifications = 0;
  const unsubscribe = subscribeForestObservation("observer-a", () => notifications++);
  try {
    assert.equal(getServerForestObservation(), null); assert.equal(getForestObservation(undefined), null);
    a.state.clearing.behavior.mind.needs.energy = .23;
    publishForestObservation("observer-a", a.state, { now: 0 });
    publishForestObservation("observer-b", b.state, { now: 0 });
    const snapshot = getForestObservation("observer-a");
    a.state.clearing.behavior.mind.needs.energy = .9;
    assert.equal(snapshot.needs.energy, .23);
    assert.ok(Object.isFrozen(snapshot.needs)); assert.ok(Object.isFrozen(snapshot.diagnostics.events));
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

test("DEV inspection preserves memory, forced actions and simulation conditions disable it", () => {
  const levels = WORLD_DEV_DEFAULTS.levels;
  for (const patch of [{}, { paused: true }, { debugNavigation: true, debugWater: true, debugFauna: true },
    { cameraEvent: { id: 1, action: "pet" }, equipment: { palette: "test", head: null, neck: null } }])
    assert.equal(forestPersistenceOverridden({ ...WORLD_DEV_DEFAULTS, ...patch }, levels), false);
  for (const patch of [{ weather: "rain" }, { timeOfDay: "night" }, { navigationMode: "routes" },
    { autoLife: false }, { pose: "sleep" }, { lifeEvent: { id: 1, kind: "home-sleep" } }, { birdEvent: 1 },
    { reducedMotion: "on" }, { animation: { id: 1, pose: "jump" } }, { levels: { ...levels, home: 99 } }])
    assert.equal(forestPersistenceOverridden({ ...WORLD_DEV_DEFAULTS, ...patch }, levels), true, JSON.stringify(patch));
});
