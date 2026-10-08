import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({
  appType: "custom", configFile: false, root,
  resolve: { alias: { "@": root } },
  server: { middlewareMode: true, hmr: false, ws: false },
});
after(() => vite.close());

const {
  WORLD_ONBOARDING_VERSION,
  WORLD_ONBOARDING_STEPS,
  parseWorldOnboarding,
  transitionWorldOnboarding,
} = await vite.ssrLoadModule("/features/world/domain/world-onboarding.ts");
const {
  createWorldOnboardingStore,
  onboardingStorageKey,
  readWorldOnboarding,
  writeWorldOnboarding,
} = await vite.ssrLoadModule("/features/world/state/world-onboarding-storage.ts");

const stepIds = ["profile", "pantry", "garden", "grow", "expeditions", "help"];
const started = stepId => ({ version: WORLD_ONBOARDING_VERSION, status: "started", stepId });
const terminal = status => ({ version: WORLD_ONBOARDING_VERSION, status });
const cropJobId = "8be0c480-246c-4d4b-97f6-18eccf1bdf04";

function memoryStorage() {
  const values = new Map();
  return {
    values,
    getItem(key) { return values.get(key) ?? null; },
    setItem(key, value) { values.set(key, value); },
  };
}
const parse = value => parseWorldOnboarding(JSON.stringify(value));

function advance(store, event) {
  const progress = transitionWorldOnboarding(store.getSnapshot().progress, event);
  if (progress) store.save(progress);
}

test("the second introduction includes berry practice and changes the hero's pose", () => {
  assert.equal(WORLD_ONBOARDING_VERSION, 2);
  assert.deepEqual(WORLD_ONBOARDING_STEPS.map(step => step.id), stepIds);
  assert.equal(new Set(WORLD_ONBOARDING_STEPS.map(step => step.id)).size, stepIds.length);
  assert.ok(Object.isFrozen(WORLD_ONBOARDING_STEPS));
  assert.ok(WORLD_ONBOARDING_STEPS.every(Object.isFrozen));
  assert.equal(new Set(WORLD_ONBOARDING_STEPS.map(step => step.pose)).size, stepIds.length);
});

test("every saved step resumes at the same place with its real crop reference", () => {
  for (const stepId of stepIds) {
    assert.deepEqual(parse(started(stepId)), started(stepId));
    const progress = { ...started(stepId), cropJobId };
    assert.deepEqual(parse(progress), progress);
  }
});

test("skip and completion retain a crop reference without retaining an obsolete step", () => {
  for (const status of ["skipped", "completed"]) {
    const progress = { ...terminal(status), cropJobId };
    assert.deepEqual(parse(progress), progress);
    assert.deepEqual(parse({ ...progress, stepId: "pantry", futureField: true }), progress);
  }
});

test("legacy skips and completions stay dismissed after the tutorial update", () => {
  for (const status of ["skipped", "completed"]) {
    assert.deepEqual(parse({ version: 1, status }), terminal(status));
    assert.deepEqual(parse({ version: 1, status, stepId: "pantry", cropJobId }), terminal(status),
      "legacy data cannot invent a tracked berry job");
  }
});

test("an unfinished legacy slideshow resumes at the first interactive task", () => {
  for (const stepId of ["clearing", "profile", "pantry", "expeditions", "help"]) {
    assert.deepEqual(parse({ version: 1, status: "started", stepId }), started("profile"));
  }
  for (const stepId of ["garden", "grow", "unknown", null, 0]) {
    assert.equal(parse({ version: 1, status: "started", stepId }), null);
  }
});

test("missing, malformed and non-object data safely shows a fresh invitation", () => {
  for (const raw of [null, "", "{", "undefined", "null", "true", "0", '"started"', "[]", "[{}]"]) {
    assert.equal(parseWorldOnboarding(raw), null, `unexpectedly accepted ${String(raw)}`);
  }
});

test("unknown versions, statuses and step IDs cannot dismiss or misdirect the tutorial", () => {
  const invalid = [
    {}, { status: "completed" }, { version: 0, status: "completed" },
    { version: 3, status: "skipped" }, { version: "2", status: "completed" },
    { version: null, status: "completed" }, { version: 2 },
    { version: 2, status: "pending" }, { version: 2, status: "STARTED", stepId: "profile" },
    ...[undefined, "clearing", "buildings", "", null, 0, ["profile"]].map(stepId => ({ version: 2, status: "started", stepId })),
  ];
  for (const value of invalid) assert.equal(parse(value), null, `unexpectedly accepted ${JSON.stringify(value)}`);
});

