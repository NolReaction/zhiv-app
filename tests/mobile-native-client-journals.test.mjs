import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false, watch: null } });
after(() => vite.close());
const { createNativeJournalStorage, journalKeyOwner } = await vite.ssrLoadModule("/apps/mobile/src/native-storage/journals.ts");
const { acquireClientJournalLock } = await vite.ssrLoadModule("/lib/client-journal-storage.ts");
const { createEconomySession } = await vite.ssrLoadModule("/features/economy/sync/session.ts");
const { economyCatalog, economyViewSchema } = await vite.ssrLoadModule("/features/economy/domain/model.ts");
const { createPreparedBoatQueue } = await vite.ssrLoadModule("/features/economy/sync/prepared-boat-queue.ts");
const { newEconomyState, applyEconomyCommand } = await vite.ssrLoadModule("/features/economy/domain/rules.ts");
const { publicBoatState } = await vite.ssrLoadModule("/features/economy/domain/boat-fishing.ts");
const { initialBoatReel, stepBoatReel } = await vite.ssrLoadModule("/features/economy/domain/boat-reel.ts");
const owner = "AAAA-0000-0001", other = "AAAA-0000-0002";
const user = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", userB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const key = `zhiv:economy:production:v1:${owner}`;
const tick = () => new Promise(resolve => setImmediate(resolve));
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
function database() {
  const rows = new Map(), calls = []; let next = null;
  return { rows, calls, gate: () => next = deferred(),
    listJournals: async ({ owner }) => ({ records: [...rows.values()].filter(row => row.owner === owner).map(({ key, value }) => ({ key, value })) }),
    async writeJournal(row) {
      calls.push(row); const gate = next; next = null; if (gate) await gate.promise;
      const id = `${row.owner}/${row.key}`;
      if ((rows.get(id)?.value ?? null) !== row.expectedValue) throw Error("CAS conflict");
      if (row.value === null) rows.delete(id); else rows.set(id, row);
    },
  };
}
async function opened(db = database()) { const storage = createNativeJournalStorage(db); await storage.hydrate(user); return { db, storage, port: storage.forOwner(owner) }; }
const base = () => economyViewSchema.parse({ ownerPublicId: owner, revision: 8, serverTime: new Date().toISOString(), wallet: { coins: 1000, pearls: 0 },
  inventory: { wood: 3, berries: 3 }, buildings: { home: 5, garden: 3, woodlot: 3, workshop: 3, warehouse: 1, dryer: 3, kiln: 3 },
  productionSlots: { garden: 3, workshop: 3 }, storage: { capacity: 50, used: 6, reserved: 0, available: 44, overflow: 0 }, jobs: [],
  migration: { version: 1, coinsGranted: 0, woodGranted: 0, stoneGranted: 0 }, completedExplorations: 0, catalog: economyCatalog });
async function sessionWith(context, options = {}) {
  const sent = [], state = base();
  const session = createEconomySession(owner, { get: async () => state, market: async () => assert.fail(), trade: async () => assert.fail(),
    send: async command => { sent.push(command); throw Error("response lost"); } }, () => assert.fail(), undefined,
    { native: true, storage: context.port, coordinate: (_, signal) => acquireClientJournalLock(context.port, signal), ...options });
  const stop = session.activate(); await session.refresh(); await context.storage.flush(); await tick();
  return { session, stop, sent, state };
}

test("native committed view and acceptance stay unchanged until SQLite acknowledges", async () => {
  const { db, port } = await opened(), gate = db.gate();
  let accepted = false; const pending = port.setItem(key, "first").then(() => accepted = true);
  await tick(); assert.equal(accepted, false); assert.equal(port.getItem(key), null);
  gate.resolve(); await pending; assert.equal(port.getItem(key), "first");
  await Promise.all([port.setItem(key, "second"), port.setItem(key, "third")]);
  assert.deepEqual(db.calls.map(row => row.expectedValue), [null, "first", "second"]);
  assert.equal(port.getItem(key), "third");
});

test("lost native ACK freezes the view and reopening reads the committed write", async () => {
  const db = database(), write = db.writeJournal; db.writeJournal = async row => { await write(row); throw Error("ACK lost"); };
  const { storage, port } = await opened(db);
  await assert.rejects(port.setItem(key, "saved"), /ACK lost/);
  assert.throws(() => port.getItem(key), /ACK lost/);
  assert.throws(() => port.setItem(key, "overwrite"), /ACK lost/);
  db.writeJournal = write; await storage.hydrate(user);
  assert.equal(storage.forOwner(owner).getItem(key), "saved");
  assert.throws(() => port.getItem(key), /изменился/);
});

