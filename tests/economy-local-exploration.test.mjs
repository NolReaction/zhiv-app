import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root,
  optimizeDeps: { noDiscovery: true, include: [] }, resolve: { alias: { "@": root } },
  server: { middlewareMode: true, hmr: false, ws: false } });
after(() => vite.close());
const { createEconomySession } = await vite.ssrLoadModule("/features/economy/sync/session.ts");
const { localExplorationFromReceipt } = await vite.ssrLoadModule("/features/economy/domain/local-exploration-receipt.ts");
const { economyCatalog } = await vite.ssrLoadModule("/features/economy/domain/model.ts");
const { ApiError } = await vite.ssrLoadModule("/lib/check-in-api.ts");
const owner = "AAAA-0000-0001", other = "AAAA-0000-0002", timestamp = "2026-10-17T12:00:00.000Z";
const state = (revision = 0, jobs = [], ownerPublicId = owner) => ({ ownerPublicId, revision, serverTime: timestamp,
  wallet: { coins: 1000, pearls: 0 }, inventory: {}, buildings: { home: 1, garden: 1, warehouse: 1 },
  storage: { capacity: 200, used: 0, reserved: 0, available: 200, overflow: 0 }, jobs,
  migration: { version: 1, coinsGranted: 0, woodGranted: 0, stoneGranted: 0 }, catalog: economyCatalog, completedExplorations: 0 });
const job = (patch = {}) => ({ id: "9fce9567-4088-4a2c-bc3d-d07a02687247", kind: "exploration", targetId: "forest",
  recipeId: null, targetLevel: null, startedAt: timestamp, finishesAt: "2026-10-17T12:05:00.000Z",
  rewards: { wood: 1 }, cost: { coins: 0, items: {} }, catalogVersion: 11, actorId: "mochlik", ...patch });
const command = (patch = {}) => ({ requestId: "4539f95c-e98a-4a6e-89bb-d2637ca01182", ownerPublicId: owner,
  expectedRevision: 0, action: "start_exploration", targetId: "forest", quantity: 1, totalPrice: 0, ...patch });
const result = snapshot => ({ state: snapshot, message: "Готово", acceptedRevision: snapshot.revision, replayed: false });
const transport = overrides => ({ get: async () => state(), send: async () => result(state(1, [job()])),
  market: async () => ({ listings: [], mine: [], nextCursor: null, serverTime: timestamp }),
  trade: async () => result(state(1)), ...overrides });
const flush = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const storage = () => { const data = new Map(); return { data, getItem: key => data.get(key) ?? null,
  setItem: (key, value) => data.set(key, value), removeItem: key => data.delete(key) }; };

test("local departure feedback requires one exact accepted new job, matching action, owner and revision", () => {
  const before = state(), valid = result(state(1, [job()])), input = command();
  const receipt = localExplorationFromReceipt(before, valid, input);
  assert.deepEqual(receipt, { id: input.requestId, ownerPublicId: owner, revision: 1, jobId: job().id });
  assert.ok(Object.isFrozen(receipt));
  const invalid = [
    [before, valid, command({ action: "start_production" })],
    [before, valid, command({ ownerPublicId: other })],
    [state(0, [], other), valid, input],
    [before, valid, command({ expectedRevision: 1 })],
    [before, { ...valid, acceptedRevision: 0 }, input],
    [before, { ...valid, state: state(0, [job()]) }, input],
    [before, result(state(1, [job({ targetId: "beach" })])), input],
    [before, result(state(1, [job({ kind: "production" })])), input],
    [before, valid, command({ action: "start_fishing" })],
    [state(0, [job()]), valid, input],
    [before, result(state(1, [job(), job({ id: "another" })])), input],
  ];
  for (const [start, answer, sent] of invalid) assert.equal(localExplorationFromReceipt(start, answer, sent), null);
  assert.ok(localExplorationFromReceipt(before, { ...valid, state: state(3, [job()]) }, input),
    "a replay may carry the current snapshot at a newer revision than its accepted start");
  const fishing = job({ fishing: { rodId: "willow_rod", hookId: "bare_hook", baitId: null, fishId: "fish_perch" } });
  assert.ok(localExplorationFromReceipt(before, result(state(1, [fishing])), command({ action: "start_fishing" })));
  assert.ok(localExplorationFromReceipt(before, result(state(1, [fishing])), input), "legacy exploration commands may legitimately start a fishing route");
});

test("an intentional local departure publishes once after its real answer, while GETs never invent a new start", async () => {
  for (const action of ["start_exploration", "start_fishing"]) {
    const wait = deferred(), sent = [], departure = job(action === "start_fishing"
      ? { fishing: { rodId: "willow_rod", hookId: "bare_hook", baitId: null, fishId: "fish_perch" } } : {});
    let latest = state();
    const session = createEconomySession(owner, transport({ get: async () => latest,
      send: value => { sent.push(value); return wait.promise; } }), assert.fail);
    const stop = session.activate();
    try {
      await session.refresh(); assert.equal(session.act(action, "forest"), true);
      assert.equal(session.getSnapshot().localExploration, undefined);
      latest = state(1, [departure]); wait.resolve(result(latest)); await flush();
      const receipt = session.getSnapshot().localExploration;
      assert.deepEqual(receipt, { id: sent[0].requestId, ownerPublicId: owner, revision: 1, jobId: departure.id });
      latest = state(2, [job({ id: "a-later-trip" })]); await session.refresh(); await session.retry();
      assert.equal(session.getSnapshot().localExploration, receipt, "polling preserves the same event identity");
    } finally { stop(); }
  }
});

