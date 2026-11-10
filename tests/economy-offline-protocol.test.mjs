import assert from "node:assert/strict";
import test, { after, beforeEach } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root,
  cacheDir: `/tmp/zhiv-offline-protocol-vite-${process.pid}`,
  resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false } });
after(() => vite.close());
const identities = await vite.ssrLoadModule("/lib/dev/api-store.ts");
const economy = await vite.ssrLoadModule("/lib/dev/economy-store.ts");
const { createEconomySession } = await vite.ssrLoadModule("/features/economy/sync/session.ts");
const { productionJournalKey, browserJournalCoordinator } = await vite.ssrLoadModule("/features/economy/sync/production-journal.ts");
const { ApiError } = await vite.ssrLoadModule("/lib/check-in-api.ts");
const instant = Date.parse("2026-10-15T12:00:00Z");
beforeEach(() => { identities.resetDevStoreForTests(); economy.resetDevEconomyStoreForTests(); });
const flush = async () => { for (let i = 0; i < 8; i++) await new Promise(resolve => setImmediate(resolve)); };
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
function storage() {
  const data = new Map();
  return { data, failWrites: false, getItem: key => data.get(key) ?? null,
    setItem(key, value) { if (this.failWrites) throw new Error("Storage full"); data.set(key, value); },
    removeItem: key => data.delete(key) };
}
function fixture() {
  const p = identities.createDevIdentity("Offline crafter", crypto.randomUUID());
  economy.getDevEconomy(p.token, instant);
  const row = globalThis.__zhivDevEconomyStore.profiles.get(p.me.user.publicId);
  Object.assign(row.state, { inventory: { wood: 4, berries: 6 },
    buildings: { ...row.state.buildings, home: 3, workshop: 1, woodlot: 1, warehouse: 10 },
    productionSlots: { workshop: 3, garden: 3 } });
  const owner = p.me.user.publicId, cache = storage(), legacy = storage(), sent = [];
  const read = () => economy.getDevEconomy(p.token, instant);
  const command = (action, targetId, quantity = 1) => ({ requestId: crypto.randomUUID(), ownerPublicId: owner,
    expectedRevision: read().revision, action, targetId, quantity, totalPrice: 0 });
  const apply = input => {
    try { return economy.commandDevEconomy(p.token, input, instant); }
    catch (error) { throw new ApiError(error.message, error.status, { code: error.code, message: error.message }); }
  };
  const create = ({ send = input => apply(input), coordinate = async () => () => {}, journalStorage = cache,
    sessionLost = () => assert.fail("Unexpected owner change") } = {}) => {
    const session = createEconomySession(owner, { get: async () => read(),
      send: async input => { sent.push(structuredClone(input)); return send(input, sent.length); },
      market: async () => assert.fail("Production recovery cannot access market"),
      trade: async () => assert.fail("Production recovery cannot trade") }, sessionLost, legacy, { storage: journalStorage, coordinate });
    return session;
  };
  const saved = () => JSON.parse(cache.getItem(productionJournalKey(owner)));
  return { owner, p, row, cache, legacy, sent, read, command, apply, create, saved };
}