test("owner transition retires pending callbacks before new hydration and never exposes another account", async () => {
  const { storage, db, port } = await opened(), gate = db.gate();
  const pending = port.setItem(key, "owner A"); await tick();
  const rejected = assert.rejects(pending, /изменился/); const next = storage.hydrate(userB);
  assert.throws(() => port.getItem(key), /изменился/); gate.resolve(); await rejected; await next;
  assert.equal(storage.forOwner(owner).getItem(key), null);
  await storage.hydrate(user); const reopened = storage.forOwner(owner);
  assert.equal(reopened.getItem(key), "owner A"); assert.equal(reopened, storage.forOwner(owner));
  await storage.hydrate(user); assert.notEqual(storage.forOwner(owner), reopened); assert.throws(() => reopened.getKeys(), /изменился/);
});

test("CAS conflicts preserve concurrent data and fail closed", async () => {
  const { db, port } = await opened(); db.rows.set(`${user}/${key}`, { owner: user, key, value: "another process" });
  await assert.rejects(port.setItem(key, "mine"), /CAS conflict/);
  assert.equal(db.rows.get(`${user}/${key}`).value, "another process"); assert.throws(() => port.getKeys(), /CAS conflict/);
});

test("journal allowlist keeps owner and gameplay generation separate", async () => {
  const { port } = await opened();
  for (const prefix of ["zhiv:earth:pending-privacy:v1:", "zhiv:check-in:pending:v1:", "zhiv:game-rewards:pending:v1:", "zhiv:world:pending:v1:", "zhiv.earth-location.v1:"])
    assert.equal(journalKeyOwner(prefix + owner), owner);
  assert.equal(journalKeyOwner(`zhiv:gameplay:v1:12:${key}`), owner);
  assert.equal(journalKeyOwner(`zhiv.boat-reel.current.${owner}`), owner);
  assert.equal(journalKeyOwner("arbitrary-key"), null);
  assert.throws(() => port.getItem(key.replace(owner, other)), /другому/);
  await port.setItem(key, "old"); await port.setItem(`zhiv:gameplay:v1:2:${key}`, "new");
  assert.equal(port.getItem(key), "old"); assert.equal(port.getItem(`zhiv:gameplay:v1:2:${key}`), "new");
  await assert.rejects(port.setItem(key, "x".repeat(6_000_001)), /слишком большой/);
});

test("malformed native hydration does not publish an empty usable port", async () => {
  const storage = createNativeJournalStorage({ listJournals: async () => ({ records: [{ key: "token", value: "secret" }] }), writeJournal: async () => {} });
  await assert.rejects(storage.hydrate(user), /Повреждён/); assert.throws(() => storage.forOwner(owner), /не готово/);
});

test("production reserves no resources and sends no HTTP before durable acceptance; restart restores the exact intent", async () => {
  const context = await opened(), { session, stop, sent } = await sessionWith(context); session.setAvailable(false);
  try {
    const gate = context.db.gate(), accepted = session.act("start_production", "grow_berries");
    assert.ok(accepted instanceof Promise); await tick();
    assert.equal(session.getSnapshot().pendingProductionCount, 0); assert.equal(session.getSnapshot().storagePending, true);
    assert.equal(session.act("start_production", "grow_berries"), false); assert.equal(sent.length, 0);
    gate.resolve(); assert.equal(await accepted, true); assert.equal(session.getSnapshot().pendingProductionCount, 1);
    const original = JSON.parse(context.port.getItem(key)).entries[0].requestId;
    stop(); await context.storage.hydrate(user); const port = context.storage.forOwner(owner);
    const restored = createEconomySession(owner, { get: async () => { throw Error("offline"); } }, () => {}, undefined,
      { native: true, storage: port, coordinate: (_, signal) => acquireClientJournalLock(port, signal) });
    restored.setAvailable(false); const end = restored.activate(); await tick();
    try { assert.equal(restored.getSnapshot().pendingProductionIds[0], original); assert.equal(restored.getSnapshot().productionSnapshot.jobs.length, 1); }
    finally { end(); }
  } finally { stop(); }
});

