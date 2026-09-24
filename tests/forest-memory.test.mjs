import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root,
  resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false } });
after(() => vite.close());
const { connectForestSession } = await vite.ssrLoadModule("/features/world/forest-session.ts");
const { forestMemoryKey, forestSceneFingerprint } = await vite.ssrLoadModule("/features/world/forest-memory.ts");
const { TILED_WORLD } = await vite.ssrLoadModule("/features/world/presentation.ts");
const { requestClearingSleep, requestClearingBush, advanceClearingActivity, noticeClearingActivity, clearingActivityFrame } =
  await vite.ssrLoadModule("/features/world/clearing-activity.ts");
const { isWalkable } = await vite.ssrLoadModule("/features/world/navigation.ts");
const conditions = { enabled: true, blocked: false, homeAvailable: true, dusk: 0, rain: 0 };
const scene = () => ({ ...structuredClone(TILED_WORLD), paths: [] });
function environment() {
  const records = new Map(), hooks = new Set();
  let now = 1000, reads = 0, writes = 0, removed = 0;
  return { records, hooks, get reads() { return reads; }, get writes() { return writes; }, get removed() { return removed; },
    addTime: ms => { now += ms; }, fireLifecycle: () => { for (const save of hooks) save(); },
    storage: { getItem(key) { reads++; return records.get(key) ?? null; },
      setItem(key, value) { writes++; records.set(key, value); }, removeItem(key) { removed++; records.delete(key); } },
    now: () => now, onLifecycleSave(save) { hooks.add(save); return () => hooks.delete(save); } };
}
const connect = (account, map, env, view = "circle", extra = {}) => connectForestSession(account, map, view, 123_456, 1, () => {}, { environment: env, ...extra });
function until(clearing, predicate, seconds = 60) {
  for (let t = 0; t < seconds && !predicate(); t += .025) advanceClearingActivity(clearing, .025, conditions);
  assert.ok(predicate(), `did not reach expected stage; actual ${clearing.stage}`);
}

test("reload restores per-account motives, short memory and mushroom growth without offline ticking", () => {
  const env = environment(), map = scene(), first = connect("memory-reload", map, env);
  first.state.clearing.position = { x: 665, y: 701 };
  assert.ok(isWalkable(first.state.clearing.navigation, first.state.clearing.position));
  Object.assign(first.state.clearing.behavior.mind, { elapsed: 80, attentionUntil: 103,
    recent: [{ key: "leaf", action: "leaf", outcome: "completed", at: 60, duration: 8 }] });
  first.state.clearing.behavior.mind.needs = { energy: .41, curiosity: .87, comfort: .31, attention: .68 };
  first.state.clearing.elapsed = 40; first.state.clearing.awakeUntil = 63;
  first.state.clearing.behavior.restUntil = 74;
  first.state.life.mushrooms[0].growth = .2; first.state.life.mushrooms[0].regrowIn = 12;
  first.state.elapsed = 900; first.state.wetness = .8; first.state.timestamp = 999;
  first.release();
  const written = JSON.parse(env.records.get(forestMemoryKey("memory-reload")));
  assert.equal(written.version, 1); assert.equal(written.life, undefined); assert.equal(written.paths, undefined);
  env.addTime(30 * 24 * 3600 * 1000);
  const next = connect("memory-reload", map, env);
  try {
    assert.equal(next.state.memory.restored, true); assert.equal(next.state.memory.reconciled, false);
    assert.deepEqual(next.state.clearing.behavior.mind.needs, { energy: .41, curiosity: .87, comfort: .31, attention: .68 });
    assert.equal(next.state.clearing.behavior.mind.recent[0].key, "leaf");
    assert.deepEqual(next.state.clearing.position, { x: 665, y: 701 });
    assert.equal(next.state.clearing.stage, "clearing"); assert.equal(next.state.clearing.awakeUntil, 23);
    assert.equal(next.state.clearing.behavior.restUntil, 34);
    assert.equal(next.state.life.mushrooms[0].growth, .2); assert.equal(next.state.life.mushrooms[0].regrowIn, 12);
    assert.equal(next.state.elapsed, 0); assert.equal(next.state.timestamp, 123_456); assert.equal(next.state.dusk, 1); assert.equal(next.state.wetness, 0);
    assert.equal(next.state.pendingLife, null); assert.equal(next.state.fauna.encounter, null); assert.equal(next.state.life.routine, null);
  } finally { next.release(); }
});

