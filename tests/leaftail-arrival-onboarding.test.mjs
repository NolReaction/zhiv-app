import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, cacheDir: `/tmp/zhiv-leaftail-arrival-${process.pid}`,
  resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false } });
after(() => vite.close());
const { leaftailArrivalCanStart, parseLeaftailArrivalProgress } = await vite.ssrLoadModule("/features/world/domain/leaftail-arrival-onboarding.ts");
const { createLeaftailArrivalStore, leaftailArrivalStorageKey } = await vite.ssrLoadModule("/features/world/state/leaftail-arrival-storage.ts");
const available = { loaded: true, unlocked: true, enabled: true, onboarding: { loaded: true, isPaused: false, progress: { version: 2, status: "completed" } } };
function storage() { const map = new Map(); return { getItem: key => map.get(key) ?? null, setItem: (key, value) => map.set(key, value), map }; }

test("arrival waits for a confirmed house level 3, a free map and the completed or paused initial course", () => {
  assert.equal(leaftailArrivalCanStart(available), true);
  for (const patch of [{ loaded: false }, { unlocked: false }, { enabled: false },
    { onboarding: { ...available.onboarding, loaded: false } },
    { onboarding: { ...available.onboarding, progress: null } },
    { onboarding: { ...available.onboarding, progress: { version: 2, status: "started" } } }])
    assert.equal(leaftailArrivalCanStart({ ...available, ...patch }), false);
  for (const status of ["completed", "skipped"]) assert.equal(leaftailArrivalCanStart({ ...available, onboarding: { ...available.onboarding, progress: { status } } }), true);
  for (const progress of [null, { status: "started" }]) {
    const onboarding = { loaded: true, isPaused: true, progress }, before = structuredClone(onboarding);
    assert.equal(leaftailArrivalCanStart({ ...available, onboarding }), true);
    assert.deepEqual(onboarding, before, "arrival does not resume the global course");
  }
});

test("closing the coach during the physical run persists dismissal without completing arrival", () => {
  const local = storage(), first = createLeaftailArrivalStore("leaftail-running", local);
  first.restore(); first.dismiss();
  assert.deepEqual(first.getSnapshot().progress, { version: 1, arrived: false, dismissed: true });
  const reload = createLeaftailArrivalStore("leaftail-running", local); reload.restore();
  assert.deepEqual(reload.getSnapshot().progress, first.getSnapshot().progress);
  reload.complete();
  assert.deepEqual(reload.getSnapshot().progress, { version: 1, arrived: true, dismissed: true });
});

test("finishing the physical route keeps the greeting until the player dismisses it", () => {
  const local = storage(), first = createLeaftailArrivalStore("leaftail-greeting", local);
  first.restore(); first.complete();
  assert.deepEqual(first.getSnapshot().progress, { version: 1, arrived: true, dismissed: false });
  const reload = createLeaftailArrivalStore("leaftail-greeting", local); reload.restore(); reload.dismiss();
  assert.deepEqual(reload.getSnapshot().progress, { version: 1, arrived: true, dismissed: true });
  const other = createLeaftailArrivalStore("leaftail-other", local); other.restore(); assert.equal(other.getSnapshot().progress, null);
  assert.equal(leaftailArrivalStorageKey("a:b"), "zhiv.leaftail-arrival.v1:a%3Ab");
});

test("a second tab cannot erase completed arrival or dismissal", () => {
  const local = storage(), first = createLeaftailArrivalStore("leaftail-tabs", local), second = createLeaftailArrivalStore("leaftail-tabs", local);
  first.restore(); second.restore();
  first.complete(); second.dismiss(); first.restore();
  assert.deepEqual(first.getSnapshot().progress, { version: 1, arrived: true, dismissed: true });
  second.complete(); first.restore();
  assert.deepEqual(first.getSnapshot().progress, { version: 1, arrived: true, dismissed: true });
});

test("same-owner active stores share changes and release peer notifications on unsubscribe", () => {
  const local = storage(), map = createLeaftailArrivalStore("leaftail-live-peers", local),
    circle = createLeaftailArrivalStore("leaftail-live-peers", local), other = createLeaftailArrivalStore("leaftail-live-other", local);
  map.restore(); circle.restore(); other.restore();
  let updates = 0, otherUpdates = 0;
  const release = circle.subscribe(() => updates++), releaseOther = other.subscribe(() => otherUpdates++);
  map.dismiss();
  assert.equal(circle.getSnapshot().progress.dismissed, true); assert.equal(updates, 1); assert.equal(otherUpdates, 0);
  release(); map.complete();
  assert.equal(updates, 1, "unmounted views retain no peer callback");
  assert.equal(circle.getSnapshot().progress.arrived, false);
  circle.restore(); assert.equal(circle.getSnapshot().progress.arrived, true, "remount can restore the persisted completion");
  releaseOther();
});

test("blocked and absent browser storage preserve both presentation flags for this session", () => {
  const blocked = { getItem() { throw new Error("blocked"); }, setItem() { throw new Error("blocked"); } };
  for (const [owner, local] of [["leaftail-blocked", blocked], ["leaftail-no-storage", undefined]]) {
    const first = createLeaftailArrivalStore(owner, local); first.restore(); first.dismiss(); first.complete();
    const next = createLeaftailArrivalStore(owner, local); next.restore();
    assert.deepEqual(next.getSnapshot().progress, { version: 1, arrived: true, dismissed: true });
  }
});

test("presentation restore rejects corrupt or incompatible data and never treats it as an unlock", () => {
  for (const value of [null, "", "{", "null", "[]", "true", "{}", '{"version":2,"arrived":true,"dismissed":true}', '{"version":1,"arrived":"true","dismissed":true}'])
    assert.equal(parseLeaftailArrivalProgress(value), null);
  assert.deepEqual(parseLeaftailArrivalProgress('{"version":1,"arrived":true,"dismissed":false}'), { version: 1, arrived: true, dismissed: false });
  assert.equal(leaftailArrivalCanStart({ ...available, unlocked: false, arrived: true }), false);
});