test("a real committed start with a lost ACK replays its frozen envelope after reload before sending the tail", async () => {
  const f = fixture(), answer = deferred(); let committed;
  const first = f.create({ send: input => { committed = f.apply(input); return answer.promise; } });
  const stop = first.activate(); await first.refresh();
  assert.equal(first.act("start_production", "make_planks"), true);
  assert.equal(first.act("start_production", "make_planks"), true);
  assert.equal(f.read().inventory.wood, 3);
  assert.equal(first.getSnapshot().snapshot.inventory.wood, 4, "pending work cannot overwrite confirmed stock");
  assert.equal(first.getSnapshot().productionSnapshot.inventory.wood, 2);
  const frozen = structuredClone(f.saved().entries[0].command), tailId = f.saved().entries[1].requestId;
  assert.deepEqual(frozen, f.sent[0], "the exact envelope is durable before transport");
  stop();

  const restored = f.create(), deactivate = restored.activate(); await restored.refresh();
  assert.deepEqual(f.sent[1], frozen);
  assert.equal(f.sent[2].requestId, tailId);
  assert.equal(f.sent[2].expectedRevision, committed.acceptedRevision);
  assert.equal(f.read().jobs.length, 2); assert.equal(f.read().inventory.wood, 2);
  assert.equal(f.read().inventory.planks, undefined, "starting and reading never mint finished goods");
  assert.equal(f.row.receipts.size, 2); assert.deepEqual(f.saved().entries, []);
  for (const patch of [{ expectedRevision: frozen.expectedRevision + 1 }, { targetId: "grow_berries" }, { quantity: 2 }])
    assert.throws(() => f.apply({ ...frozen, ...patch }), error => error.body?.code === "ECONOMY_REQUEST_CONFLICT");
  const disk = f.cache.getItem(productionJournalKey(f.owner));
  answer.resolve(committed); await flush();
  assert.equal(f.cache.getItem(productionJournalKey(f.owner)), disk, "retired session ACK cannot overwrite the recovered journal");
  assert.equal(restored.getSnapshot().pendingProductionCount, 0); deactivate();
});

test("a persisted catalog v10 queue survives v15 deployment and a lost replay ACK without adopting cached prices or rewards", async () => {
  const f = fixture(), legacy = structuredClone(f.read()), head = f.command("start_production", "make_planks");
  legacy.catalog.version = 10;
  delete legacy.catalog.timeEconomy;
  const oldRecipe = legacy.catalog.recipes.find(recipe => recipe.id === "make_planks");
  oldRecipe.cost.items = {}; oldRecipe.rewards = { planks: 99 }; oldRecipe.seconds = 1;
  const tail = { requestId: crypto.randomUUID(), targetId: "make_planks" };
  const accepted = f.apply(head);
  f.cache.setItem(productionJournalKey(f.owner), JSON.stringify({ version: 1, owner: f.owner, snapshot: legacy,
    entries: [{ requestId: head.requestId, targetId: head.targetId, command: head }, tail] }));
  const dropped = f.create({ send: input => {
    const replay = f.apply(input);
    assert.equal(replay.replayed, true); assert.equal(replay.acceptedRevision, accepted.acceptedRevision);
    throw Error("ACK lost again while the deployed app recovers its old queue");
  } });
  const stop = dropped.activate(); await dropped.refresh();
  assert.deepEqual(f.saved().entries[0].command, head);
  assert.equal(f.saved().entries.length, 2); assert.equal(f.read().jobs.length, 1); stop();
  const restored = f.create(), deactivate = restored.activate();
  try {
    await restored.refresh();
    assert.deepEqual(f.sent.slice(0, 2), [head, head], "the deployed app never rebases the old sent envelope");
    assert.equal(f.sent[2].requestId, tail.requestId);
    assert.equal(f.sent[2].expectedRevision, accepted.acceptedRevision);
    assert.equal(f.read().inventory.wood, 2); assert.equal(f.read().inventory.planks, undefined);
    assert.equal(f.read().jobs.length, 2); assert.equal(f.row.receipts.size, 2);
    for (const job of f.read().jobs) {
      assert.deepEqual(job.cost.items, { wood: 1 }); assert.deepEqual(job.rewards, { planks: 1 });
      assert.equal(Date.parse(job.finishesAt), instant + 120_000);
      assert.equal(job.catalogVersion, 15);
    }
    assert.equal(restored.getSnapshot().snapshot.catalog.version, 15);
    assert.deepEqual(f.saved().entries, []);
  } finally { deactivate(); }
});

test("moving the client wall clock to the future cannot advance server production or claim its reward", async t => {
  const f = fixture(), session = f.create(), stop = session.activate(); await session.refresh();
  try {
    assert.equal(session.act("start_production", "make_planks"), true); await flush();
    const confirmed = session.getSnapshot().snapshot, job = confirmed.jobs[0];
    t.mock.method(Date, "now", () => Date.parse("2099-01-01T00:00:00.000Z"));
    assert.ok(Math.abs(session.now() - instant) < 5000, "the server clock advances with monotonic elapsed time");
    // The local API runs in this process; restore its clock before crossing the server boundary.
    t.mock.restoreAll();
    assert.throws(() => f.apply(f.command("claim_job", job.id)), error => error.body?.code === "ECONOMY_JOB_NOT_READY");
    assert.equal(f.read().inventory.planks, undefined); assert.equal(f.read().jobs.length, 1);
    assert.equal(f.row.receipts.size, 1); assert.equal(f.read().revision, confirmed.revision);
    assert.equal(Date.parse(f.read().jobs[0].finishesAt), instant + 120_000);
  } finally { stop(); t.mock.restoreAll(); }
});

