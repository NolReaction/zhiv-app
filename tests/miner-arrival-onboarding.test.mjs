import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, cacheDir: `/tmp/zhiv-miner-arrival-${process.pid}`,
  resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false } });
after(() => vite.close());
const { minerArrivalCanStart, parseMinerArrivalProgress } = await vite.ssrLoadModule("/features/world/domain/miner-arrival-onboarding.ts");
const { createMinerArrivalStore, minerArrivalStorageKey } = await vite.ssrLoadModule("/features/world/state/miner-arrival-storage.ts");
const available = { loaded: true, unlocked: true, enabled: true, onboarding: { loaded: true, isPaused: false, progress: { version: 2, status: "completed" } } };
function storage() { const map = new Map(); return { getItem: key => map.get(key) ?? null, setItem: (key, value) => map.set(key, value), map }; }

test("arrival waits for a confirmed quarry, a free map and the completed or paused initial course", () => {
  assert.equal(minerArrivalCanStart(available), true);
  for (const patch of [{ loaded: false }, { unlocked: false }, { enabled: false },
    { onboarding: { ...available.onboarding, loaded: false } },
    { onboarding: { ...available.onboarding, progress: null } },
    { onboarding: { ...available.onboarding, progress: { version: 2, status: "started" } } }])
    assert.equal(minerArrivalCanStart({ ...available, ...patch }), false);
  for (const status of ["completed", "skipped"]) assert.equal(minerArrivalCanStart({ ...available, onboarding: { ...available.onboarding, progress: { status } } }), true);
  for (const progress of [null, { status: "started" }]) {
    const onboarding = { loaded: true, isPaused: true, progress }, before = structuredClone(onboarding);
    assert.equal(minerArrivalCanStart({ ...available, onboarding }), true);
    assert.deepEqual(onboarding, before, "arrival does not resume the global course");
  }
});

test("closing the coach during the physical run persists dismissal without completing arrival", () => {
  const local = storage(), first = createMinerArrivalStore("miner-running", local);
  first.restore(); first.dismiss();
  assert.deepEqual(first.getSnapshot().progress, { version: 1, arrived: false, dismissed: true });
  const reload = createMinerArrivalStore("miner-running", local); reload.restore();
  assert.deepEqual(reload.getSnapshot().progress, first.getSnapshot().progress);
  reload.complete();
  assert.deepEqual(reload.getSnapshot().progress, { version: 1, arrived: true, dismissed: true });
});

test("finishing the physical route keeps the greeting until the player dismisses it", () => {
  const local = storage(), first = createMinerArrivalStore("miner-greeting", local);
  first.restore(); first.complete();
  assert.deepEqual(first.getSnapshot().progress, { version: 1, arrived: true, dismissed: false });
  const reload = createMinerArrivalStore("miner-greeting", local); reload.restore(); reload.dismiss();
  assert.deepEqual(reload.getSnapshot().progress, { version: 1, arrived: true, dismissed: true });
  const other = createMinerArrivalStore("miner-other", local); other.restore(); assert.equal(other.getSnapshot().progress, null);
  assert.equal(minerArrivalStorageKey("a:b"), "zhiv.miner-arrival.v1:a%3Ab");
});

test("a second tab cannot erase completed arrival or dismissal", () => {
  const local = storage(), first = createMinerArrivalStore("miner-tabs", local), second = createMinerArrivalStore("miner-tabs", local);
  first.restore(); second.restore();
  first.complete(); second.dismiss(); first.restore();
  assert.deepEqual(first.getSnapshot().progress, { version: 1, arrived: true, dismissed: true });
  second.complete(); first.restore();
  assert.deepEqual(first.getSnapshot().progress, { version: 1, arrived: true, dismissed: true });
});

test("blocked and absent browser storage preserve both presentation flags for this session", () => {
  const blocked = { getItem() { throw new Error("blocked"); }, setItem() { throw new Error("blocked"); } };
  for (const [owner, local] of [["miner-blocked", blocked], ["miner-no-storage", undefined]]) {
    const first = createMinerArrivalStore(owner, local); first.restore(); first.dismiss(); first.complete();
    const next = createMinerArrivalStore(owner, local); next.restore();
    assert.deepEqual(next.getSnapshot().progress, { version: 1, arrived: true, dismissed: true });
  }
});

test("presentation restore rejects corrupt or incompatible data and never treats it as an unlock", () => {
  for (const value of [null, "", "{", "null", "[]", "true", "{}", '{"version":2,"arrived":true,"dismissed":true}', '{"version":1,"arrived":"true","dismissed":true}'])
    assert.equal(parseMinerArrivalProgress(value), null);
  assert.deepEqual(parseMinerArrivalProgress('{"version":1,"arrived":true,"dismissed":false}'), { version: 1, arrived: true, dismissed: false });
  assert.equal(minerArrivalCanStart({ ...available, unlocked: false, arrived: true }), false);
});