test("same-session uncertain retry retains local intent even after a GET has already hydrated the committed trip", async () => {
  const sent = []; let latest = state();
  const session = createEconomySession(owner, transport({ get: async () => latest, send: async value => {
    sent.push(structuredClone(value)); latest = state(1, [job()]);
    if (sent.length === 1) throw Error("response lost after commit");
    return { ...result(latest), replayed: true };
  } }), assert.fail);
  const stop = session.activate();
  try {
    await session.refresh(); session.act("start_exploration", "forest"); await flush();
    assert.equal(session.getSnapshot().uncertain, true); assert.equal(session.getSnapshot().localExploration, undefined);
    await session.refresh(); assert.equal(session.getSnapshot().snapshot.jobs.length, 1);
    assert.equal(session.getSnapshot().localExploration, undefined, "a GET cannot acknowledge the local start");
    await session.retry();
    assert.deepEqual(sent[1], sent[0], "recovery preserves the original request UUID and revision");
    const receipt = session.getSnapshot().localExploration;
    assert.equal(receipt.id, sent[0].requestId);
    assert.equal(receipt.jobId, job().id); assert.equal(session.getSnapshot().uncertain, false);
    await session.retry(); assert.equal(session.getSnapshot().localExploration, receipt);
  } finally { stop(); }
});

test("same-session replay accepts a newer current snapshot but never announces a departure already claimed", async () => {
  for (const claimed of [false, true]) {
    const sent = []; let latest = state();
    const session = createEconomySession(owner, transport({ get: async () => latest, send: async value => {
      sent.push(structuredClone(value));
      if (sent.length === 1) { latest = state(1, [job()]); throw Error("lost reply"); }
      return { ...result(latest), acceptedRevision: 1, replayed: true };
    } }), assert.fail);
    const stop = session.activate();
    try {
      await session.refresh(); session.act("start_exploration", "forest"); await flush();
      latest = state(3, claimed ? [] : [job()]); await session.refresh(); await session.retry();
      assert.equal(session.getSnapshot().uncertain, false);
      if (claimed) assert.equal(session.getSnapshot().localExploration, undefined);
      else assert.deepEqual(session.getSnapshot().localExploration,
        { id: sent[0].requestId, ownerPublicId: owner, revision: 1, jobId: job().id });
    } finally { stop(); }
  }
});

test("recreated pending recovery never pretends to be a new intentional start, even before hydration", async () => {
  for (const hydrate of [false, true]) {
    const cache = storage(), sent = []; let latest = state();
    const api = transport({ get: async () => latest, send: async value => {
      sent.push(structuredClone(value)); latest = state(1, [job()]);
      if (sent.length === 1) throw Error("lost reply");
      return { ...result(latest), replayed: true };
    } });
    const first = createEconomySession(owner, api, assert.fail, cache), stop = first.activate();
    await first.refresh(); first.act("start_exploration", "forest"); await flush(); stop();
    assert.equal(cache.data.size, 1); assert.doesNotMatch([...cache.data.values()][0], /localExploration|before/);
    const restored = createEconomySession(owner, api, assert.fail, cache), release = restored.activate();
    try {
      if (hydrate) await restored.refresh();
      await restored.retry();
      assert.deepEqual(sent[1], sent[0]); assert.equal(restored.getSnapshot().uncertain, false);
      assert.equal(restored.getSnapshot().localExploration, undefined);
    } finally { release(); }
  }
});

test("existing GET jobs, unrelated accepted commands and definitive start refusals create no departure feedback", async () => {
  for (const scenario of ["get", "market", "dev", "unrelated", "denied", "mismatch", "foreign"]) {
    const session = createEconomySession(owner, transport({
      get: async () => scenario === "get" ? state(1, [job()]) : state(),
      send: async () => {
        if (scenario === "denied") throw new ApiError("Нельзя отправиться", 409);
        return result(state(1, [job({ targetId: scenario === "mismatch" ? "beach" : "forest" })], scenario === "foreign" ? other : owner));
      }, trade: async () => result(state(1, [job()])), dev: async () => result(state(1, [job()])),
    }), () => {});
    const stop = session.activate();
    try {
      await session.refresh();
      if (scenario === "market") session.actMarket("create_listing", "wood", 1, 2);
      else if (scenario === "dev") session.actDev("grant_currency", "coins", 1);
      else if (scenario !== "get") session.act(scenario === "unrelated" ? "start_production" : "start_exploration", "forest");
      await flush(); assert.equal(session.getSnapshot().localExploration, undefined, scenario);
    } finally { stop(); }
  }
});