test("a stale sent head is never rebased and remaining intents revalidate against real external spending", async () => {
  const f = fixture(), deliver = deferred();
  const session = f.create({ send: async (input, attempt) => { if (attempt === 1) await deliver.promise; return f.apply(input); } });
  const stop = session.activate(); await session.refresh();
  assert.equal(session.act("start_production", "make_planks"), true);
  assert.equal(session.act("start_production", "make_planks"), true);
  assert.equal(session.act("start_production", "grow_berries"), true);
  const entries = f.saved().entries, frozen = structuredClone(entries[0].command);
  const spent = f.apply(f.command("sell", "wood", 4));
  deliver.resolve(); await flush();
  assert.deepEqual(f.sent[0], frozen); assert.equal(f.sent.length, 2, "unfillable plank tail is not sent");
  assert.equal(f.sent[1].requestId, entries[2].requestId);
  assert.equal(f.sent[1].expectedRevision, spent.acceptedRevision);
  assert.deepEqual(f.read().jobs.map(job => job.recipeId), ["grow_berries"]);
  assert.equal(f.read().inventory.wood, undefined); assert.equal(f.read().inventory.planks, undefined);
  assert.equal(f.row.receipts.has(frozen.requestId), false); assert.equal(session.getSnapshot().pendingProductionCount, 0);
  assert.deepEqual(session.getSnapshot().snapshot.wallet, f.read().wallet); stop();
});

test("a schema-valid forged cached revision clock and wallet cannot outrank an authoritative response", async () => {
  const f = fixture(), real = f.read(), snapshot = structuredClone(real);
  snapshot.revision = 999_999; snapshot.serverTime = "2099-01-01T00:00:00.000Z";
  snapshot.wallet.coins = 9_000_000; snapshot.inventory.wood = 1000;
  f.cache.setItem(productionJournalKey(f.owner), JSON.stringify({ version: 1, owner: f.owner, snapshot,
    entries: [{ requestId: crypto.randomUUID(), targetId: "make_planks" }] }));
  const session = f.create(), stop = session.activate(); await session.refresh();
  const actual = f.read();
  assert.equal(actual.revision, real.revision + 1); assert.deepEqual(actual.wallet, real.wallet);
  assert.deepEqual(actual.inventory, { ...real.inventory, wood: real.inventory.wood - 1 });
  assert.equal(actual.inventory.planks, undefined);
  assert.equal(actual.jobs.length, 1); assert.equal(actual.jobs[0].startedAt, real.serverTime);
  assert.equal(Date.parse(actual.jobs[0].finishesAt), instant + 120_000, "cached time cannot backdate or complete production");
  assert.equal(f.sent[0].expectedRevision, real.revision, "unsent intents use a verified server revision");
  assert.equal(session.getSnapshot().snapshot.revision, actual.revision);
  assert.deepEqual(session.getSnapshot().snapshot.wallet, real.wallet);
  assert.deepEqual(session.getSnapshot().snapshot.inventory, actual.inventory);
  assert.ok(Math.abs(session.now() - instant) < 5000, "the local clock returns to server time");
  assert.deepEqual(f.saved().entries, []); assert.equal(f.row.receipts.size, 1); stop();
});

test("reactivating the same session never promotes a newer local cache to confirmed server state", async () => {
  const f = fixture(), session = f.create(), stop = session.activate(); await session.refresh();
  const real = f.read(); stop();
  const snapshot = structuredClone(real); snapshot.revision = 999_999; snapshot.wallet.coins = 9_000_000;
  f.cache.setItem(productionJournalKey(f.owner), JSON.stringify({ version: 1, owner: f.owner, snapshot, entries: [] }));
  const deactivate = session.activate(); await session.refresh();
  assert.equal(session.getSnapshot().snapshot.revision, real.revision);
  assert.deepEqual(session.getSnapshot().snapshot.wallet, real.wallet);
  assert.deepEqual(f.saved().snapshot.wallet, real.wallet);
  assert.equal(f.sent.length, 0); assert.deepEqual(f.read().jobs, []); deactivate();
});

