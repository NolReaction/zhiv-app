import assert from "node:assert/strict";
import test, { after, afterEach } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root,
  resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false } });
after(() => vite.close());
const { connectForestSession, forgetForestSession } = await vite.ssrLoadModule("/features/world/state/forest-session.ts");
const { advanceBuilderMind } = await vite.ssrLoadModule("/features/world/characters/builder/builder-mind.ts");
const { advancePleskMind } = await vite.ssrLoadModule("/features/world/characters/plesk/plesk-mind.ts");
const { forestMemoryKey } = await vite.ssrLoadModule("/features/world/state/memory/forest-memory.ts");
const { TILED_WORLD } = await vite.ssrLoadModule("/features/world/scene/presentation.ts");
const handles = [], accounts = new Set();
afterEach(() => {
  for (const handle of handles.splice(0)) handle.release();
  for (const account of accounts) forgetForestSession(account);
  accounts.clear();
});
function environment() {
  const records = new Map(), hooks = new Set();
  let now = 1000, reads = 0;
  return { records, hooks, get reads() { return reads; }, addTime(ms) { now += ms; }, now: () => now,
    storage: { getItem(key) { reads++; return records.get(key) ?? null; },
      setItem(key, value) { records.set(key, value); }, removeItem(key) { records.delete(key); } },
    onLifecycleSave(save) { hooks.add(save); return () => hooks.delete(save); } };
}
function connect(account, env, map = TILED_WORLD, extra = {}, view = "circle") {
  accounts.add(account);
  const handle = connectForestSession(account, map, view, env.now(), 0, () => {},
    { environment: env, sync: false, ...extra });
  handles.push(handle); return handle;
}

test("reopening the same account forest keeps all residents and their live journey without offline ticking", () => {
  const env = environment(), first = connect("retained-residents", env);
  first.configure("circle", true, true);
  for (let i = 0; i < 200; i++) {
    advanceBuilderMind(first.state.builderMind, TILED_WORLD, .05, { now: env.now(), construction: undefined });
    advancePleskMind(first.state.pleskMind, TILED_WORLD, .05, { rain: 0, dusk: 0, playerNear: false });
  }
  first.state.elapsed = 10;
  const state = first.state, clearing = state.clearing, builder = state.builderMind, plesk = state.pleskMind;
  const before = { builder: structuredClone(builder), plesk: structuredClone(plesk), elapsed: state.elapsed };
  first.release({ retain: true }); env.addTime(5 * 60_000);
  const next = connect("retained-residents", env, TILED_WORLD, {}, "world");
  assert.equal(next.state, state); assert.equal(next.state.clearing, clearing);
  assert.equal(next.state.builderMind, builder); assert.equal(next.state.pleskMind, plesk);
  assert.deepEqual({ builder, plesk, elapsed: state.elapsed }, before);
  assert.equal(env.reads, 1, "UI remount does not hydrate the local snapshot again");
  assert.equal(env.hooks.size, 1, "one account session keeps one local save lifecycle");
  const saved = JSON.parse(env.records.get(forestMemoryKey("retained-residents")));
  assert.equal(saved.builderMind, undefined); assert.equal(saved.pleskMind, undefined);
  assert.equal(saved.hero.route, undefined, "live route retention does not extend the persisted wire format");
});

test("unopted teardown is a reload boundary and discards transient resident clocks", () => {
  const env = environment(), first = connect("retention-opt-in", env);
  first.state.elapsed = 29; first.state.builderMind.elapsed = 29;
  const previous = first.state; first.release();
  const next = connect("retention-opt-in", env);
  assert.notEqual(next.state, previous); assert.equal(next.state.elapsed, 0);
  assert.equal(next.state.builderMind.elapsed, 0); assert.equal(env.reads, 2);
});

test("only one dormant account is retained and changing account cannot borrow its resident state", () => {
  const env = environment(), first = connect("retained-account-a", env), previous = first.state;
  first.state.elapsed = 41; first.release({ retain: true });
  assert.equal(env.hooks.size, 1);
  const second = connect("retained-account-b", env);
  assert.notEqual(second.state, previous); assert.equal(second.state.elapsed, 0);
  assert.equal(env.hooks.size, 1, "eviction closes the old local lifecycle listener");
  second.release({ retain: true });
  const reopened = connect("retained-account-a", env);
  assert.notEqual(reopened.state, previous); assert.equal(reopened.state.elapsed, 0);
  assert.equal(env.hooks.size, 1);
});

test("a changed map never revives the retained route of an earlier geometry", () => {
  const env = environment(), first = connect("retained-geometry", env), previous = first.state;
  first.state.elapsed = 37; first.release({ retain: true });
  const changed = { ...TILED_WORLD, destinations: TILED_WORLD.destinations.map((destination, index) => index
    ? destination : { ...destination, position: { ...destination.position, x: destination.position.x + 1 } }) };
  const moved = connect("retained-geometry", env, changed);
  assert.notEqual(moved.state, previous); assert.equal(moved.state.elapsed, 0);
  moved.release({ retain: true });
  const restored = connect("retained-geometry", env);
  assert.notEqual(restored.state, previous, "return to prior geometry cannot retrieve an old dormant route");
  assert.equal(env.hooks.size, 1);
});

test("logout invalidates retained state even when canvas cleanup asks to retain later", () => {
  const env = environment(), first = connect("retained-logout", env), previous = first.state;
  first.configure("circle", true, true); first.state.elapsed = 53;
  forgetForestSession("retained-logout"); first.release({ retain: true });
  assert.equal(env.hooks.size, 0);
  const next = connect("retained-logout", env);
  assert.notEqual(next.state, previous); assert.equal(next.state.elapsed, 0);
  const latest = next.state; next.release({ retain: true }); forgetForestSession("retained-logout");
  assert.equal(env.hooks.size, 0);
  assert.notEqual(connect("retained-logout", env).state, latest, "logout also clears an already dormant forest");
});

test("DEV suspension, memory reset and disabled persistence cannot retain altered simulation", () => {
  for (const mode of ["disabled", "suspended", "reset"]) {
    const env = environment(), account = `retained-dev-${mode}`;
    const first = connect(account, env, TILED_WORLD, mode === "disabled" ? { persistence: false } : {});
    if (mode === "suspended") first.suspendPersistence();
    if (mode === "reset") first.resetMemory();
    first.state.elapsed = 999; first.state.builderMind.elapsed = 999;
    const previous = first.state; first.release({ retain: true });
    const next = connect(account, env);
    assert.notEqual(next.state, previous); assert.equal(next.state.elapsed, 0);
    assert.equal(next.state.builderMind.elapsed, 0);
    next.release(); assert.equal(env.hooks.size, 0);
  }
});
