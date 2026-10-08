import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root,
  resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false } });
after(() => vite.close());
const { createEconomyAudioFeedbackTracker, ECONOMY_AUDIO_RECEIPT_LIMIT } = await vite.ssrLoadModule("/features/economy/integration/audio-feedback.ts");
const { createEconomySession } = await vite.ssrLoadModule("/features/economy/sync/session.ts");
const { economyCatalog } = await vite.ssrLoadModule("/features/economy/domain/model.ts");
const { ApiError } = await vite.ssrLoadModule("/lib/check-in-api.ts");
const owner = "AAAA-0000-0001", other = "AAAA-0000-0002";
const flush = () => new Promise(resolve => setImmediate(resolve));
const receipt = (id, revision, ownerPublicId = owner) => ({ id, revision, ownerPublicId,
  source: "claim", items: [{ itemId: "fish", quantity: 1 }] });
const view = (revision = 0, patch = {}) => ({ snapshot: { ownerPublicId: owner, revision },
  busy: false, uncertain: false, notice: "", error: null, inventoryGains: [], completedConstructions: [], ...patch });
const job = (kind = "exploration") => ({ id: crypto.randomUUID(), kind, targetId: kind === "construction" ? "home" : "shore",
  targetLevel: kind === "construction" ? 2 : null, recipeId: null,
  startedAt: "2026-10-08T00:00:00.000Z", finishesAt: "2026-10-08T00:01:00.000Z",
  rewards: kind === "construction" ? {} : { fish: 1 }, cost: { coins: 0, items: {} }, catalogVersion: 2 });
const state = (revision = 0, jobs = [], inventory = {}, buildings = { home: 1 }) => ({ ownerPublicId: owner, revision,
  serverTime: "2026-10-08T00:05:00.000Z", wallet: { coins: 100, pearls: 0 }, inventory, jobs, buildings,
  completedExplorations: 0, storage: { capacity: 100, used: 0, reserved: 0, available: 100, overflow: 0 },
  migration: { version: 1, coinsGranted: 0, woodGranted: 0, stoneGranted: 0 }, catalog: economyCatalog });
const result = snapshot => ({ state: snapshot, message: "Готово", acceptedRevision: snapshot.revision, replayed: false });

test("mount, hydration, polling and stale notices are silent", () => {
  const tracker = createEconomyAudioFeedbackTracker();
  assert.deepEqual(tracker.update(view(0, { snapshot: null })), []);
  assert.deepEqual(tracker.update(view(2, { inventoryGains: [receipt("restored", 2)], notice: "Получено" })), []);
  assert.deepEqual(tracker.update(view(3, { inventoryGains: [receipt("restored", 2)], notice: "Получено" })), []);
  assert.deepEqual(tracker.update(view(4, { notice: "Успешно" })), []);
  assert.deepEqual(tracker.update(view(4, { error: "Нет связи" })), []);
});

test("all command publishes produce one reward, never an early confirmation", () => {
  const tracker = createEconomyAudioFeedbackTracker();
  tracker.update(view(4));
  for (const next of [view(4, { busy: true }), view(5, { busy: true }),
    view(5, { busy: true, notice: "Получено", inventoryGains: [receipt("claim", 5)] })]) {
    assert.deepEqual(tracker.update(next, true, 100), []);
  }
  const final = view(5, { notice: "Получено", inventoryGains: [receipt("claim", 5)] });
  const events = tracker.update(final, true, 101);
  assert.equal(events.length, 1); assert.equal(events[0].cueId, "ui.reward"); assert.equal(events[0].occurredAt, 101);
  assert.deepEqual(tracker.update(final), []);
  assert.deepEqual(tracker.update(view(6, { ...final, snapshot: { ownerPublicId: owner, revision: 6 } })), []);
});

test("fast coalesced requests require a fresh explicit receipt", () => {
  const tracker = createEconomyAudioFeedbackTracker(); tracker.update(view(8));
  assert.equal(tracker.update(view(9, { inventoryGains: [receipt("fast", 9)], notice: "Получено" }))[0].cueId, "ui.reward");
  assert.deepEqual(tracker.update(view(9, { inventoryGains: [receipt("different-id-same-revision", 9)] })), []);
  assert.deepEqual(tracker.update(view(10, { notice: "Продано" })), []);
  assert.deepEqual(tracker.update(view(11, { inventoryGains: [receipt("other-owner", 11, other)] })), []);
});

test("generic confirmation requires a clean observed local busy cycle and newer revision", () => {
  const tracker = createEconomyAudioFeedbackTracker(); tracker.update(view(0));
  tracker.update(view(0, { busy: true }));
  tracker.update(view(1, { busy: true, notice: "Работа началась" }));
  assert.equal(tracker.update(view(1, { notice: "Работа началась" }))[0].cueId, "ui.confirm");
  tracker.update(view(1, { busy: true }));
  assert.deepEqual(tracker.update(view(1, { notice: "Восстановленный ответ" })), []);
  tracker.update(view(1, { busy: true }));
  assert.equal(tracker.update(view(1, { error: "Недостаточно монет" }))[0].cueId, "ui.error");
  assert.deepEqual(tracker.update(view(1, { error: "Недостаточно монет" })), []);
});