test("two live sessions sharing an owner journal cannot both accept offline work or erase the first queue", async () => {
  const f = fixture(); let held = false;
  const coordinate = async () => { if (held) return null; held = true; return () => { held = false; }; };
  const first = f.create({ coordinate }), stop = first.activate(); await first.refresh(); first.setAvailable(false);
  assert.equal(first.act("start_production", "make_planks"), true);
  const disk = f.cache.getItem(productionJournalKey(f.owner));
  const second = f.create({ coordinate }), stopSecond = second.activate(); await second.refresh(); second.setAvailable(false);
  assert.equal(second.getSnapshot().productionQueueAvailable, false);
  assert.equal(second.act("start_production", "make_planks"), false);
  assert.equal(f.cache.getItem(productionJournalKey(f.owner)), disk);
  assert.deepEqual(f.read().jobs, []); stopSecond(); stop();
  const next = f.create({ coordinate }), stopNext = next.activate(); await next.refresh();
  assert.equal(f.read().jobs.length, 1); assert.equal(f.read().inventory.wood, 3);
  assert.equal(f.row.receipts.size, 1); stopNext();
});

for (const [reason, browser] of [
  ["missing Web Locks on an insecure LAN origin", {}],
  ["the journal lock belonging to another tab", { locks: { request: async (_name, _options, callback) => callback(null) } }],
]) test(`${reason} disables offline work without reporting a broken connection`, async () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: browser });
  const f = fixture(), session = f.create({ coordinate: browserJournalCoordinator }), stop = session.activate();
  try {
    await session.refresh();
    const view = session.getSnapshot();
    assert.equal(view.snapshotConfirmed, true, "a successful API response remains authoritative");
    assert.equal(view.productionQueueAvailable, false, "no lock means no durable offline ownership");
    for (const field of ["storageError", "syncError", "error"]) assert.equal(view[field], null, `${field} must not keep the WiFi warning visible`);
    assert.equal(view.syncPending, false);
    assert.equal(session.act("start_production", "make_planks"), true, "online production uses the existing direct server path");
    await flush();
    assert.equal(f.sent.length, 1);
    assert.equal(f.read().jobs.length, 1);
    assert.equal(session.getSnapshot().syncPending, false, "the confirmed direct command clears its receipt");
    assert.equal(session.getSnapshot().uncertain, false);
    assert.equal(f.cache.getItem(productionJournalKey(f.owner)), null, "a tab without ownership never writes the shared journal");
    session.setAvailable(false);
    assert.equal(session.act("start_production", "make_planks"), false, "offline work still requires durable ownership");
    assert.equal(f.sent.length, 1);
  } finally {
    stop();
    if (previous) Object.defineProperty(globalThis, "navigator", previous); else delete globalThis.navigator;
  }
});

test("failed durable writes refuse new work and a failed ACK checkpoint recovers the original server receipt", async () => {
  const f = fixture(), rejected = f.create(), stopRejected = rejected.activate(); await rejected.refresh();
  f.cache.failWrites = true;
  assert.equal(rejected.act("start_production", "make_planks"), false);
  assert.equal(f.sent.length, 0); assert.deepEqual(f.read().jobs, []); assert.ok(rejected.getSnapshot().storageError);
  stopRejected(); f.cache.failWrites = false;

  const answer = deferred(); let committed;
  const session = f.create({ send: input => { committed = f.apply(input); return answer.promise; } });
  const stop = session.activate(); await session.refresh();
  assert.equal(session.act("start_production", "make_planks"), true);
  assert.equal(session.act("start_production", "make_planks"), true);
  const frozen = structuredClone(f.saved().entries[0].command);
  f.cache.failWrites = true; answer.resolve(committed); await flush();
  assert.equal(f.read().jobs.length, 1); assert.equal(f.sent.length, 1, "failed ACK persistence stops delivery of the tail");
  assert.ok(session.getSnapshot().storageError); assert.deepEqual(f.saved().entries[0].command, frozen);
  stop(); f.cache.failWrites = false;
  const recovered = f.create(), stopRecovered = recovered.activate(); await recovered.refresh();
  assert.deepEqual(f.sent[1], frozen); assert.equal(f.read().jobs.length, 2);
  assert.equal(f.read().inventory.wood, 2); assert.equal(f.row.receipts.size, 2);
  assert.deepEqual(f.saved().entries, []); stopRecovered();
});