test("an invalid optional crop reference is discarded without reopening a dismissed tutorial", () => {
  for (const invalid of [null, 0, true, {}, [], "", " ", "job id", " job-id", "job-id ", "<script>", "x\n", "x".repeat(129)]) {
    for (const progress of [started("grow"), terminal("skipped"), terminal("completed")]) {
      assert.deepEqual(parse({ ...progress, cropJobId: invalid }), progress);
    }
  }
  for (const valid of [cropJobId, "job_123:grow.berries-1", "x", "x".repeat(128)]) {
    assert.deepEqual(parse({ ...terminal("completed"), cropJobId: valid }), { ...terminal("completed"), cropJobId: valid });
  }
});

test("real crop observation alone does not opt a new player into the tutorial", () => {
  assert.equal(transitionWorldOnboarding(null, { type: "crop", jobId: cropJobId }), null);
  assert.deepEqual(transitionWorldOnboarding(null, { type: "start" }), started("profile"));
  assert.deepEqual(transitionWorldOnboarding(null, { type: "skip" }), terminal("skipped"));
});

test("forward and backward navigation preserve the crop after the player starts growing", () => {
  const original = { ...started("grow"), cropJobId };
  Object.freeze(original);
  for (const stepId of stepIds) {
    assert.deepEqual(transitionWorldOnboarding(original, { type: "step", stepId }), { ...started(stepId), cropJobId });
  }
  assert.deepEqual(original, { ...started("grow"), cropJobId }, "transitions do not mutate a subscribed snapshot");
});

test("finishing or skipping can leave a real crop available for a later harvest reminder", () => {
  const progress = { ...started("help"), cropJobId };
  assert.deepEqual(transitionWorldOnboarding(progress, { type: "complete" }), { ...terminal("completed"), cropJobId });
  assert.deepEqual(transitionWorldOnboarding(progress, { type: "skip" }), { ...terminal("skipped"), cropJobId });
});

test("clearing an acknowledged or stale crop preserves the player's tutorial decision", () => {
  for (const progress of [started("grow"), terminal("skipped"), terminal("completed")]) {
    const withCrop = { ...progress, cropJobId };
    assert.deepEqual(transitionWorldOnboarding(withCrop, { type: "crop" }), progress);
    assert.deepEqual(transitionWorldOnboarding(withCrop, { type: "crop", jobId: undefined }), progress);
    assert.deepEqual(transitionWorldOnboarding(withCrop, { type: "crop", jobId: "job-next" }), { ...progress, cropJobId: "job-next" });
  }
});

test("explicit replay starts fresh and clears the previous crop reference", () => {
  for (const progress of [null, started("grow"), terminal("skipped"), { ...terminal("completed"), cropJobId }]) {
    assert.deepEqual(transitionWorldOnboarding(progress, { type: "replay" }), started("profile"));
  }
});

test("the stable account key reads legacy data without requiring a second key or eager rewrite", () => {
  const storage = memoryStorage();
  assert.equal(onboardingStorageKey("FIRST-PLAYER"), "zhiv.world-onboarding.v1:FIRST-PLAYER");
  assert.notEqual(onboardingStorageKey("FIRST-PLAYER"), onboardingStorageKey("SECOND-PLAYER"));
  const raw = JSON.stringify({ version: 1, status: "completed" });
  storage.setItem(onboardingStorageKey("LEGACY-PLAYER"), raw);
  assert.deepEqual(readWorldOnboarding("LEGACY-PLAYER", storage), terminal("completed"));
  assert.equal(storage.getItem(onboardingStorageKey("LEGACY-PLAYER")), raw, "a read does not rewrite local preferences");
});

test("one player's skip cannot hide another player's guide or overwrite a tracked crop", () => {
  const storage = memoryStorage();
  assert.equal(readWorldOnboarding("FIRST-PLAYER", storage), null);
  assert.equal(writeWorldOnboarding("FIRST-PLAYER", terminal("skipped"), storage), true);
  assert.equal(readWorldOnboarding("SECOND-PLAYER", storage), null);
  const progress = { ...started("grow"), cropJobId };
  assert.equal(writeWorldOnboarding("SECOND-PLAYER", progress, storage), true);
  assert.deepEqual(readWorldOnboarding("FIRST-PLAYER", storage), terminal("skipped"));
  assert.deepEqual(readWorldOnboarding("SECOND-PLAYER", storage), progress);
  assert.equal(storage.values.size, 2);
});

test("saved crop progress survives reopening and can become completed without losing the crop", () => {
  const storage = memoryStorage();
  const progress = { ...started("expeditions"), cropJobId };
  assert.equal(writeWorldOnboarding("REOPEN-PLAYER", progress, storage), true);
  const store = createWorldOnboardingStore("REOPEN-PLAYER", storage);
  store.restore();
  assert.deepEqual(store.getSnapshot().progress, progress);
  advance(store, { type: "complete" });
  assert.deepEqual(readWorldOnboarding("REOPEN-PLAYER", storage), { ...terminal("completed"), cropJobId });
});

