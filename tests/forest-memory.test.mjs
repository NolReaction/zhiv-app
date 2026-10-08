import assert from "node:assert/strict";
import { withPlacedBushArtwork } from "./helpers/forest-bush-fixture.mjs";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root,
  resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false } });
after(() => vite.close());
const { connectForestSession } = await vite.ssrLoadModule("/features/world/state/forest-session.ts");
const { forestMemoryKey, forestSceneFingerprint } = await vite.ssrLoadModule("/features/world/state/memory/forest-memory.ts");
const { forestMindMotives } = await vite.ssrLoadModule("/features/world/simulation/forest-mind.ts");
const { forestMemoryPayloadSchema } = await vite.ssrLoadModule("/features/world/state/memory/forest-memory-model.ts");
const { advanceForestDirector, requestForestDirective } = await vite.ssrLoadModule("/features/world/simulation/forest-director.ts");
const { TILED_WORLD } = await vite.ssrLoadModule("/features/world/scene/presentation.ts");
const { requestClearingSleep, requestClearingBush, advanceClearingActivity, noticeClearingActivity, clearingActivityFrame } =
  await vite.ssrLoadModule("/features/world/simulation/clearing-activity.ts");
const { isWalkable } = await vite.ssrLoadModule("/features/world/navigation/navigation.ts");
const conditions = { enabled: true, blocked: false, homeAvailable: true, dusk: 0, rain: 0 };
const scene = () => ({ ...withPlacedBushArtwork(TILED_WORLD), paths: [] });

