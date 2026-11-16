import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root,
  resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false } });
after(() => vite.close());
const { createDurableEarthLocationPreferenceStore } = await vite.ssrLoadModule("/features/earth/durable-location-preferences.ts");
const { earthLocationPreferenceKey, getEarthLocationPreferenceStore, withEarthLocationPreference } = await vite.ssrLoadModule("/features/earth/location-preferences.ts");
const { installClientJournalStorage } = await vite.ssrLoadModule("/lib/client-journal-storage.ts");
const key = earthLocationPreferenceKey("ABCD-EFGH-JKMN");
const tick = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };

function device(initial = null) {
  const values = new Map(initial === null ? [] : [[key, initial]]), operations = [];
  let epoch = 0;
  function port() {
    const ownEpoch = epoch;
    const check = () => { if (ownEpoch !== epoch) throw new Error("Retired owner"); };
    return {
      getItem(name) { check(); return values.get(name) ?? null; },
      getKeys() { check(); return [...values.keys()]; },
      setItem(name, value) {
        check();
        return new Promise((resolve, reject) => operations.push({ name, value,
          commit() { values.set(name, value); try { check(); resolve(); } catch (error) { reject(error); } },
          fail: () => reject(new Error("Disk full")),
        }));
      },
      async removeItem(name) { check(); values.delete(name); },
    };
  }
  return { values, operations, port, retire() { epoch++; } };
}

test("native ON and first lookup are accepted only after their actual durable commits", async () => {
  const d = device("off"), store = createDurableEarthLocationPreferenceStore(key, d.port());
  const enabled = store.setEnabled(true);
  assert.equal(store.getSnapshot().enabled, false);
  assert.equal(store.getPersistenceSnapshot().pending, true);
  assert.equal(await store.allowAutomaticStart(), false, "a pending ON cannot authorize lookup");
  await tick();
  assert.equal(d.operations[0].value, "ready"); d.operations[0].commit();
  assert.equal(await enabled, true);
  assert.deepEqual(store.getSnapshot(), { enabled: true, automaticStartAllowed: false });
  let lookups = 0;
  const lookup = withEarthLocationPreference(store, () => ++lookups);
  await tick();
  assert.equal(lookups, 0); assert.equal(d.operations[1].value, "active");
  d.operations[1].commit();
  assert.equal(await lookup, 1);
  assert.equal(lookups, 1); assert.equal(store.isStartAllowed(), true);
});

test("failed native enable and lookup cannot authorize GPS or falsely acknowledge the choice", async () => {
  const d = device("off"), store = createDurableEarthLocationPreferenceStore(key, d.port());
  const enabled = store.setEnabled(true); await tick(); d.operations[0].fail();
  assert.equal(await enabled, false); assert.equal(store.getSnapshot().enabled, false);
  assert.match(store.getPersistenceSnapshot().error, /Не удалось сохранить/);
  const retry = store.setEnabled(true); await tick(); d.operations[1].commit();
  assert.equal(await retry, true); assert.equal(store.getPersistenceSnapshot().error, null);
  let lookups = 0;
  const lookup = withEarthLocationPreference(store, () => ++lookups);
  await tick(); d.operations[2].fail();
  assert.equal(await lookup, false); assert.equal(lookups, 0);
  assert.equal(store.getSnapshot().automaticStartAllowed, false);
});

test("OFF takes effect immediately and defeats an in-flight ACTIVE commit", async () => {
  const d = device("ready"), store = createDurableEarthLocationPreferenceStore(key, d.port());
  let lookups = 0;
  const lookup = withEarthLocationPreference(store, () => ++lookups);
  await tick();
  const off = store.setEnabled(false);
  assert.deepEqual(store.getSnapshot(), { enabled: false, automaticStartAllowed: false });
  assert.equal(store.isStartAllowed(), false);
  d.operations[0].commit(); await tick();
  assert.equal(await lookup, false); assert.equal(lookups, 0);
  assert.equal(d.operations[1].value, "off"); d.operations[1].commit();
  assert.equal(await off, true); assert.equal(d.values.get(key), "off");
});

test("a later ON cannot overtake a pending OFF or restore automatic permission", async () => {
  const d = device("active"), store = createDurableEarthLocationPreferenceStore(key, d.port());
  const off = store.setEnabled(false); await tick();
  const on = store.setEnabled(true);
  d.operations[0].commit(); await tick();
  assert.equal(await off, false); assert.equal(store.getSnapshot().enabled, false);
  assert.equal(d.operations[1].value, "ready"); d.operations[1].commit();
  assert.equal(await on, true);
  assert.deepEqual(store.getSnapshot(), { enabled: true, automaticStartAllowed: false });
});

test("native cold sessions retain OFF and require a fresh deliberate lookup for saved ACTIVE", () => {
  for (const [saved, enabled] of [["off", false], ["ready", true], ["active", true], [null, true], ["invalid", false]]) {
    const d = device(saved), store = createDurableEarthLocationPreferenceStore(key, d.port());
    assert.deepEqual(store.getSnapshot(), { enabled, automaticStartAllowed: false });
    assert.equal(d.operations.length, 0, "hydration does not silently create new consent");
  }
});

