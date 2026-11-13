import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root,
  resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false } });
const { createNativeRequestOutbox } = await vite.ssrLoadModule("/apps/mobile/src/native-storage/outbox.ts");
const { createNativeSettingsStorage, NATIVE_SETTINGS_PREFIX } = await vite.ssrLoadModule("/apps/mobile/src/native-storage/settings.ts");
after(() => vite.close());
const ownerA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ownerB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const requestId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const publicId = "ABCD-EFGH-JKMP";
const command = { requestId, ownerPublicId: publicId, expectedRevision: 3, action: "start_production", targetId: "boards", quantity: 1, totalPrice: 0 };
const acknowledged = JSON.stringify({ state: { ownerPublicId: publicId, revision: 4 }, acceptedRevision: 4, replayed: true, message: "Готово" });
const storageKey = `zhiv:gameplay:v1:2:zhiv:economy:pending:v1:${publicId}`;
function memory() {
  const data = new Map();
  return { data, getItem: key => data.get(key) ?? null, setItem: (key, value) => { data.set(key, value); }, removeItem: key => { data.delete(key); } };
}
function database() {
  const data = new Map();
  return { data,
    list: async ({ owner }) => ({ records: [...data.values()].filter(value => value.owner === owner).map(({ key, value }) => ({ key, value })) }),
    put: async record => {
      const key = `${record.owner}/${record.key}`, old = data.get(key);
      if (old && old.value !== record.value) throw new Error("Immutable receipt conflict");
      data.set(key, record);
    },
    remove: async ({ owner, key, expectedValue }) => { const id = `${owner}/${key}`; if (data.get(id)?.value === expectedValue) data.delete(id); },
  };
}
function request(overrides = {}) {
  return { userId: ownerA, path: "/api/v1/economy/commands", method: "POST", headers: { "X-Game-Generation": "2" },
    body: Buffer.from(JSON.stringify(command)).toString("base64"), ...overrides };
}
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }

test("SQLite acknowledgement is awaited before a request can dispatch", async () => {
  const db = database(), write = deferred();
  const original = db.put;
  db.put = async record => { await write.promise; await original(record); };
  const outbox = createNativeRequestOutbox(db, memory()); await outbox.hydrate(ownerA);
  let prepared = false;
  const pending = outbox.prepare(request()).then(receipt => { prepared = true; return receipt; });
  await Promise.resolve(); assert.equal(prepared, false);
  write.resolve(); await pending;
  assert.equal(prepared, true); assert.equal(db.data.size, 1);
});

test("lost response survives process restart with exact request ID and gameplay generation", async () => {
  const db = database();
  const first = createNativeRequestOutbox(db, memory()); await first.hydrate(ownerA);
  await first.prepare(request());
  const restart = createNativeRequestOutbox(db, memory()); await restart.hydrate(ownerA);
  const restored = JSON.parse(restart.receipts.getItem(storageKey));
  assert.deepEqual(restored, { kind: "economy", command });
  assert.equal(restart.receipts.getItem(`zhiv:economy:pending:v1:${publicId}`), null);
  const retry = await restart.prepare(request());
  assert.equal(db.data.size, 1);
  await retry.settle(200, acknowledged);
  assert.equal(db.data.size, 0); assert.equal(restart.receipts.getItem(storageKey), null);
});

test("other account cannot see or dispatch recovered commands", async () => {
  const db = database(), outbox = createNativeRequestOutbox(db, memory());
  await outbox.hydrate(ownerA); await outbox.prepare(request());
  await outbox.hydrate(ownerB);
  assert.equal(outbox.receipts.getItem(storageKey), null);
  await assert.rejects(outbox.prepare(request()), /аккаунта/);
  assert.equal(db.data.size, 1);
});

test("account switch during native commit blocks the old request from dispatching", async () => {
  const db = database(), write = deferred(), put = db.put;
  db.put = async record => { await write.promise; await put(record); };
  const outbox = createNativeRequestOutbox(db, memory()); await outbox.hydrate(ownerA);
  const pending = outbox.prepare(request());
  await outbox.hydrate(ownerB); write.resolve();
  await assert.rejects(pending, /Аккаунт изменился/);
  assert.equal(outbox.receipts.getItem(storageKey), null);
});

