import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root,
  resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false } });
const { createMobileLocationPreferenceStore, mobileLocationPreferenceKey } =
  await vite.ssrLoadModule("/apps/mobile/src/location-preference.ts");
after(() => vite.close());

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

test("hydration starts disabled and restores only an explicit diagnostic ON", async () => {
  for (const value of [null, "off", "on", "active", "corrupt"]) {
    const read = deferred();
    const requested = [];
    const store = createMobileLocationPreferenceStore({
      get: options => { requested.push(options); return read.promise; },
      set: async () => {},
    });
    const initial = store.getSnapshot();
    assert.equal(initial.ready, false);
    assert.equal(initial.enabled, false);
    assert.equal(store.getSnapshot(), initial, "snapshots are stable until a change");
    const hydration = store.hydrate();
    assert.equal(store.hydrate(), hydration, "Strict Mode does not duplicate reads");
    assert.equal(store.getSnapshot().enabled, false, "pending storage cannot enable GPS");
    read.resolve({ value });
    await hydration;
    assert.deepEqual(requested, [{ key: mobileLocationPreferenceKey }]);
    assert.deepEqual(store.getSnapshot(), { ready: true, enabled: value === "on", saving: false, error: null });
    assert.equal(store.getServerSnapshot().enabled, false);
  }
});

test("failed hydration fails closed and a later deliberate choice can persist", async () => {
  const writes = [];
  const store = createMobileLocationPreferenceStore({
    get: async () => { throw new Error("unavailable"); },
    set: async options => { writes.push(options); },
  });
  await store.hydrate();
  assert.equal(store.getSnapshot().ready, true);
  assert.equal(store.getSnapshot().enabled, false);
  assert.ok(store.getSnapshot().error);
  await store.setEnabled(true);
  assert.deepEqual(writes, [{ key: mobileLocationPreferenceKey, value: "on" }]);
  assert.equal(store.getSnapshot().error, null);
});

test("a delayed hydration result or failure cannot overwrite a deliberate OFF", async () => {
  for (const fail of [false, true]) {
    const read = deferred();
    const store = createMobileLocationPreferenceStore({ get: () => read.promise, set: async () => {} });
    const hydration = store.hydrate();
    await store.setEnabled(false);
    const choice = store.getSnapshot();
    if (fail) read.reject(new Error("late failure"));
    else read.resolve({ value: "on" });
    await hydration;
    assert.equal(store.getSnapshot(), choice);
    assert.equal(store.getSnapshot().enabled, false);
  }
});

test("hydration requested after a user choice does not reread the obsolete value", async () => {
  const write = deferred();
  let reads = 0;
  const store = createMobileLocationPreferenceStore({
    get: async () => { reads += 1; return { value: "on" }; },
    set: () => write.promise,
  });
  const disable = store.setEnabled(false);
  await store.hydrate();
  assert.equal(reads, 0);
  assert.equal(store.getSnapshot().enabled, false);
  assert.equal(store.getSnapshot().saving, true);
  write.resolve();
  await disable;
});

test("rapid ON/OFF writes are serialized and OFF is visible before storage completes", async () => {
  const writes = [], pending = [];
  let persisted = "off";
  const port = {
    get: async () => ({ value: persisted }),
    set: options => {
      writes.push(options.value);
      const task = deferred();
      pending.push(task);
      return task.promise.then(() => { persisted = options.value; });
    },
  };
  const store = createMobileLocationPreferenceStore(port);
  await store.hydrate();
  const enable = store.setEnabled(true);
  await Promise.resolve();
  const disable = store.setEnabled(false);
  assert.equal(store.getSnapshot().enabled, false);
  assert.equal(store.getSnapshot().saving, true);
  assert.deepEqual(writes, ["on"], "the OFF write waits for the earlier write");
  pending[0].resolve();
  await enable;
  await Promise.resolve();
  assert.deepEqual(writes, ["on", "off"]);
  assert.equal(store.getSnapshot().saving, true);
  pending[1].resolve();
  await disable;
  const restarted = createMobileLocationPreferenceStore(port);
  await restarted.hydrate();
  assert.equal(restarted.getSnapshot().enabled, false);
  assert.deepEqual(store.getSnapshot(), { ready: true, enabled: false, saving: false, error: null });
});

test("failed OFF preserves the immediate local stop and exposes persistence failure", async () => {
  const store = createMobileLocationPreferenceStore({
    get: async () => ({ value: "on" }),
    set: async () => { throw new Error("disk unavailable"); },
  });
  await store.hydrate();
  const operation = store.setEnabled(false);
  assert.equal(store.getSnapshot().enabled, false);
  await assert.doesNotReject(operation);
  assert.equal(store.getSnapshot().enabled, false);
  assert.equal(store.getSnapshot().saving, false);
  assert.ok(store.getSnapshot().error);
});

test("an earlier failed enable does not poison a queued successful disable", async () => {
  let writes = 0;
  const first = deferred();
  const store = createMobileLocationPreferenceStore({
    get: async () => ({ value: "off" }),
    set: () => ++writes === 1 ? first.promise : Promise.resolve(),
  });
  const enable = store.setEnabled(true);
  await Promise.resolve();
  const disable = store.setEnabled(false);
  first.reject(new Error("first write failed"));
  await enable;
  await disable;
  assert.equal(writes, 2);
  assert.deepEqual(store.getSnapshot(), { ready: true, enabled: false, saving: false, error: null });
});

test("subscribers see the immediate choice and stop receiving updates after cleanup", async () => {
  const store = createMobileLocationPreferenceStore({ get: async () => ({ value: null }), set: async () => {} });
  const seen = [];
  const unsubscribe = store.subscribe(() => seen.push(store.getSnapshot()));
  await store.hydrate();
  const enable = store.setEnabled(true);
  assert.equal(seen.at(-1).enabled, true);
  assert.equal(seen.at(-1).saving, true);
  unsubscribe();
  const count = seen.length;
  await enable;
  await store.setEnabled(false);
  assert.equal(seen.length, count);
});