test("a failed OFF stops the live session and cannot revive automatic GPS after reopening", async () => {
  const d = device("active"), store = createDurableEarthLocationPreferenceStore(key, d.port());
  const active = store.allowAutomaticStart(); await tick(); d.operations[0].commit(); await active;
  assert.equal(store.isStartAllowed(), true);
  const off = store.setEnabled(false); await tick(); d.operations[1].fail();
  assert.equal(await off, false); assert.equal(store.isStartAllowed(), false);
  assert.equal(store.getSnapshot().enabled, false);
  const reopened = createDurableEarthLocationPreferenceStore(key, d.port());
  assert.equal(reopened.getSnapshot().automaticStartAllowed, false);
  assert.equal(reopened.isStartAllowed(), false);
});

test("same-app WebView migration verifies commit before removing legacy and downgrades ACTIVE", async () => {
  for (const [legacyValue, expected] of [["off", "off"], ["ready", "ready"], ["active", "ready"], ["broken", "off"]]) {
    const d = device(), legacy = new Map([[key, legacyValue]]);
    const store = createDurableEarthLocationPreferenceStore(key, d.port(), {
      getItem: name => legacy.get(name) ?? null, removeItem: name => legacy.delete(name),
    });
    assert.equal(store.getSnapshot().automaticStartAllowed, false);
    await tick();
    assert.equal(legacy.get(key), legacyValue); assert.equal(d.operations[0].value, expected);
    d.operations[0].commit(); await tick();
    assert.equal(legacy.has(key), false); assert.equal(d.values.get(key), expected);
  }
});

test("failed migration retains the old copy; an existing native preference always wins", async () => {
  const d = device(), legacy = new Map([[key, "off"]]);
  const legacyPort = { getItem: name => legacy.get(name) ?? null, removeItem: name => legacy.delete(name) };
  const failed = createDurableEarthLocationPreferenceStore(key, d.port(), legacyPort);
  await tick(); d.operations[0].fail(); await tick();
  assert.equal(legacy.get(key), "off"); assert.equal(failed.getSnapshot().enabled, false);
  assert.ok(failed.getPersistenceSnapshot().error);
  const stored = device("ready");
  assert.equal(createDurableEarthLocationPreferenceStore(key, stored.port(), legacyPort).getSnapshot().enabled, true);
  assert.equal(stored.operations.length, 0); assert.equal(legacy.get(key), "off");
});

test("session retirement and disposal prevent a delayed commit from starting GPS", async () => {
  for (const retire of ["session", "store"]) {
    const d = device("ready"), store = createDurableEarthLocationPreferenceStore(key, d.port());
    let lookups = 0;
    const lookup = withEarthLocationPreference(store, () => ++lookups);
    await tick();
    if (retire === "session") d.retire(); else store.dispose();
    d.operations[0].commit();
    assert.equal(await lookup, false); assert.equal(lookups, 0); assert.equal(store.isStartAllowed(), false);
  }
});

test("an unreadable native owner port reports the blocked lookup instead of silently falling back", async () => {
  const d = device("ready"), store = createDurableEarthLocationPreferenceStore(key, d.port());
  d.retire();
  let lookups = 0;
  assert.equal(await withEarthLocationPreference(store, () => ++lookups), false);
  assert.equal(lookups, 0); assert.match(store.getPersistenceSnapshot().error, /Перезапустите приложение/);
  assert.equal(d.operations.length, 0);
});

test("permission denial cancels pending ACTIVE and persists READY without overriding OFF", async () => {
  const d = device("ready"), store = createDurableEarthLocationPreferenceStore(key, d.port());
  const active = store.allowAutomaticStart(); await tick();
  const denied = store.suppressAutomaticStart();
  assert.equal(store.getSnapshot().automaticStartAllowed, false);
  d.operations[0].commit(); await tick();
  assert.equal(await active, false); d.operations[1].commit(); assert.equal(await denied, true);
  const off = store.setEnabled(false); await tick();
  await store.suppressAutomaticStart();
  assert.equal(store.getSnapshot().enabled, false);
  d.operations[2].commit(); assert.equal(await off, true);
});

test("all native consumers share one owner store and a new hydration retires its old port", async () => {
  const d = device("ready"); let port = d.port();
  installClientJournalStorage(() => port);
  try {
    const first = getEarthLocationPreferenceStore("ABCD-EFGH-JKMN");
    assert.equal(first, getEarthLocationPreferenceStore("ABCD-EFGH-JKMN"));
    const pending = first.allowAutomaticStart(); await tick();
    d.retire(); port = d.port();
    const next = getEarthLocationPreferenceStore("ABCD-EFGH-JKMN");
    assert.notEqual(first, next); assert.equal(next.getSnapshot().automaticStartAllowed, false);
    d.operations[0].commit(); assert.equal(await pending, false);
  } finally { installClientJournalStorage(undefined); }
});
