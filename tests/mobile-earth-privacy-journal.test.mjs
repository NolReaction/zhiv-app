import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, resolve: { alias: { "@": root } },
  server: { middlewareMode: true, hmr: false, ws: false } });
after(() => vite.close());
const { createEarthSharingController, browserEarthSharingEnvironment } = await vite.ssrLoadModule("/features/earth/sharing.ts");
const { createDurableEarthPrivacyStorage, durableEarthPrivacyStorage, earthPendingPrivacyKey } = await vite.ssrLoadModule("/features/earth/pending-privacy-storage.ts");
const { createNativeJournalStorage } = await vite.ssrLoadModule("/apps/mobile/src/native-storage/journals.ts");
const { installClientJournalStorage } = await vite.ssrLoadModule("/lib/client-journal-storage.ts");
const OWNER = "AAAA-BBBB-CCCC", UUID = "11111111-1111-4111-8111-111111111111", OTHER_UUID = "22222222-2222-4222-8222-222222222222";
const CIRCLE = "33333333-3333-4333-8333-333333333333", KEY = earthPendingPrivacyKey(OWNER);
const TIME = "2026-11-14T12:00:00.000Z";
const id = number => `00000000-0000-4000-8000-${String(number).padStart(12, "0")}`;
const intent = (mode = "OFF", number = 1) => ({ mode, key: id(number) });
async function flush() { for (let i = 0; i < 50; i++) await Promise.resolve(); }
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
function database() {
  const rows = new Map(), writes = [], gates = [];
  return { rows, writes, gates,
    async listJournals({ owner }) { return { records: [...rows].filter(([key]) => key.startsWith(`${owner}/`)).map(([key, value]) => ({ key: key.slice(owner.length + 1), value })) }; },
    async writeJournal(options) {
      writes.push(options); const gate = gates.shift(); if (gate) await gate.promise;
      const key = `${options.owner}/${options.key}`;
      assert.equal(rows.get(key) ?? null, options.expectedValue);
      if (options.value === null) rows.delete(key); else rows.set(key, options.value);
    },
  };
}
async function storageFixture(legacy) {
  const db = database(), native = createNativeJournalStorage(db);
  await native.hydrate(UUID);
  const port = native.forOwner(OWNER), storage = createDurableEarthPrivacyStorage(OWNER, port, legacy);
  return { db, native, port, storage };
}
function controllerFixture(storage, { online = true } = {}) {
  const timers = new Map(), updates = [], reads = [], resumes = [];
  let sequence = 100, timer = 0;
  const environment = { ...storage, now: () => Date.parse(TIME), monotonicNow: () => 0,
    schedule(callback) { timers.set(++timer, callback); return timer; }, cancel: key => timers.delete(key),
    visible: () => true, onVisibilityChange: () => () => {}, createId: () => id(++sequence) };
  let server = { ownerPublicId: OWNER, mode: "SHARING", revision: 1, precision: "APPROXIMATE", recipientCircleIds: [CIRCLE],
    frozenCircleIds: [], sharingUntil: null, publicationEpoch: null, serverTime: TIME };
  const transport = {
    async getEarthSharing() { reads.push("settings"); return server; },
    async getEarthPeople() { reads.push("people"); return { ownerPublicId: OWNER, people: [], serverTime: TIME }; },
    async updateEarthSharing(write, key) {
      updates.push({ write, key });
      server = { ...server, mode: write.mode, revision: server.revision + 1,
        ...(write.mode === "OFF" ? { recipientCircleIds: [], frozenCircleIds: [] } : {}) };
      return server;
    },
    async resumeEarthSharing() { resumes.push(true); throw new Error("Unexpected resume"); },
    async stopEarthPublication() { return { ownerPublicId: OWNER, serverTime: TIME }; },
  };
  const controller = createEarthSharingController({ ownerPublicId: OWNER, transport, getEnvironment: () => environment });
  const dispose = controller.activate();
  controller.setContext({ visible: true, isOnline: online, automaticResumeAllowed: false });
  return { controller, environment, transport, updates, reads, resumes, timers, dispose };
}

test("native OFF stops immediately, waits for save and only acknowledges after delete commit", async t => {
  const { db, storage } = await storageFixture(), save = deferred(), clear = deferred();
  const app = controllerFixture(storage); t.after(app.dispose); await flush();
  db.gates.push(save, clear);
  app.controller.off();
  assert.equal(app.controller.getSnapshot().pendingPrivacyMode, "OFF");
  assert.equal(app.controller.getSnapshot().publishing, false);
  assert.equal(app.controller.getSnapshot().saving, true);
  await flush(); assert.equal(app.updates.length, 0);
  save.resolve(); await flush();
  assert.equal(app.updates.length, 1);
  assert.equal(app.controller.getSnapshot().pendingGhost, true);
  assert.equal(db.rows.size, 1, "intent remains durable until delete is acknowledged");
  clear.resolve(); await flush();
  assert.equal(db.rows.size, 0); assert.equal(app.controller.getSnapshot().pendingGhost, false);
  assert.equal(app.controller.getSnapshot().settings.mode, "OFF");
});