test("failed production save is not accepted, does not dispatch, and cannot fall through to direct action", async () => {
  const context = await opened(), { session, stop, sent } = await sessionWith(context);
  try {
    const gate = context.db.gate(), pending = session.act("start_production", "grow_berries"); await tick(); gate.reject(Error("disk full"));
    assert.equal(await pending, false); assert.equal(session.getSnapshot().pendingProductionCount, 0); assert.equal(sent.length, 0);
    assert.match(session.getSnapshot().storageError, /Не удалось сохранить/); assert.equal(session.act("start_production", "grow_berries"), false);
  } finally { stop(); }
});

test("retiring the production controller during commit cannot acknowledge the old screen", async () => {
  const context = await opened(), { session, stop, sent } = await sessionWith(context);
  const gate = context.db.gate(), pending = session.act("start_production", "grow_berries"); await tick(); stop(); gate.resolve();
  assert.equal(await pending, false); assert.equal(sent.length, 0); assert.equal(session.getSnapshot().pendingProductionCount, 0);
});

test("legacy production intent is deleted only after verified native commit", async () => {
  const context = await opened(), snapshot = base();
  const raw = JSON.stringify({ version: 1, owner, snapshot, entries: [{ requestId: crypto.randomUUID(), targetId: "grow_berries" }] });
  const old = new Map([[key, raw]]), legacy = { getItem: key => old.get(key) ?? null, removeItem: key => { old.delete(key); }, setItem: () => assert.fail() };
  const gate = context.db.gate();
  const session = createEconomySession(owner, { get: async () => { throw Error("offline"); } }, () => {}, undefined,
    { native: true, storage: context.port, legacyStorage: legacy, coordinate: (_, signal) => acquireClientJournalLock(context.port, signal) });
  session.setAvailable(false); const stop = session.activate(); await tick();
  try {
    assert.equal(old.get(key), raw); assert.equal(session.getSnapshot().pendingProductionCount, 0); gate.resolve(); await tick();
    assert.equal(old.has(key), false); assert.equal(context.port.getItem(key), raw); assert.equal(session.getSnapshot().pendingProductionCount, 1);
  } finally { stop(); }
});

function boatSnapshot() {
  const state = newEconomyState({ resources: { sparks: 0, wood: 0, stone: 0 }, houseLevel: 3, workshopLevel: 3 });
  state.wallet.coins = 100000; state.inventory = { planks: 12, rope: 12, hardwood: 3 }; state.buildings.warehouse = 3; state.boat.level = 1;
  const now = Date.now();
  applyEconomyCommand(state, { requestId: crypto.randomUUID(), ownerPublicId: owner, expectedRevision: 0, action: "depart_boat", targetId: "river_reach", quantity: 1, totalPrice: 0 }, now, () => crypto.randomUUID(), {}, () => 37);
  return { ...base(), boat: publicBoatState(state.boat) };
}
function prepared(context, snapshot = boatSnapshot()) {
  let generation = 0, now = Date.parse(snapshot.boat.voyage.arrivesAt) + 1000, online = false;
  const messages = [], sent = [];
  const queue = createPreparedBoatQueue(owner, { lifetime: () => generation, snapshot: () => snapshot, confirmed: () => true, now: () => now,
    storage: () => context.port, canSend: () => online, localAllowed: () => true, canReserve: () => true, preferPrepared: () => true, legacyLanding: () => undefined,
    send: async command => { sent.push(command); throw Error("lost response"); }, get: async () => snapshot, adopt: () => true,
    changed: message => messages.push(message), sessionLost: () => assert.fail() });
  return { queue, snapshot, sent, messages, setTime: value => now = value, retire: () => generation++, connect: () => online = true };
}
function play(challenge) {
  let reel = initialBoatReel(challenge), held = false; const inputs = [];
  while (reel.status === "active") {
    const next = reel.fish > reel.bar + reel.velocity * 4;
    if (next !== held) { inputs.push({ tick: reel.tick, held: next }); held = next; }
    reel = stepBoatReel(challenge, reel, held);
  }
  return { challengeId: challenge.id, endTick: reel.tick, inputs, deferred: true };
}