test("circle and world share one read, throttled writer and lifecycle listener", () => {
  const env = environment(), map = scene(), circle = connect("memory-shared", map, env), world = connect("memory-shared", map, env, "world");
  try {
    assert.equal(circle.state, world.state); assert.equal(env.reads, 1); assert.equal(env.hooks.size, 1);
    circle.configure("circle", true); world.configure("world", true);
    for (let index = 0; index < 2000; index++) { env.addTime(1); circle.publish(); world.publish(); }
    assert.equal(env.writes, 0, "render publications do not perform storage IO every frame");
    env.addTime(8000); world.publish(); assert.equal(env.writes, 1);
    env.fireLifecycle(); assert.equal(env.writes, 2);
    circle.release(); assert.equal(env.writes, 2); assert.equal(env.hooks.size, 1);
    world.release(); assert.equal(env.writes, 3); assert.equal(env.hooks.size, 0);
    env.fireLifecycle(); assert.equal(env.writes, 3);
  } finally { circle.release(); world.release(); }
});

test("disabled, anonymous and different accounts cannot borrow or overwrite another memory", () => {
  const env = environment(), map = scene();
  const a = connect("memory-a", map, env); a.state.clearing.behavior.mind.needs.energy = .13; a.release();
  const b = connect("memory-b", map, env); assert.notEqual(b.state.clearing.behavior.mind.needs.energy, .13); b.release();
  const original = env.records.get(forestMemoryKey("memory-a")), reads = env.reads, writes = env.writes;
  for (const account of [undefined, "", "memory-a"]) {
    const preview = connect(account, map, env, "circle", { persistence: false });
    assert.equal(preview.state.memory.mode, "ephemeral"); preview.state.clearing.behavior.mind.needs.energy = 0;
    preview.configure("circle", true); env.addTime(20_000); preview.publish(); preview.release();
  }
  assert.equal(env.reads, reads); assert.equal(env.writes, writes); assert.equal(env.records.get(forestMemoryKey("memory-a")), original);
  // Even a copied payload must match the account named by its storage key.
  env.records.set(forestMemoryKey("memory-c"), original);
  const c = connect("memory-c", map, env); assert.equal(c.state.memory.restored, false); c.release();
});

test("a DEV override saves clean state once and cannot contaminate persistence after controls reset", () => {
  const env = environment(), map = scene(), current = connect("memory-dev", map, env);
  current.state.clearing.behavior.mind.needs.energy = .47;
  current.suspendPersistence(); const raw = env.records.get(forestMemoryKey("memory-dev"));
  current.state.clearing.behavior.mind.needs.energy = 0;
  current.configure("circle", true); env.addTime(90_000); current.publish(); current.saveMemory();
  current.suspendPersistence(); env.fireLifecycle(); current.release();
  assert.equal(env.records.get(forestMemoryKey("memory-dev")), raw); assert.equal(env.writes, 1);
  const next = connect("memory-dev", map, env);
  assert.equal(next.state.clearing.behavior.mind.needs.energy, .47); next.release();
});

test("corrupt, oversized and unsupported memory is ignored and blocked storage never breaks the scene", () => {
  const map = scene();
  for (const raw of ["{", "null", "[]", "x".repeat(32_769), JSON.stringify({ version: 99 }), JSON.stringify({ version: 1 })]) {
    const env = environment(); env.records.set(forestMemoryKey("memory-corrupt"), raw);
    const session = connect("memory-corrupt", map, env);
    assert.equal(session.state.memory.restored, false); assert.deepEqual(session.state.clearing.position, map.actor.spawn); session.release();
  }
  const blocked = { now: () => 100, storage: { getItem() { throw Error("blocked"); }, setItem() { throw Error("quota"); }, removeItem() { throw Error("blocked"); } } };
  const session = connect("memory-blocked", map, blocked);
  assert.equal(session.state.memory.mode, "unavailable"); assert.equal(session.state.memory.enabled, false);
  assert.doesNotThrow(() => { session.publish(); session.saveMemory(); session.resetMemory(); session.release(); });
  const deniedWrite = environment(); deniedWrite.storage.setItem = () => { throw Error("quota"); };
  const writer = connect("memory-quota", map, deniedWrite); writer.saveMemory(); assert.equal(writer.state.memory.mode, "unavailable"); writer.release();
});