test("offline pending OFF survives rehydration and replays before settings or a publisher", async t => {
  const { db, native, storage } = await storageFixture();
  const first = controllerFixture(storage, { online: false });
  first.controller.off(); await flush(); first.dispose();
  assert.equal(db.rows.size, 1); assert.equal(first.updates.length, 0);
  const saved = JSON.parse(db.rows.get(`${UUID}/${KEY}`));
  assert.deepEqual(Object.keys(saved).sort(), ["key", "mode"]);
  await native.hydrate(UUID);
  const next = controllerFixture(createDurableEarthPrivacyStorage(OWNER, native.forOwner(OWNER)));
  t.after(next.dispose);
  assert.equal(next.reads.length, 0); assert.equal(next.controller.getSnapshot().pendingGhost, true);
  await flush(); assert.equal(next.updates[0].key, saved.key); assert.equal(next.updates[0].write.mode, "OFF");
  assert.equal(next.resumes.length, 0); assert.equal(db.rows.size, 0);
});

test("failed disk save retains local restriction and visible restart error after best-effort server OFF", async t => {
  const { db, storage } = await storageFixture(), gate = deferred();
  const app = controllerFixture(storage); t.after(app.dispose); await flush();
  db.gates.push(gate); app.controller.off(); await flush(); gate.reject(new Error("disk full")); await flush();
  assert.equal(app.updates.length, 1); assert.equal(app.updates[0].write.mode, "OFF");
  assert.equal(app.controller.getSnapshot().pendingPrivacyMode, "OFF");
  assert.match(app.controller.getSnapshot().error, /перезапустите приложение/);
  assert.equal(app.controller.getSnapshot().saving, false);
  app.controller.refresh(); await flush(); assert.equal(app.updates.length, 1, "frozen disk must not cause an infinite server loop");
  assert.equal(await app.controller.share({ recipientCircleIds: [CIRCLE], precision: "PRECISE", durationMinutes: null }), false);
});

test("failed native delete retains the same idempotent OFF for restart replay", async t => {
  const { db, native, storage } = await storageFixture(), clear = deferred();
  const first = controllerFixture(storage); await flush();
  db.gates.push(null, clear); first.controller.off(); await flush();
  clear.reject(new Error("lost delete ACK")); await flush();
  assert.equal(first.controller.getSnapshot().pendingGhost, true);
  assert.match(first.controller.getSnapshot().error, /перезапустите приложение/);
  const saved = first.updates[0].key; first.dispose();
  await native.hydrate(UUID);
  const next = controllerFixture(createDurableEarthPrivacyStorage(OWNER, native.forOwner(OWNER))); t.after(next.dispose);
  await flush(); assert.equal(next.updates[0].key, saved); assert.equal(next.controller.getSnapshot().pendingGhost, false);
});

test("newer OFF beats deferred GHOST persistence without a stale request or acknowledgement", async t => {
  const { db, storage } = await storageFixture(), gate = deferred();
  const app = controllerFixture(storage); t.after(app.dispose); await flush();
  db.gates.push(gate); app.controller.ghost(); await flush(); app.controller.off();
  assert.equal(app.controller.getSnapshot().pendingPrivacyMode, "OFF");
  gate.resolve(); await flush();
  assert.deepEqual(app.updates.map(value => value.write.mode), ["OFF"]);
  assert.equal(app.controller.getSnapshot().settings.mode, "OFF");
});

test("OFF arriving during a GHOST delete cannot be cleared by the older acknowledgement", async t => {
  const { db, storage } = await storageFixture(), clearingGhost = deferred(), savingOff = deferred();
  const app = controllerFixture(storage); t.after(app.dispose); await flush();
  db.gates.push(null, clearingGhost, savingOff);
  app.controller.ghost(); await flush();
  assert.equal(app.updates[0].write.mode, "GHOST");
  app.controller.off(); clearingGhost.resolve(); await flush();
  assert.equal(app.controller.getSnapshot().pendingPrivacyMode, "OFF");
  assert.equal(app.controller.getSnapshot().pendingGhost, true);
  assert.equal(app.updates.length, 1, "new OFF still waits for its own commit");
  savingOff.resolve(); await flush();
  assert.deepEqual(app.updates.map(value => value.write.mode), ["GHOST", "OFF"]);
  assert.equal(app.controller.getSnapshot().settings.mode, "OFF");
});