test("unreadable and future local progress is treated as absent without rewriting storage", () => {
  const storage = memoryStorage();
  for (const raw of ["{", JSON.stringify({ version: 3, status: "completed" }), JSON.stringify(started("unknown"))]) {
    storage.values.set(onboardingStorageKey("BROKEN-PLAYER"), raw);
    assert.equal(readWorldOnboarding("BROKEN-PLAYER", storage), null);
    assert.equal(storage.values.get(onboardingStorageKey("BROKEN-PLAYER")), raw);
  }
});

test("blocked browser storage does not prevent showing or closing the guide", () => {
  const denied = {
    getItem() { throw new Error("Storage access denied"); },
    setItem() { throw new Error("Storage quota exceeded"); },
  };
  assert.equal(readWorldOnboarding("DENIED-PLAYER", denied), null);
  for (const progress of [started("profile"), terminal("skipped"), terminal("completed")]) {
    assert.equal(writeWorldOnboarding("DENIED-PLAYER", progress, denied), false);
  }
});

test("the account store hydrates deliberately and only notifies changes to active subscribers", () => {
  const storage = memoryStorage();
  writeWorldOnboarding("STORE-PLAYER", started("profile"), storage);
  const store = createWorldOnboardingStore("STORE-PLAYER", storage);
  assert.deepEqual(store.getServerSnapshot(), { loaded: false, progress: null });
  assert.deepEqual(store.getSnapshot(), { loaded: false, progress: null });
  assert.equal(store.getSnapshot(), store.getSnapshot());
  assert.equal(store.getServerSnapshot(), store.getServerSnapshot());
  let notifications = 0;
  const unsubscribe = store.subscribe(() => notifications++);
  store.restore();
  assert.deepEqual(store.getSnapshot(), { loaded: true, progress: started("profile") });
  assert.equal(notifications, 1);
  const restored = store.getSnapshot();
  store.restore();
  assert.equal(store.getSnapshot(), restored);
  assert.equal(notifications, 1, "unchanged reads cannot cause a render loop");
  store.save(started("pantry"));
  assert.equal(notifications, 2);
  unsubscribe();
  store.save(terminal("completed"));
  assert.equal(notifications, 2, "an unmounted owner no longer receives updates");
  assert.deepEqual(store.getServerSnapshot(), { loaded: false, progress: null });
});

test("observing a crop and advancing in the same turn preserves the newest store value", () => {
  const store = createWorldOnboardingStore("QUICK-PLAYER", memoryStorage());
  store.restore();
  advance(store, { type: "start" });
  advance(store, { type: "step", stepId: "grow" });
  advance(store, { type: "crop", jobId: cropJobId });
  advance(store, { type: "step", stepId: "expeditions" });
  advance(store, { type: "complete" });
  assert.deepEqual(store.getSnapshot().progress, { ...terminal("completed"), cropJobId });
});

test("temporary storage failure keeps progress in memory and isolates accounts", () => {
  const denied = { getItem() { throw new Error("Denied"); }, setItem() { throw new Error("Denied"); } };
  const first = createWorldOnboardingStore("IN-MEMORY-FIRST", denied);
  first.restore();
  assert.deepEqual(first.getSnapshot(), { loaded: true, progress: null });
  const progress = { ...started("expeditions"), cropJobId };
  first.save(progress);
  const reopened = createWorldOnboardingStore("IN-MEMORY-FIRST", denied);
  reopened.restore();
  assert.deepEqual(reopened.getSnapshot(), { loaded: true, progress });
  const other = createWorldOnboardingStore("IN-MEMORY-SECOND", denied);
  other.restore();
  assert.deepEqual(other.getSnapshot(), { loaded: true, progress: null });
  advance(reopened, { type: "skip" });
  const afterSkip = createWorldOnboardingStore("IN-MEMORY-FIRST", denied);
  afterSkip.restore();
  assert.deepEqual(afterSkip.getSnapshot(), { loaded: true, progress: { ...terminal("skipped"), cropJobId } });
  assert.deepEqual(other.getSnapshot(), { loaded: true, progress: null });
});

test("restored writable storage replaces the fallback so later external changes can be read", () => {
  const storage = memoryStorage();
  let writable = false;
  const recovering = { getItem: storage.getItem, setItem(key, value) {
    if (!writable) throw new Error("Temporarily full");
    storage.setItem(key, value);
  } };
  const store = createWorldOnboardingStore("RECOVERING-PLAYER", recovering);
  store.restore();
  store.save(started("pantry"));
  writable = true;
  store.save(started("garden"));
  storage.setItem(onboardingStorageKey("RECOVERING-PLAYER"), JSON.stringify(terminal("completed")));
  store.restore();
  assert.deepEqual(store.getSnapshot().progress, terminal("completed"));
});