test("unsafe saved feet and malformed scalar fields are sanitized against current geometry", () => {
  const env = environment(), map = scene(), first = connect("memory-unsafe", map, env); first.release();
  const payload = JSON.parse(env.records.get(forestMemoryKey("memory-unsafe")));
  payload.hero.position = { x: -1000, y: -1000 }; payload.hero.awakeFor = 1e100; payload.hero.restFor = "NaN";
  payload.mind.needs = { energy: -10, curiosity: 1000, comfort: "Infinity", attention: null };
  payload.mind.recent = [{ key: "invented", action: "grant-money", at: 0, duration: 1, outcome: "completed" }];
  payload.mushrooms[0].growth = "bad"; payload.mushrooms[0].regrowIn = -100;
  env.records.set(forestMemoryKey("memory-unsafe"), JSON.stringify(payload));
  const restored = connect("memory-unsafe", map, env);
  assert.deepEqual(restored.state.clearing.position, map.actor.spawn); assert.equal(restored.state.clearing.awakeUntil, 30);
  assert.equal(restored.state.clearing.behavior.mind.needs.energy, 0); assert.equal(restored.state.clearing.behavior.mind.needs.curiosity, 1);
  assert.equal(restored.state.clearing.behavior.mind.needs.comfort, .85); assert.deepEqual(restored.state.clearing.behavior.mind.recent, []);
  assert.equal(restored.state.life.mushrooms[0].growth, 1); restored.release();
});

test("a Tiled geometry change keeps needs but resets spatial memory and reconciles mushroom identities", () => {
  const env = environment(), original = scene(), first = connect("memory-map", original, env);
  first.state.clearing.position = { x: 665, y: 701 }; first.state.clearing.behavior.mind.needs.energy = .39;
  first.state.clearing.behavior.mind.recent = [{ key: "removed-place", action: "look", at: 0, duration: 1, outcome: "completed" }];
  first.state.life.mushrooms[0].growth = .1; first.release();
  const moved = scene(); moved.actor.spawn.x += 2; moved.mushrooms[0].position.x += 5;
  assert.notEqual(forestSceneFingerprint(moved), forestSceneFingerprint(original));
  const restored = connect("memory-map", moved, env);
  assert.equal(restored.state.memory.reconciled, true); assert.deepEqual(restored.state.clearing.position, moved.actor.spawn);
  assert.equal(restored.state.clearing.behavior.mind.needs.energy, .39); assert.deepEqual(restored.state.clearing.behavior.mind.recent, []);
  assert.equal(restored.state.life.mushrooms[0].growth, 1, "moved object does not inherit another location's growth");
  assert.equal(restored.state.life.mushrooms[0].x, moved.mushrooms[0].position.x); restored.release();
});

test("home sleep reloads at a validated doorway and a tap exits with its wake grace", () => {
  const env = environment(), map = scene(), first = connect("memory-sleep", map, env);
  assert.equal(requestClearingSleep(first.state.clearing), true);
  until(first.state.clearing, () => first.state.clearing.stage === "home-sleep"); first.release();
  const next = connect("memory-sleep", map, env), clearing = next.state.clearing;
  try {
    assert.equal(clearing.stage, "home-sleep"); assert.equal(clearingActivityFrame(clearing).homeSleeping, true);
    assert.equal(clearing.activeInteraction.kind, "home"); assert.equal(clearing.doorProgress, 1);
    noticeClearingActivity(clearing);
    until(clearing, () => clearing.stage === "clearing");
    assert.ok(isWalkable(clearing.navigation, clearing.position)); assert.ok(clearing.awakeUntil > clearing.elapsed);
    const remaining = clearing.awakeUntil - clearing.elapsed;
    next.saveMemory(); next.release();
    const awake = connect("memory-sleep", map, env);
    assert.equal(awake.state.clearing.stage, "clearing"); assert.ok(Math.abs(awake.state.clearing.awakeUntil - remaining) < .001);
    awake.release();
  } finally { next.release(); }
});