test("changed payload cannot reuse an idempotency key", async () => {
  const db = database(), outbox = createNativeRequestOutbox(db, memory()); await outbox.hydrate(ownerA);
  await outbox.prepare(request());
  await assert.rejects(outbox.prepare(request({ body: Buffer.from(JSON.stringify({ ...command, targetId: "rope" })).toString("base64") })), /Immutable/);
  assert.deepEqual(JSON.parse(outbox.receipts.getItem(storageKey)).command, command);
});

test("uncertain responses retain receipts and definitive rejection clears them", async () => {
  for (const status of [401, 403, 408, 425, 429, 500, 503]) {
    const db = database(), outbox = createNativeRequestOutbox(db, memory()); await outbox.hydrate(ownerA);
    const receipt = await outbox.prepare(request()); await receipt.settle(status);
    assert.equal(db.data.size, 1, `status ${status} remains uncertain`);
    await receipt.settle(409); assert.equal(db.data.size, 0);
  }
});

test("failed cleanup preserves safe retry across restart without reoffering completed work in the live process", async () => {
  const db = database(), remove = db.remove;
  db.remove = async () => { throw new Error("disk locked"); };
  const first = createNativeRequestOutbox(db, memory()); await first.hydrate(ownerA);
  const receipt = await first.prepare(request()); await assert.rejects(receipt.settle(200, acknowledged));
  assert.equal(first.receipts.getItem(storageKey), null);
  db.remove = remove;
  const restarted = createNativeRequestOutbox(db, memory()); await restarted.hydrate(ownerA);
  assert.equal(JSON.parse(restarted.receipts.getItem(storageKey)).command.requestId, requestId);
  await (await restarted.prepare(request())).settle(200, acknowledged); assert.equal(db.data.size, 0);
});