test("a lock granted after session disposal is released without restoring or sending its saved work", async () => {
  const f = fixture(), grant = deferred(); let releases = 0;
  f.cache.setItem(productionJournalKey(f.owner), JSON.stringify({ version: 1, owner: f.owner, snapshot: f.read(),
    entries: [{ requestId: crypto.randomUUID(), targetId: "make_planks" }] }));
  const disk = f.cache.getItem(productionJournalKey(f.owner));
  const session = f.create({ coordinate: () => grant.promise }), stop = session.activate();
  stop(); grant.resolve(() => { releases++; }); await flush();
  assert.equal(releases, 1); assert.equal(f.sent.length, 0);
  assert.equal(session.getSnapshot().snapshot, null); assert.deepEqual(f.read().jobs, []);
  assert.equal(f.cache.getItem(productionJournalKey(f.owner)), disk);
});

test("switching owner isolates durable journals and an old owner's late ACK cannot clear either account's work", async () => {
  const first = fixture(), second = fixture(), answer = deferred(); let committed;
  const session = first.create({ send: input => { committed = first.apply(input); return answer.promise; } });
  const stop = session.activate(); await session.refresh();
  assert.equal(session.act("start_production", "make_planks"), true); stop();
  const originalDisk = first.cache.getItem(productionJournalKey(first.owner));
  const replacement = second.create({ journalStorage: first.cache }), stopReplacement = replacement.activate();
  await replacement.refresh();
  assert.equal(replacement.getSnapshot().snapshot.ownerPublicId, second.owner);
  assert.equal(replacement.getSnapshot().pendingProductionCount, 0);
  assert.equal(second.sent.length, 0, "a new owner cannot restore the previous owner's envelope");
  assert.equal(replacement.act("start_production", "make_planks"), true); await flush();
  const replacementDisk = first.cache.getItem(productionJournalKey(second.owner));
  answer.resolve(committed); await flush();
  assert.equal(first.cache.getItem(productionJournalKey(first.owner)), originalDisk);
  assert.equal(first.cache.getItem(productionJournalKey(second.owner)), replacementDisk);
  assert.equal(replacement.getSnapshot().snapshot.ownerPublicId, second.owner);
  assert.equal(first.read().jobs.length, 1); assert.equal(second.read().jobs.length, 1);
  assert.equal(first.row.receipts.size, 1); assert.equal(second.row.receipts.size, 1); stopReplacement();
});

test("reconciliation may replay saved production while fresh financial writes still await the app's READY gate", async () => {
  const f = fixture(), session = f.create(), stop = session.activate(); await session.refresh();
  session.setDirectActionsAvailable(false); session.setLocalActionsAvailable(true); session.setAvailable(false);
  assert.equal(session.act("start_production", "make_planks"), true); assert.equal(f.sent.length, 0);
  assert.equal(await session.reconcile(), true);
  assert.equal(f.read().jobs.length, 1); assert.equal(f.sent.length, 1);
  assert.equal(session.act("sell", "wood"), false);
  assert.equal(session.actMarket("create_listing", "wood", 1, 40), false);
  assert.equal(f.sent.length, 1, "delivery permission does not grant permission for new financial actions");
  assert.equal(session.act("start_production", "grow_berries"), true); await flush();
  assert.equal(f.read().jobs.length, 2, "explicitly permitted local production uses its separate gate");
  session.setLocalActionsAvailable(false);
  assert.equal(session.act("start_production", "grow_berries"), false);
  assert.equal(f.row.receipts.size, 2); stop();
});