test("moving a destination invalidates saved travel geometry while a visual mask does not", () => {
  const map = scene(), fingerprint = forestSceneFingerprint(map);
  const moved = { ...map, destinations: map.destinations.map((destination, index) => index
    ? destination : { ...destination, position: { x: destination.position.x + 12, y: destination.position.y } }) };
  assert.notEqual(forestSceneFingerprint(moved), fingerprint);
  assert.equal(forestSceneFingerprint({ ...map, occluders: [] }), fingerprint);
});

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
  const motives = forestMindMotives(first.state.clearing.behavior.mind);
  first.state.clearing.elapsed = 40; first.state.clearing.awakeUntil = 63;
  first.state.clearing.behavior.restUntil = 74;
  first.state.life.mushrooms[0].growth = .2; first.state.life.mushrooms[0].regrowIn = 12;
  first.state.elapsed = 900; first.state.wetness = .8; first.state.timestamp = 999;
  first.release();
  const written = JSON.parse(env.records.get(forestMemoryKey("memory-reload")));
  assert.equal(written.version, 2); assert.equal(written.life, undefined); assert.equal(written.paths, undefined);
  assert.deepEqual(Object.keys(written.mind.needs).sort(), ["attention", "comfort", "curiosity", "energy"]);
  assert.equal(written.mind.arousal, undefined); assert.equal(written.mind.motives, undefined);
  env.addTime(30 * 24 * 3600 * 1000);
  const next = connect("memory-reload", map, env);
  try {
    assert.equal(next.state.memory.restored, true); assert.equal(next.state.memory.reconciled, false);
    assert.deepEqual(next.state.clearing.behavior.mind.needs, { energy: .41, curiosity: .87, comfort: .31, attention: .68 });
    assert.equal(next.state.clearing.behavior.mind.recent[0].key, "leaf");
    const recovered = forestMindMotives(next.state.clearing.behavior.mind);
    assert.equal(recovered.saturation, motives.saturation); assert.equal(recovered.variety, motives.variety);
    assert.ok(recovered.arousal > .5 && recovered.arousal <= 1, "activation is reconstructed from existing attention and impressions");
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

test("v2 garden remembers moisture, growth, watering cooldown and deposited fruit without offline progress", () => {
  const env = environment(), map = scene(), first = connect("garden-memory", map, env);
  const garden = first.state.life.garden;
  assert.ok(garden.bushes.length && garden.basket, "the authored clearing has a usable berry garden");
  Object.assign(garden.bushes[0], { growth: .63, moisture: .82, waterIn: 240 });
  garden.basket.berries = 6;
  Object.assign(first.state.clearing.behavior.mind, { elapsed: 30,
    recent: [{ key: "water-bush", action: "water-bush", at: 20, duration: 8, outcome: "completed" }] });
  first.release();
  const saved = JSON.parse(env.records.get(forestMemoryKey("garden-memory")));
  const { account, savedAt, ...payload } = saved;
  assert.equal(account, "garden-memory"); assert.ok(savedAt > 0);
  assert.equal(forestMemoryPayloadSchema.safeParse(payload).success, true);
  assert.deepEqual(Object.keys(saved.garden).sort(), ["basketBerries", "bushes"]);
  assert.equal(saved.garden.routine, undefined);
  env.addTime(30 * 24 * 3600 * 1000);
  const next = connect("garden-memory", map, env);
  try {
    const restored = next.state.life.garden;
    assert.equal(restored.bushes[0].growth, .63); assert.equal(restored.bushes[0].moisture, .82);
    assert.equal(restored.bushes[0].waterIn, 240); assert.equal(restored.basket.berries, 6);
    assert.equal(restored.elapsed, 0); assert.equal(restored.routine, null);
    assert.equal(next.state.clearing.behavior.mind.recent[0].action, "water-bush");
  } finally { next.release(); }
});

test("an existing v1 account keeps its original memory and upgrades in the same local storage slot", () => {
  const env = environment(), map = scene(), first = connect("garden-legacy", map, env);
  first.state.clearing.behavior.mind.needs.energy = .38; first.state.life.mushrooms[0].growth = .42; first.release();
  const key = forestMemoryKey("garden-legacy"), old = JSON.parse(env.records.get(key));
  old.version = 1; delete old.garden;
  env.records.set(key, JSON.stringify(old));
  const next = connect("garden-legacy", map, env);
  assert.equal(next.state.memory.restored, true);
  assert.equal(next.state.clearing.behavior.mind.needs.energy, .38); assert.equal(next.state.life.mushrooms[0].growth, .42);
  assert.equal(next.state.life.garden.basket.berries, 0); next.release();
  assert.equal(env.records.size, 1); assert.equal(JSON.parse(env.records.get(key)).version, 2);
});

test("edited or ambiguous bushes cannot borrow saved growth while deposited fruit survives a same-map edit", () => {
  const env = environment(), original = scene(), first = connect("garden-reconcile", original, env);
  Object.assign(first.state.life.garden.bushes[0], { growth: .91, moisture: .97, waterIn: 500 });
  first.state.life.garden.basket.berries = 3; first.release();
  const key = forestMemoryKey("garden-reconcile"), saved = env.records.get(key);
  const moved = scene(); moved.bushes[0].entry.x += .5;
  const pristine = connect(undefined, moved, environment()), expected = { ...pristine.state.life.garden.bushes[0] }; pristine.release();
  const next = connect("garden-reconcile", moved, env);
  assert.equal(next.state.memory.reconciled, true);
  for (const field of ["growth", "moisture", "waterIn"]) assert.equal(next.state.life.garden.bushes[0][field], expected[field]);
  assert.equal(next.state.life.garden.basket.berries, 3); next.release();
  const duplicated = JSON.parse(saved); duplicated.garden.bushes.push({ ...duplicated.garden.bushes[0] });
  env.records.set(key, JSON.stringify(duplicated));
  const clean = connect(undefined, original, environment()), freshGrowth = clean.state.life.garden.bushes[0].growth; clean.release();
  const ambiguous = connect("garden-reconcile", original, env);
  assert.equal(ambiguous.state.life.garden.bushes[0].growth, freshGrowth); ambiguous.release();
});

test("moving the authored basket creates a new session and preserves garden progress at its new home", () => {
  const env = environment(), original = scene(), first = connect("garden-moved-basket", original, env);
  const garden = first.state.life.garden;
  assert.ok(original.basket && garden.basket);
  Object.assign(garden.bushes[0], { growth: .63, moisture: .82, waterIn: 240 });
  garden.basket.berries = 6;
  garden.basket.position = { x: 665, y: 701 };
  first.saveMemory();
  const moved = scene();
  moved.basket.position = { x: original.basket.position.x + 8, y: original.basket.position.y };
  assert.notEqual(forestSceneFingerprint(moved), forestSceneFingerprint(original));
  const next = connect("garden-moved-basket", moved, env, "world");
  try {
    assert.notEqual(next.state, first.state, "a different basket marker must not reuse the old mounted session");
    assert.equal(next.state.memory.restored, true);
    assert.equal(next.state.memory.reconciled, true);
    const restored = next.state.life.garden;
    assert.ok(restored.basket, "the moved marker has a safe approach");
    assert.deepEqual(restored.basket.position, moved.basket.position);
    assert.deepEqual(restored.basket.homePosition, moved.basket.position);
    assert.notDeepEqual(restored.basket.position, garden.basket.position, "a dropped basket position is not restored");
    assert.equal(restored.basket.berries, 6);
    assert.equal(restored.bushes[0].growth, .63);
    assert.equal(restored.bushes[0].moisture, .82);
    assert.equal(restored.bushes[0].waterIn, 240);
    assert.equal(restored.routine, null);
  } finally { first.release(); next.release(); }
});

test("reload during a real harvest keeps the uncommitted fruit and resets the carried basket safely", () => {
  const env = environment(), map = scene(), first = connect("garden-carry", map, env);
  const garden = first.state.life.garden, home = { ...garden.basket.position };
  garden.bushes[0].growth = 1;
  const options = { autoLife: false, blocked: false, homeAvailable: true, dusk: 0, rain: 0 };
  requestForestDirective(first.state, "harvest-berries", options);
  for (let t = 0; t < 120 && garden.routine?.phase !== "return-basket"; t += .025)
    advanceForestDirector(first.state, .025, options);
  assert.equal(garden.routine?.phase, "return-basket", first.state.director.reason);
  assert.equal(garden.routine.carryingBasket, true);
  const before = { growth: garden.bushes[0].growth, berries: garden.basket.berries };
  first.release();
  const next = connect("garden-carry", map, env);
  try {
    assert.equal(next.state.life.garden.routine, null);
    assert.equal(next.state.life.garden.bushes[0].growth, before.growth);
    assert.equal(next.state.life.garden.basket.berries, before.berries);
    assert.deepEqual(next.state.life.garden.basket.position, home);
    assert.ok(isWalkable(next.state.clearing.navigation, next.state.clearing.position));
  } finally { next.release(); }
});

test("DEV ripening and harvest cannot contaminate the saved account garden", () => {
  const env = environment(), map = scene(), current = connect("garden-dev", map, env);
  const garden = current.state.life.garden;
  garden.bushes[0].growth = .25; garden.basket.berries = 3;
  current.suspendPersistence(); const clean = env.records.get(forestMemoryKey("garden-dev"));
  garden.bushes[0].growth = 1; garden.basket.berries = 12;
  env.addTime(20_000); current.publish(); current.saveMemory(); env.fireLifecycle(); current.release();
  assert.equal(env.records.get(forestMemoryKey("garden-dev")), clean);
  const next = connect("garden-dev", map, env);
  assert.equal(next.state.life.garden.bushes[0].growth, .25); assert.equal(next.state.life.garden.basket.berries, 3); next.release();
});

test("a temporarily unplaceable basket retains its deposited fruit until a safe spot exists again", () => {
  const env = environment(), map = scene(), first = connect("garden-unplaced", map, env);
  first.state.life.garden.basket.berries = 6; first.release();
  const blocked = scene(); blocked.basket.position = { x: 0, y: 0 };
  const unavailable = connect("garden-unplaced", blocked, env);
  try {
    assert.equal(unavailable.state.memory.restored, true);
    assert.equal(unavailable.state.life.garden.basket, null, "an invalid explicit marker is not silently relocated");
    assert.equal(unavailable.state.life.garden.unplacedBerries, 6);
    unavailable.saveMemory();
  } finally { unavailable.release(); }
  assert.equal(JSON.parse(env.records.get(forestMemoryKey("garden-unplaced"))).garden.basketBerries, 6);
  const restored = connect("garden-unplaced", map, env);
  try {
    assert.equal(restored.state.life.garden.basket.berries, 6);
    assert.deepEqual(restored.state.life.garden.basket.position, map.basket.position);
    assert.equal(restored.state.life.garden.unplacedBerries, 0);
  } finally { restored.release(); }
});

test("pending shrub artwork preserves growth and delivered fruit across saves until placement resumes", () => {
  const env = environment(), pending = structuredClone(TILED_WORLD);
  pending.bushes[0].imageId = "memory-independent-shrub";
  const placed = withPlacedBushArtwork(pending), first = connect("garden-staged-art", placed, env);
  Object.assign(first.state.life.garden.bushes[0], { growth: .83, moisture: .47, waterIn: 215 });
  first.state.life.garden.basket.berries = 6; first.release();
  const staged = connect("garden-staged-art", pending, env);
  assert.equal(staged.state.life.garden.bushes[0].workPosition, null);
  assert.equal(staged.state.life.garden.bushes[0].growth, .83);
  assert.equal(staged.state.life.garden.bushes[0].moisture, .47);
  assert.equal(staged.state.life.garden.bushes[0].waterIn, 215);
  assert.equal(requestClearingBush(staged.state.clearing), false);
  staged.release();
  const saved = JSON.parse(env.records.get(forestMemoryKey("garden-staged-art")));
  assert.equal(saved.garden.bushes.length, 1); assert.equal(saved.garden.basketBerries, 6);
  const resumed = connect("garden-staged-art", placed, env);
  assert.ok(resumed.state.life.garden.bushes[0].workPosition);
  assert.equal(resumed.state.life.garden.bushes[0].growth, .83);
  assert.equal(resumed.state.life.garden.basket.berries, 6); resumed.release();
});
