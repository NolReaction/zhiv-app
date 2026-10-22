import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false } });
const { createEarthLocationPreferenceStore, earthLocationPreferenceKey } = await vite.ssrLoadModule("/features/earth/location-preferences.ts");
after(() => vite.close());

function device() {
  const values = new Map(), listeners = new Map();
  const storage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
  return { values, create: owner => createEarthLocationPreferenceStore(owner, () => storage, (key, listener) => {
    listeners.set(key, listener); return () => listeners.delete(key);
  }), change(key, value) { values.set(key, value); listeners.get(key)?.(); }, listeners };
}

test("unreadable initial storage suppresses automatic GPS while keeping a manual lookup available", () => {
  for (const getStorage of [() => undefined, () => ({ getItem() { throw new Error("blocked"); } })]) {
    const store = createEarthLocationPreferenceStore("unreadable-owner", getStorage, () => () => {});
    assert.deepEqual(store.getSnapshot(), { enabled: true, automaticStartAllowed: false });
    assert.equal(store.allowAutomaticStart(), true);
    assert.deepEqual(store.getSnapshot(), { enabled: true, automaticStartAllowed: true });
  }
});

test("a real permission denial persists ready without disabling GPS or overriding OFF", () => {
  const d = device(), store = d.create("denied-owner");
  let changes = 0;
  const unsubscribe = store.subscribe(() => changes++);
  store.suppressAutomaticStart();
  assert.deepEqual(d.create("denied-owner").getSnapshot(), { enabled: true, automaticStartAllowed: false });
  assert.deepEqual([...d.values.values()], ["ready"]);
  store.suppressAutomaticStart();
  assert.equal(changes, 1, "duplicate denial does not rewrite the preference");
  assert.equal(store.allowAutomaticStart(), true);
  assert.equal(store.getSnapshot().automaticStartAllowed, true);
  store.setEnabled(false); store.suppressAutomaticStart();
  assert.deepEqual(store.getSnapshot(), { enabled: false, automaticStartAllowed: false });
  assert.deepEqual([...d.values.values()], ["off"]);
  unsubscribe();
});

test("a device stores only the owner's GPS preference and ON requires another deliberate lookup", () => {
  const d = device(), a = d.create("owner-a"), b = d.create("owner-b");
  assert.equal(a.getSnapshot().enabled, true);
  assert.equal(a.getSnapshot().automaticStartAllowed, true);
  let changes = 0;
  const unsubscribe = a.subscribe(() => changes++);
  a.setEnabled(false);
  assert.equal(a.getSnapshot().enabled, false);
  assert.equal(a.allowAutomaticStart(), false, "an explicit lookup cannot bypass OFF");
  assert.equal(changes, 1);
  assert.equal(b.getSnapshot().enabled, true, "device choice belongs to the same account only");
  const restored = d.create("owner-a");
  assert.equal(restored.getSnapshot().enabled, false);
  restored.setEnabled(true);
  assert.deepEqual(restored.getSnapshot(), { enabled: true, automaticStartAllowed: false });
  assert.deepEqual(d.create("owner-a").getSnapshot(), { enabled: true, automaticStartAllowed: false }, "reload cannot restart a watch after ON");
  assert.equal(restored.allowAutomaticStart(), true);
  assert.equal(restored.getSnapshot().automaticStartAllowed, true);
  assert.deepEqual([...d.values.values()], ["active"], "no browser fix or permission metadata is persisted");
  unsubscribe();
  assert.equal(d.listeners.size, 0);
});

test("storage failure keeps a full OFF in memory and cross-tab changes notify subscribers", () => {
  const broken = { getItem() { throw new Error("blocked"); }, setItem() { throw new Error("blocked"); } };
  const store = createEarthLocationPreferenceStore("owner-a", () => broken, () => () => {});
  store.setEnabled(false);
  assert.equal(store.getSnapshot().enabled, false);
  assert.equal(store.allowAutomaticStart(), false);
  store.setEnabled(true);
  assert.equal(store.getSnapshot().automaticStartAllowed, false);
  const d = device(), other = d.create("owner-b");
  let changes = 0;
  const unsubscribe = other.subscribe(() => changes++);
  d.change(earthLocationPreferenceKey("owner-b"), "off");
  assert.equal(changes, 1);
  assert.equal(other.getSnapshot().enabled, false);
  unsubscribe();
});

test("a later storage read error preserves the last successfully saved OFF", () => {
  let value = null, broken = false;
  const storage = { getItem() { if (broken) throw new Error("blocked"); return value; }, setItem(_key, next) { value = next; } };
  const store = createEarthLocationPreferenceStore("owner", () => storage, () => () => {});
  store.setEnabled(false);
  assert.equal(value, "off");
  broken = true;
  assert.equal(store.getSnapshot().enabled, false);
  assert.equal(store.allowAutomaticStart(), false);
});

test("losing the Storage object itself cannot replace a saved OFF with the default", () => {
  let value = null, available = true;
  const storage = { getItem: () => value, setItem(_key, next) { value = next; } };
  const store = createEarthLocationPreferenceStore("owner", () => available ? storage : undefined, () => () => {});
  store.setEnabled(false);
  available = false;
  assert.equal(store.getSnapshot().enabled, false);
  assert.equal(store.allowAutomaticStart(), false);
});

test("missing owners cannot activate GPS; malformed preferences are fail-closed and snapshot identity is stable", () => {
  const d = device(), missing = d.create(null);
  missing.setEnabled(true);
  assert.equal(missing.allowAutomaticStart(), false);
  assert.equal(missing.getSnapshot().enabled, false);
  assert.equal(d.values.size, 0);
  const a = d.create("owner-a");
  const initial = a.getSnapshot();
  assert.equal(a.getSnapshot(), initial);
  d.values.set(a.storageKey, "{wrong-format}");
  assert.equal(a.getSnapshot().enabled, false);
  assert.equal(a.getSnapshot(), a.getSnapshot());
  assert.equal(a.storageKey.includes("owner-a"), true);
});