test("multiple recovered receipts drain through existing reconciliation one at a time", async () => {
  const db = database(), outbox = createNativeRequestOutbox(db, memory()); await outbox.hydrate(ownerA);
  await outbox.prepare(request());
  const secondCommand = { ...command, requestId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd" };
  const second = request({ body: Buffer.from(JSON.stringify(secondCommand)).toString("base64") });
  await outbox.prepare(second);
  const restarted = createNativeRequestOutbox(db, memory()); await restarted.hydrate(ownerA);
  assert.equal(JSON.parse(restarted.receipts.getItem(storageKey)).command.requestId, requestId);
  await (await restarted.prepare(request())).settle(200, acknowledged);
  assert.equal(JSON.parse(restarted.receipts.getItem(storageKey)).command.requestId, secondCommand.requestId);
});

test("non-economic traffic is excluded; eligible requests require explicit valid generation", async () => {
  const db = database(), outbox = createNativeRequestOutbox(db, memory()); await outbox.hydrate(ownerA);
  await outbox.prepare(request({ path: "/api/v1/earth/location" }));
  await outbox.prepare(request({ method: "GET" }));
  assert.equal(db.data.size, 0);
  await assert.rejects(outbox.prepare(request({ headers: {} })), /версия/);
  await assert.rejects(outbox.prepare(request({ headers: { "x-game-generation": "-1" } })), /версия/);
});

test("damaged native records fail boot without deleting or replaying user data", async () => {
  const db = database();
  db.data.set("broken", { owner: ownerA, key: `2:${requestId}`, value: "{}" });
  const outbox = createNativeRequestOutbox(db, memory());
  await assert.rejects(outbox.hydrate(ownerA), /очередь/);
  assert.equal(db.data.size, 1); assert.equal(outbox.receipts.getItem(storageKey), null);
});

test("settings hydrate before read; native writes serialize and survive a fresh store", async () => {
  const data = new Map([[NATIVE_SETTINGS_PREFIX + encodeURIComponent("volume"), "0.4"]]);
  const firstWrite = deferred(); let writes = 0;
  const port = {
    keys: async () => ({ keys: [...data.keys()] }), get: async ({ key }) => ({ value: data.get(key) ?? null }),
    set: async ({ key, value }) => { if (++writes === 1) await firstWrite.promise; data.set(key, value); },
    remove: async ({ key }) => { data.delete(key); },
  };
  const settings = createNativeSettingsStorage(port);
  assert.throws(() => settings.storage.getItem("volume"), /не загружены/);
  await settings.hydrate(); assert.equal(settings.storage.getItem("volume"), "0.4");
  settings.storage.setItem("volume", "0.5"); settings.storage.setItem("volume", "0.8");
  await Promise.resolve(); assert.equal(writes, 1); assert.equal(settings.getSnapshot().pending, 2);
  firstWrite.resolve(); await settings.flush();
  assert.equal(settings.getSnapshot().pending, 0);
  const restarted = createNativeSettingsStorage(port); await restarted.hydrate();
  assert.equal(restarted.storage.getItem("volume"), "0.8");
});

test("a preference failure stays visible until that key is retried", async () => {
  let fail = true;
  const port = { keys: async () => ({ keys: [] }), get: async () => ({ value: null }), remove: async () => {},
    set: async ({ key }) => { if (fail && key.endsWith("sound")) throw new Error("disk full"); } };
  const settings = createNativeSettingsStorage(port); await settings.hydrate();
  settings.storage.setItem("sound", "off"); await settings.flush(); assert.ok(settings.getSnapshot().error);
  settings.storage.setItem("hints", "on"); await settings.flush(); assert.ok(settings.getSnapshot().error);
  fail = false; settings.storage.setItem("sound", "off"); await settings.flush(); assert.equal(settings.getSnapshot().error, null);
});

test("economy reconciliation restores successive native receipts using original IDs", async t => {
  const { createEconomySession } = await vite.ssrLoadModule("/features/economy/sync/session.ts");
  const { economyCatalog } = await vite.ssrLoadModule("/features/economy/domain/model.ts");
  const db = database(), outbox = createNativeRequestOutbox(db, memory());
  await outbox.hydrate(ownerA);
  const second = { ...command, requestId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee" };
  const envelope = body => request({ headers: { "X-Game-Generation": "0" }, body: Buffer.from(JSON.stringify(body)).toString("base64") });
  await outbox.prepare(envelope(command)); await outbox.prepare(envelope(second));
  const restarted = createNativeRequestOutbox(db, memory()); await restarted.hydrate(ownerA);
  const seen = [];
  let clock = performance.now();
  t.mock.method(performance, "now", () => clock);
  const snapshot = { ownerPublicId: publicId, revision: 3, serverTime: new Date().toISOString(), wallet: { coins: 1000, pearls: 0 }, inventory: {},
    buildings: { home: 1, garden: 1, warehouse: 1, kiln: 0 }, storage: { capacity: 200, used: 0, reserved: 0, available: 200, overflow: 0 },
    jobs: [], migration: { version: 1, coinsGranted: 0, woodGranted: 0, stoneGranted: 0 }, catalog: economyCatalog, completedExplorations: 0 };
  const session = createEconomySession(publicId, {
    get: async () => snapshot,
    send: async body => {
      seen.push(body.requestId);
      await (await restarted.prepare(envelope(body))).settle(200, acknowledged);
      return { state: snapshot, message: "Готово", acceptedRevision: 3, replayed: true };
    },
    market: async () => ({ ownerPublicId: publicId, listings: [], mine: [], nextCursor: null, serverTime: snapshot.serverTime }),
    trade: async () => { throw new Error("Unexpected market call"); },
  }, () => assert.fail("Unexpected session loss"), restarted.receipts);
  const stop = session.activate();
  await session.refresh();
  await session.reconcile();
  await session.retryPending();
  clock += 2_001;
  await session.retryPending();
  assert.deepEqual(seen, [requestId, second.requestId]);
  assert.equal(db.data.size, 0);
  stop();
});

test("a 200 response without an account-bound receipt does not discard the write-ahead record", async () => {
  const db = database(), outbox = createNativeRequestOutbox(db, memory()); await outbox.hydrate(ownerA);
  const receipt = await outbox.prepare(request());
  for (const value of [undefined, "<html>proxy error</html>", "{", JSON.stringify({ state: { ownerPublicId: "OTHER" }, acceptedRevision: 4, replayed: true, message: "ok" })]) {
    await receipt.settle(200, value); assert.equal(db.data.size, 1);
  }
  await receipt.settle(200, acknowledged); assert.equal(db.data.size, 0);
});