test("prepared cast reservation and terminal catch become visible only after independent SQLite commits", async () => {
  const context = await opened(), { queue, snapshot, sent } = prepared(context), voyage = snapshot.boat.voyage;
  const first = context.db.gate(), start = queue.begin(voyage.id, 1620); await tick();
  assert.ok(start instanceof Promise); assert.equal(queue.view().preparedBoatPending, false); assert.equal(queue.isSaving(), true);
  assert.equal(queue.begin(voyage.id, 1620), false); first.resolve(); assert.equal(await start, true);
  const challenge = queue.view().localBoatVoyage.challenge, trace = play(challenge);
  const last = context.db.gate(), finish = queue.finish(voyage.id, trace); await tick();
  assert.equal(queue.hasTerminal(), false); assert.equal(sent.length, 0); assert.equal(queue.view().localBoatCatches, 0);
  last.resolve(); assert.equal(await finish, true); assert.equal(queue.hasTerminal(), true); assert.equal(sent.length, 0);
  const restored = prepared(context, snapshot).queue; restored.restore();
  assert.equal(restored.hasTerminal(), true); assert.equal(restored.view().localBoatCatches, queue.view().localBoatCatches);
});

test("failed prepared start keeps the server ticket available without claiming a local cast", async () => {
  const context = await opened(), { queue, snapshot, messages } = prepared(context), gate = context.db.gate();
  const start = queue.begin(snapshot.boat.voyage.id, 1620); await tick(); gate.reject(Error("disk full"));
  assert.equal(await start, false); assert.equal(queue.hasEntries(), false); assert.equal(queue.view().preparedBoatCastAvailable, false);
  assert.match(messages.at(-1).storageError, /Не удалось сохранить/);
});

test("prepared command is committed before HTTP and lost response reuses original request on reopen", async () => {
  const context = await opened(), setup = prepared(context), { queue, snapshot, sent } = setup;
  assert.equal(await queue.begin(snapshot.boat.voyage.id, 1620), true);
  assert.equal(await queue.finish(snapshot.boat.voyage.id, play(queue.view().localBoatVoyage.challenge)), true);
  const gate = context.db.gate(); setup.connect(); const sending = queue.drain(); await tick(); assert.equal(sent.length, 0);
  gate.resolve(); await sending; assert.equal(sent.length, 1);
  const reopened = prepared(context, snapshot); reopened.queue.restore(); reopened.connect(); await reopened.queue.drain();
  assert.equal(reopened.sent.length, 1); assert.equal(reopened.sent[0].requestId, sent[0].requestId);
  assert.deepEqual(reopened.sent[0].reel, sent[0].reel);
});

test("prepared completion from a retired lifetime is never accepted by the replacement controller", async () => {
  const context = await opened(), setup = prepared(context), gate = context.db.gate();
  const pending = setup.queue.begin(setup.snapshot.boat.voyage.id, 1620); await tick(); setup.retire(); setup.queue.pause(); gate.resolve();
  assert.equal(await pending, false); assert.equal(setup.queue.hasEntries(), false);
});


test("failed legacy production import retains WebView recovery data and exposes storage failure", async () => {
  const context = await opened(), raw = JSON.stringify({ version: 1, owner, snapshot: base(), entries: [{ requestId: crypto.randomUUID(), targetId: "grow_berries" }] });
  let legacy = raw;
  const gate = context.db.gate();
  const session = createEconomySession(owner, { get: async () => { throw Error("offline"); } }, () => {}, undefined,
    { native: true, storage: context.port, legacyStorage: { getItem: key_ => key_ === key ? legacy : null, removeItem: () => legacy = null }, coordinate: (_, signal) => acquireClientJournalLock(context.port, signal) });
  session.setAvailable(false); const stop = session.activate(); await tick(); gate.reject(Error("disk full")); await tick();
  try { assert.equal(legacy, raw); assert.equal(session.getSnapshot().pendingProductionCount, 0); assert.match(session.getSnapshot().storageError, /Не удалось открыть/); }
  finally { stop(); }
});

test("interrupted legacy cleanup keeps the verified native copy usable and does not duplicate its intent", async () => {
  const context = await opened(), requestId = crypto.randomUUID();
  const raw = JSON.stringify({ version: 1, owner, snapshot: base(), entries: [{ requestId, targetId: "grow_berries" }] });
  const options = { native: true, storage: context.port, legacyStorage: { getItem: key_ => key_ === key ? raw : null, removeItem: () => { throw Error("browser storage blocked"); } }, coordinate: (_, signal) => acquireClientJournalLock(context.port, signal) };
  for (let count = 0; count < 2; count++) {
    const session = createEconomySession(owner, { get: async () => { throw Error("offline"); } }, () => {}, undefined, options);
    session.setAvailable(false); const stop = session.activate(); await tick();
    try { assert.deepEqual(session.getSnapshot().pendingProductionIds, [requestId]); assert.equal(session.getSnapshot().storageError, null); assert.equal(context.port.getItem(key), raw); }
    finally { stop(); }
  }
});