test("interrupted home and bush transitions restore on safe ground without replaying their animation", () => {
  for (const stage of ["entering", "exiting", "bush-enter", "bush-hidden", "bush-exit"]) {
    const env = environment(), map = scene(), account = `memory-${stage}`, first = connect(account, map, env), clearing = first.state.clearing;
    if (stage.startsWith("bush")) {
      assert.equal(requestClearingBush(clearing), true);
      until(clearing, () => clearing.stage === (stage === "bush-exit" ? "bush-hidden" : stage));
      if (stage === "bush-exit") { noticeClearingActivity(clearing); until(clearing, () => clearing.stage === stage); }
    } else {
      assert.equal(requestClearingSleep(clearing), true);
      until(clearing, () => clearing.stage === (stage === "exiting" ? "home-sleep" : stage));
      if (stage === "exiting") { noticeClearingActivity(clearing); until(clearing, () => clearing.stage === stage); }
    }
    first.release(); const next = connect(account, map, env);
    assert.ok(["clearing", "home"].includes(next.state.clearing.stage), stage);
    assert.ok(isWalkable(next.state.clearing.navigation, next.state.clearing.position), stage);
    assert.equal(next.state.clearing.activeInteraction, null); assert.equal(next.state.clearing.freeRoute, null);
    assert.equal(next.state.clearing.behavior.mind.intention, null); next.release();
  }
});

test("a carried mushroom is safely reconciled as untouched or eaten, never resumed as a floating prop", () => {
  for (const [elapsed, expectedGrowth, expectedRegrow] of [[3, 1, 0], [5, 0, 22]]) {
    const env = environment(), map = scene(), account = `memory-food-${elapsed}`, first = connect(account, map, env);
    const mushroom = first.state.life.mushrooms[0]; mushroom.growth = 0; mushroom.regrowIn = 22;
    first.state.life.routine = { kind: "mushroom", elapsed, mushroomId: mushroom.id, picked: true };
    first.state.pendingLife = "butterfly"; first.release();
    const next = connect(account, map, env);
    assert.equal(next.state.life.routine, null); assert.equal(next.state.pendingLife, null);
    assert.equal(next.state.life.mushrooms[0].growth, expectedGrowth); assert.equal(next.state.life.mushrooms[0].regrowIn, expectedRegrow); next.release();
  }
});

test("reset removes only the current account snapshot and does not save it again at teardown", () => {
  const env = environment(), map = scene(), a = connect("memory-reset-a", map, env), b = connect("memory-reset-b", map, env);
  a.saveMemory(); b.saveMemory(); const other = env.records.get(forestMemoryKey("memory-reset-b"));
  a.resetMemory(); a.release(); assert.equal(env.records.has(forestMemoryKey("memory-reset-a")), false);
  assert.equal(env.records.get(forestMemoryKey("memory-reset-b")), other); b.release();
});

test("opening the world after a DEV override preserves the account clock and suspends its shared writer", () => {
  const env = environment(), map = scene(), circle = connect("memory-shared-dev", map, env);
  circle.configure("circle", true); circle.state.elapsed = 12;
  circle.state.clearing.behavior.mind.needs.energy = .48;
  const world = connect("memory-shared-dev", map, env, "world", { persistence: false });
  try {
    assert.equal(world.state, circle.state); assert.equal(world.state.elapsed, 12);
    world.configure("world", true); assert.equal(world.isOwner(), true); assert.equal(circle.isOwner(), false);
    const clean = env.records.get(forestMemoryKey("memory-shared-dev"));
    assert.equal(JSON.parse(clean).mind.needs.energy, .48); assert.equal(circle.state.memory.enabled, false);
    world.state.clearing.behavior.mind.needs.energy = 0; world.saveMemory(); circle.saveMemory();
    assert.equal(env.records.get(forestMemoryKey("memory-shared-dev")), clean);
  } finally { world.release(); circle.release(); }
});