test("account transition and disposal fence a late native privacy save", async t => {
  const { db, native, storage } = await storageFixture(), gate = deferred();
  const first = controllerFixture(storage); await flush();
  db.gates.push(gate); first.controller.off(); await flush(); first.dispose();
  const switching = native.hydrate(OTHER_UUID); gate.resolve(); await switching; await flush();
  const next = controllerFixture(createDurableEarthPrivacyStorage(OWNER, native.forOwner(OWNER))); t.after(next.dispose); await flush();
  assert.equal(first.updates.length, 0); assert.equal(next.updates.length, 0);
  assert.equal(next.controller.getSnapshot().pendingGhost, false);
  assert.equal(db.rows.has(`${OTHER_UUID}/${KEY}`), false);
  assert.throws(() => storage.loadPending(), /Аккаунт изменился/);
});

test("same-session remount keeps an in-flight restriction until its durable commit", async t => {
  const { db, port } = await storageFixture(), gate = deferred();
  const storage = durableEarthPrivacyStorage(OWNER, port);
  const first = controllerFixture(storage); await flush();
  db.gates.push(gate); first.controller.off(); await flush(); first.dispose();
  assert.equal(durableEarthPrivacyStorage(OWNER, port), storage);
  const next = controllerFixture(storage); t.after(next.dispose);
  assert.equal(next.controller.getSnapshot().pendingPrivacyMode, "OFF"); assert.equal(next.reads.length, 0);
  gate.resolve(); await flush(); assert.equal(first.updates.length, 0); assert.equal(next.updates.length, 1);
});

test("same-app legacy intent is removed only after verified SQLite migration", async () => {
  const rows = new Map([[KEY, JSON.stringify(intent("GHOST"))]]);
  const legacy = { getItem: key => rows.get(key) ?? null, removeItem: key => rows.delete(key) };
  const { db, storage } = await storageFixture(legacy), gate = deferred();
  db.gates.push(gate);
  const saved = storage.loadPending(), writing = storage.savePending(saved); await flush();
  assert.equal(rows.size, 1); assert.equal(db.rows.size, 0);
  gate.resolve(); await writing;
  assert.equal(rows.size, 0); assert.deepEqual(JSON.parse(db.rows.get(`${UUID}/${KEY}`)), intent("GHOST"));
});

test("failed migration retains the legacy OFF for the next hydrated session", async () => {
  const rows = new Map([[KEY, JSON.stringify(intent())]]);
  const legacy = { getItem: key => rows.get(key) ?? null, removeItem: key => rows.delete(key) };
  const { db, native, storage } = await storageFixture(legacy), gate = deferred();
  db.gates.push(gate);
  const writing = storage.savePending(storage.loadPending()); await flush(); gate.reject(new Error("disk full"));
  await assert.rejects(writing, /disk full/); assert.equal(rows.size, 1);
  await native.hydrate(UUID);
  const next = createDurableEarthPrivacyStorage(OWNER, native.forOwner(OWNER), legacy);
  assert.deepEqual(next.loadPending(), intent()); await next.savePending(next.loadPending());
  assert.equal(rows.size, 0); assert.equal(db.rows.size, 1);
});

test("failed legacy cleanup cannot erase the last durable OFF and resurrect it unnoticed", async () => {
  const rows = new Map([[KEY, JSON.stringify(intent())]]);
  const legacy = { getItem: key => rows.get(key) ?? null, removeItem() { throw new Error("read only"); } };
  const { db, storage } = await storageFixture(legacy);
  await storage.savePending(storage.loadPending());
  await assert.rejects(storage.clearPending(id(1)), /read only/);
  assert.equal(db.rows.size, 1); assert.equal(rows.size, 1);
});

test("native environment uses the owner journal and malformed records block automatic reads", async t => {
  const { db, native } = await storageFixture();
  db.rows.set(`${UUID}/${KEY}`, JSON.stringify({ mode: "SHARING", key: id(1) }));
  await native.hydrate(UUID);
  installClientJournalStorage(owner => native.forOwner(owner)); t.after(() => installClientJournalStorage(undefined));
  const environment = browserEarthSharingEnvironment(OWNER);
  assert.equal(environment.durablePending, true);
  const app = controllerFixture(environment); t.after(app.dispose); await flush();
  assert.equal(app.reads.length, 0); assert.equal(app.updates.length, 0); assert.equal(app.resumes.length, 0);
  assert.match(app.controller.getSnapshot().error, /перезапустите приложение/);
});
