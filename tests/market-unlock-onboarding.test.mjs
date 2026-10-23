import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, cacheDir: `/tmp/zhiv-market-unlock-onboarding-${process.pid}`,
  resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false } });
after(() => vite.close());
const { marketUnlockOnboardingCanOpen, parseMarketUnlockOnboarding } = await vite.ssrLoadModule("/features/world/domain/market-unlock-onboarding.ts");
const { createMarketUnlockOnboardingStore, marketUnlockOnboardingStorageKey } = await vite.ssrLoadModule("/features/world/state/market-unlock-onboarding-storage.ts");
const { parseWorldOnboarding } = await vite.ssrLoadModule("/features/world/domain/world-onboarding.ts");
const completedCourse = { loaded: true, isPaused: false, progress: { version: 2, status: "completed" } };
const available = { loaded: true, prepared: true, progress: null, unlocked: true, enabled: true, onboarding: completedCourse };
function storage() {
  const values = new Map();
  return { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), values };
}

test("market notice requires confirmed bridge access and a free map after the initial course", () => {
  assert.equal(marketUnlockOnboardingCanOpen(available), true);
  for (const patch of [{ loaded: false }, { prepared: false }, { unlocked: false }, { enabled: false },
    { onboarding: { ...completedCourse, loaded: false } },
    { onboarding: { ...completedCourse, progress: null } },
    { onboarding: { ...completedCourse, progress: { version: 2, status: "started", stepId: "orders" } } }]) {
    assert.equal(marketUnlockOnboardingCanOpen({ ...available, ...patch }), false, JSON.stringify(patch));
  }
  // Finishing the clock of a bridge construction job alone cannot open the notice:
  // the caller passes the confirmed access gate, which remains false until claim.
  assert.equal(marketUnlockOnboardingCanOpen({ ...available, unlocked: false, bridgeJobReady: true }), false);
});

test("an intentionally paused initial course allows the separate market notice and stays paused", () => {
  for (const progress of [null, { version: 2, status: "started", stepId: "orders" }, { version: 2, status: "skipped" }]) {
    const onboarding = { loaded: true, isPaused: true, progress };
    const before = structuredClone(onboarding);
    assert.equal(marketUnlockOnboardingCanOpen({ ...available, onboarding }), true);
    assert.deepEqual(onboarding, before, "discovery never resumes or changes the closed global tutorial");
  }
});

test("legacy completed and skipped courses receive one separate notice without restarting them", () => {
  for (const status of ["completed", "skipped"]) {
    const progress = parseWorldOnboarding(JSON.stringify({ version: 1, status }));
    const before = structuredClone(progress);
    assert.equal(marketUnlockOnboardingCanOpen({ ...available, onboarding: { ...completedCourse, progress } }), true);
    assert.deepEqual(progress, before);
  }
});

test("dismiss and completion survive reload independently for each owner", () => {
  const local = storage();
  for (const status of ["dismissed", "completed"]) {
    const owner = `market-notice-${status}`;
    const first = createMarketUnlockOnboardingStore(owner, local);
    assert.equal(first.getSnapshot().loaded, false);
    first.restore();
    first.prepare(false);
    assert.equal(marketUnlockOnboardingCanOpen({ ...available, ...first.getSnapshot() }), true);
    first.finish(status);
    assert.equal(marketUnlockOnboardingCanOpen({ ...available, ...first.getSnapshot() }), false);
    const reload = createMarketUnlockOnboardingStore(owner, local);
    reload.restore();
    reload.prepare(true);
    assert.deepEqual(reload.getSnapshot(), { loaded: true, prepared: true, progress: { version: 1, status } });
    assert.equal(marketUnlockOnboardingCanOpen({ ...available, ...reload.getSnapshot() }), false);
  }
  const other = createMarketUnlockOnboardingStore("market-notice-other", local);
  other.restore();
  other.prepare(false);
  assert.equal(marketUnlockOnboardingCanOpen({ ...available, ...other.getSnapshot() }), true);
  assert.equal(marketUnlockOnboardingStorageKey("a:b"), "zhiv.market-unlock-onboarding.v1:a%3Ab");
});

test("a blocked preference store keeps a dismissed notice closed for the session", () => {
  const blocked = { getItem() { throw new Error("blocked"); }, setItem() { throw new Error("blocked"); } };
  const first = createMarketUnlockOnboardingStore("market-notice-blocked", blocked);
  first.restore(); first.finish("dismissed");
  const remount = createMarketUnlockOnboardingStore("market-notice-blocked", blocked);
  remount.restore();
  assert.equal(marketUnlockOnboardingCanOpen({ ...available, ...remount.getSnapshot() }), false);
  const missing = createMarketUnlockOnboardingStore("market-notice-no-storage");
  missing.restore(); missing.finish("completed");
  const second = createMarketUnlockOnboardingStore("market-notice-no-storage"); second.restore();
  assert.equal(second.getSnapshot().progress.status, "completed");
});

test("cross-tab preference restore closes the same pending notice without local overwrites", () => {
  const local = storage(), first = createMarketUnlockOnboardingStore("market-notice-tabs", local);
  const second = createMarketUnlockOnboardingStore("market-notice-tabs", local);
  let changes = 0;
  first.subscribe(() => changes++);
  first.restore(); second.restore();
  second.finish("completed"); first.restore();
  assert.equal(first.getSnapshot().progress.status, "completed");
  assert.equal(changes, 2);
  first.restore(); assert.equal(changes, 2, "equal storage events do not rerender");
});

test("first confirmed access on a clean device is historical; only access after a locked baseline is new", () => {
  for (const local of [storage(), undefined, { getItem() { throw new Error("blocked"); }, setItem() { throw new Error("blocked"); } }]) {
    const first = createMarketUnlockOnboardingStore(`market-historical-${local === undefined ? "missing" : local.values ? "clean" : "blocked"}`, local);
    first.prepare(false);
    assert.equal(first.getSnapshot().loaded, false, "baseline cannot precede preference restore");
    first.restore();
    assert.equal(marketUnlockOnboardingCanOpen({ ...available, ...first.getSnapshot() }), false, "restored preferences alone do not permit an unlock guide");
    first.prepare(true);
    assert.equal(marketUnlockOnboardingCanOpen({ ...available, ...first.getSnapshot() }), false);
    assert.equal(first.getSnapshot().progress.status, "dismissed");
    first.prepare(false);
    assert.equal(first.getSnapshot().progress.status, "dismissed", "later values cannot rewrite the baseline");
  }
  const local = storage(), live = createMarketUnlockOnboardingStore("market-live-access", local);
  live.restore(); live.prepare(false);
  assert.equal(marketUnlockOnboardingCanOpen({ ...available, ...live.getSnapshot(), unlocked: false }), false);
  live.prepare(true);
  assert.equal(live.getSnapshot().progress, null, "preparing is one-shot; a live unlock is not silently consumed");
  assert.equal(marketUnlockOnboardingCanOpen({ ...available, ...live.getSnapshot(), enabled: false }), false);
  assert.equal(marketUnlockOnboardingCanOpen({ ...available, ...live.getSnapshot() }), true);
  assert.equal(local.values.size, 0, "opening a live guide does not complete it or send a command");
});

test("malformed notice progress cannot hide a first discovery", () => {
  for (const raw of [null, "", "not-json", "[]", "null", '{"version":2,"status":"completed"}', '{"version":1,"status":"started"}']) {
    assert.equal(parseMarketUnlockOnboarding(raw), null);
  }
  assert.deepEqual(parseMarketUnlockOnboarding('{"version":1,"status":"dismissed","extra":true}'), { version: 1, status: "dismissed" });
});