test("uncertain outcomes and their reconnect recovery stay silent; a later local command works", () => {
  const tracker = createEconomyAudioFeedbackTracker(); tracker.update(view(0));
  tracker.update(view(0, { busy: true }));
  assert.deepEqual(tracker.update(view(0, { busy: true, uncertain: true, error: "Ответ потерялся" })), []);
  assert.deepEqual(tracker.update(view(0, { uncertain: true, error: "Ответ потерялся" })), []);
  tracker.update(view(0, { busy: true, uncertain: true }));
  tracker.update(view(1, { busy: true, inventoryGains: [receipt("retried", 1)], notice: "Получено" }));
  assert.deepEqual(tracker.update(view(1, { inventoryGains: [receipt("retried", 1)], notice: "Получено" })), []);
  tracker.update(view(1, { busy: true }));
  assert.equal(tracker.update(view(2, { notice: "Новая работа" }))[0].cueId, "ui.confirm");
  const restored = createEconomyAudioFeedbackTracker(); restored.update(view(2, { uncertain: true }));
  assert.deepEqual(restored.update(view(3, { inventoryGains: [receipt("restored", 3)] })), []);
});

test("account change, interrupted mount and disabled intervals cannot catch up sounds", () => {
  const tracker = createEconomyAudioFeedbackTracker(); tracker.update(view(0)); tracker.update(view(0, { busy: true }));
  assert.deepEqual(tracker.update(view(7, { snapshot: { ownerPublicId: other, revision: 7 }, inventoryGains: [receipt("foreign", 7, other)] })), []);
  tracker.update(view(0, { snapshot: null }));
  tracker.update(view(4, { busy: true }));
  assert.deepEqual(tracker.update(view(5, { inventoryGains: [receipt("mounted-mid-request", 5)] })), []);
  tracker.update(view(5, { busy: true }), false);
  assert.deepEqual(tracker.update(view(6, { inventoryGains: [receipt("disabled-request", 6)] })), []);
  tracker.update(view(7, { inventoryGains: [receipt("disabled-result", 7)] }), false);
  assert.deepEqual(tracker.update(view(7, { inventoryGains: [receipt("disabled-result", 7)] })), []);
});

test("bounded receipt retention also rejects old revisions after eviction", () => {
  const tracker = createEconomyAudioFeedbackTracker(); tracker.update(view(0));
  for (let revision = 1; revision <= ECONOMY_AUDIO_RECEIPT_LIMIT + 8; revision++) {
    const events = tracker.update(view(revision, { inventoryGains: [receipt(`receipt-${revision}`, revision)] }));
    assert.equal(events.length, 1); assert.equal(events[0].cueId, "ui.reward");
  }
  assert.deepEqual(tracker.update(view(ECONOMY_AUDIO_RECEIPT_LIMIT + 9, { inventoryGains: [receipt("receipt-1", 1)] })), []);
});

test("real session claim and construction publish order each produce exactly one reward", async () => {
  for (const kind of ["exploration", "construction"]) {
    const pending = job(kind); let latest = state(0, [pending]), finish;
    const tracker = createEconomyAudioFeedbackTracker(), events = [];
    const session = createEconomySession(owner, { get: async () => latest,
      send: () => new Promise(resolve => { finish = resolve; }) }, () => assert.fail());
    const unsubscribe = session.subscribe(() => events.push(...tracker.update(session.getSnapshot())));
    const stop = session.activate();
    try {
      await session.refresh(); session.act("claim_job", pending.id); assert.deepEqual(events, []);
      latest = state(1, [], kind === "exploration" ? { fish: 1 } : {}, kind === "construction" ? { home: 2 } : { home: 1 });
      finish(result(latest)); await flush();
      assert.deepEqual(events.map(event => event.cueId), ["ui.reward"]);
      await session.refresh(); await session.retry();
      assert.equal(events.length, 1);
    } finally { stop(); unsubscribe(); }
  }
});

test("real session definitive failure has one error; timeout and reads do not", async () => {
  for (const failure of [new ApiError("Недостаточно ресурсов", 409), new Error("Lost reply")]) {
    const tracker = createEconomyAudioFeedbackTracker(), events = [];
    const session = createEconomySession(owner, { get: async () => state(), send: async () => { throw failure; } }, () => assert.fail());
    const unsubscribe = session.subscribe(() => events.push(...tracker.update(session.getSnapshot())));
    const stop = session.activate();
    try {
      await session.refresh(); session.act("start_production", "planks"); await flush();
      assert.deepEqual(events.map(event => event.cueId), failure instanceof ApiError ? ["ui.error"] : []);
      await session.refresh(); assert.equal(events.length, failure instanceof ApiError ? 1 : 0);
    } finally { stop(); unsubscribe(); }
  }
});
