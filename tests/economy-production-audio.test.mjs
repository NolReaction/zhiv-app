import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root,
  resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false } });
after(() => vite.close());
const { createEconomyAudioFeedbackTracker } = await vite.ssrLoadModule("/features/economy/integration/audio-feedback.ts");
const { createEconomySession } = await vite.ssrLoadModule("/features/economy/sync/session.ts");
const { productionProjection } = await vite.ssrLoadModule("/features/economy/sync/production-journal.ts");
const { economyCatalog, economyViewSchema } = await vite.ssrLoadModule("/features/economy/domain/model.ts");
const owner = "AAAA-0000-0001", time = "2026-10-16T12:00:00.000Z";
const flush = () => new Promise(resolve => setImmediate(resolve));
const state = () => economyViewSchema.parse({ ownerPublicId: owner, revision: 8, serverTime: time,
  wallet: { coins: 1000, pearls: 0 }, inventory: { wood: 6, berries: 6 },
  buildings: { home: 5, garden: 3, woodlot: 3, workshop: 3, warehouse: 1, dryer: 3, kiln: 3 },
  storage: { capacity: 50, used: 12, reserved: 0, available: 38, overflow: 0 }, jobs: [],
  migration: { version: 1, coinsGranted: 0, woodGranted: 0, stoneGranted: 0 }, completedExplorations: 0, catalog: economyCatalog });
const result = snapshot => ({ state: snapshot, message: "Производство запущено", acceptedRevision: snapshot.revision, replayed: false });
const storage = () => {
  const cache = new Map();
  return { getItem: key => cache.get(key) ?? null, setItem: (key, value) => cache.set(key, value), removeItem: key => cache.delete(key) };
};
const journal = cache => ({ storage: cache, coordinate: async () => () => {} });
const feedback = (revision, patch = {}) => ({ snapshot: { ownerPublicId: owner, revision }, busy: false, uncertain: false,
  error: null, notice: "", inventoryGains: [], completedConstructions: [], ...patch });
const inputReceipt = id => ({ id, ownerPublicId: owner, occurredAt: 1000 });

test("a coalesced production input sounds once without needing a busy edge or an invented server revision", () => {
  const tracker = createEconomyAudioFeedbackTracker(); tracker.update(feedback(8));
  const productionStarts = [inputReceipt("new-intent")];
  const events = tracker.update(feedback(8, { productionStarts, notice: "Сохранено на устройстве" }), true, 1001);
  assert.deepEqual(events, [{ id: `economy:${owner}:production-start:new-intent`, cueId: "ui.click", occurredAt: 1000, maxAgeMs: 180 }]);
  assert.deepEqual(tracker.update(feedback(8, { productionStarts })), []);
  assert.deepEqual(tracker.update(feedback(9, { productionStarts, notice: "Производство запущено" })), []);
  assert.deepEqual(tracker.update(feedback(10, { productionStarts, notice: "Состояние обновлено" })), []);
});

test("hydration, owner changes, disabled and interrupted busy intervals cannot replay input cues", () => {
  const productionStarts = [inputReceipt("old")];
  const tracker = createEconomyAudioFeedbackTracker();
  assert.deepEqual(tracker.update(feedback(8, { productionStarts })), []);
  assert.deepEqual(tracker.update(feedback(9, { productionStarts })), []);
  tracker.update(feedback(9, { productionStarts: [inputReceipt("muted")] }), false);
  assert.deepEqual(tracker.update(feedback(9, { productionStarts: [inputReceipt("muted")] })), []);
  tracker.update(feedback(9, { busy: true }), false);
  assert.deepEqual(tracker.update(feedback(9, { busy: true, productionStarts: [inputReceipt("hidden")] })), []);
  assert.deepEqual(tracker.update(feedback(10, { productionStarts: [inputReceipt("hidden")], notice: "Готово" })), []);
  assert.deepEqual(tracker.update(feedback(10, { productionStarts: [{ ...inputReceipt("foreign"), ownerPublicId: "AAAA-0000-0002" }] })), []);
  assert.deepEqual(tracker.update(feedback(10, { snapshot: { ownerPublicId: "AAAA-0000-0002", revision: 10 },
    productionStarts: [{ ...inputReceipt("other-profile"), ownerPublicId: "AAAA-0000-0002" }] })), []);
  assert.deepEqual(tracker.update(feedback(10, { productionStarts: [inputReceipt("old")] })), []);
});

test("each safe one-tap station starts with one quiet input cue; an ACK, refresh and retry add no sound", async () => {
  const recipes = ["grow_berries", "make_planks", "cook_compote"];
  for (const recipeId of recipes) {
    let latest = state(), finish, sent;
    const tracker = createEconomyAudioFeedbackTracker(), events = [];
    const session = createEconomySession(owner, { get: async () => latest,
      send: command => { sent = command; return new Promise(resolve => { finish = resolve; }); } }, () => assert.fail(), undefined, journal(storage()));
    const unsubscribe = session.subscribe(() => events.push(...tracker.update(session.getSnapshot()))), stop = session.activate();
    try {
      await session.refresh();
      assert.equal(session.act("start_production", recipeId), true);
      assert.equal(session.getSnapshot().busy, false, "queue entry must not block the screen");
      assert.equal(session.getSnapshot().pendingProductionCount, 1);
      assert.equal(session.getSnapshot().snapshot.revision, 8, "local input is not a confirmed success");
      assert.deepEqual(session.getSnapshot().snapshot.jobs, []);
      assert.deepEqual(session.getSnapshot().inventoryGains, []);
      assert.deepEqual(events.map(event => event.cueId), ["ui.click"]);
      assert.equal(session.act("start_production", recipeId), false, "the occupied slot rejects another tap");
      assert.equal(events.length, 1);
      latest = { ...productionProjection(latest, [{ requestId: sent.requestId, targetId: recipeId }]), revision: 9 };
      finish(result(latest)); await flush();
      assert.equal(session.getSnapshot().pendingProductionCount, 0);
      assert.deepEqual(events.map(event => event.cueId), ["ui.click"]);
      await session.refresh(); await session.retry();
      assert.equal(events.length, 1);
    } finally { stop(); unsubscribe(); }
  }
});

test("the direct fallback also sounds once at local input, and cancellation remains a separate confirmed action", async () => {
  let latest = state(), finish;
  const tracker = createEconomyAudioFeedbackTracker(), events = [];
  const session = createEconomySession(owner, { get: async () => latest,
    send: () => new Promise(resolve => { finish = resolve; }) }, () => assert.fail());
  const unsubscribe = session.subscribe(() => events.push(...tracker.update(session.getSnapshot()))), stop = session.activate();
  try {
    await session.refresh(); assert.equal(session.act("start_production", "make_planks"), true);
    assert.equal(session.getSnapshot().busy, true);
    assert.deepEqual(events.map(event => event.cueId), ["ui.click"]);
    latest = { ...latest, revision: 9 }; finish(result(latest)); await flush();
    assert.deepEqual(events.map(event => event.cueId), ["ui.click"], "server acceptance must not repeat the input cue with ui.confirm");
    session.act("cancel_production", "job"); latest = { ...latest, revision: 10 }; finish(result(latest)); await flush();
    assert.deepEqual(events.map(event => event.cueId), ["ui.click", "ui.confirm"]);
    assert.equal(session.getSnapshot().productionStarts.length, 1, "cancelling is never another production start");
  } finally { stop(); unsubscribe(); }
});

test("a chosen fish recipe uses the same single input cue through the direct transport", async () => {
  let latest = state(), finish, sent;
  latest.inventory.fish_common = 1;
  latest.fishing.stock = { fish: 1 };
  const selection = { fish: 1 }, tracker = createEconomyAudioFeedbackTracker(), events = [];
  const session = createEconomySession(owner, { get: async () => latest,
    send: command => { sent = command; return new Promise(resolve => { finish = resolve; }); } }, () => assert.fail(), undefined, journal(storage()));
  const unsubscribe = session.subscribe(() => events.push(...tracker.update(session.getSnapshot()))), stop = session.activate();
  try {
    await session.refresh(); assert.equal(session.act("start_production", "cook_grilled_fish", 1, 0, selection), true);
    assert.equal(session.getSnapshot().busy, true);
    assert.equal(session.getSnapshot().pendingProductionCount, 0, "fish selection cannot enter the generic durable queue");
    assert.deepEqual(sent.fishSelection, selection);
    assert.notEqual(sent.fishSelection, selection, "transport keeps its own selection copy");
    assert.deepEqual(events.map(event => event.cueId), ["ui.click"]);
    latest = { ...latest, revision: 9 }; finish(result(latest)); await flush();
    assert.deepEqual(events.map(event => event.cueId), ["ui.click"]);
    await session.retry(); assert.equal(events.length, 1);
  } finally { stop(); unsubscribe(); }
});

test("network loss and exact replay deliver the saved intent without a second start sound", async () => {
  let latest = state(), sends = 0, firstId;
  const tracker = createEconomyAudioFeedbackTracker(), events = [];
  const session = createEconomySession(owner, { get: async () => latest, send: async command => {
    if (++sends === 1) { firstId = command.requestId; throw new Error("Lost reply"); }
    assert.equal(command.requestId, firstId);
    latest = { ...latest, revision: 9 }; return { ...result(latest), replayed: true };
  } }, () => assert.fail(), undefined, journal(storage()));
  const unsubscribe = session.subscribe(() => events.push(...tracker.update(session.getSnapshot()))), stop = session.activate();
  try {
    await session.refresh(); assert.equal(session.act("start_production", "make_planks"), true); await flush();
    assert.equal(session.getSnapshot().pendingProductionCount, 1);
    assert.deepEqual(events.map(event => event.cueId), ["ui.click"]);
    session.setAvailable(false); session.setAvailable(true); await session.retry();
    assert.equal(sends, 2); assert.equal(session.getSnapshot().pendingProductionCount, 0);
    assert.deepEqual(events.map(event => event.cueId), ["ui.click"]);
  } finally { stop(); unsubscribe(); }
});

test("a restored offline journal never reconstructs local input receipts or sounds during delivery", async () => {
  const cache = storage(), base = state();
  const first = createEconomySession(owner, { get: async () => base, send: async () => assert.fail() }, () => assert.fail(), undefined, journal(cache));
  const stopFirst = first.activate(); await first.refresh(); first.setAvailable(false);
  assert.equal(first.act("start_production", "make_planks"), true); stopFirst();
  assert.equal(cache.getItem(`zhiv:economy:production:v1:${owner}`).includes("productionStarts"), false);
  const tracker = createEconomyAudioFeedbackTracker(), events = [];
  const restored = createEconomySession(owner, { get: async () => base, send: async () => result({ ...base, revision: 9 }) }, () => assert.fail(), undefined, journal(cache));
  const unsubscribe = restored.subscribe(() => events.push(...tracker.update(restored.getSnapshot()))), stop = restored.activate();
  try {
    await restored.refresh();
    assert.equal(restored.getSnapshot().pendingProductionCount, 0);
    assert.equal(restored.getSnapshot().productionStarts, undefined);
    assert.deepEqual(events, []);
  } finally { stop(); unsubscribe(); }
});

test("an older four-order catalog restores its exact sent head and unsent tail without replaying input audio", async () => {
  const cache = storage(), old = state(), live = state();
  old.catalog = structuredClone(old.catalog);
  old.catalog.version = 10;
  const teaching = { ...old.catalog.onboarding.residentOrder, items: { berries: 2 }, coins: 30 };
  old.catalog.onboarding.residentOrder = teaching;
  old.catalog.onboarding.residentOrders = [teaching,
    { id: "tutorial_wood_order", residentId: "builder", name: "Древесина", items: { wood: 2 }, coins: 90 },
    { id: "tutorial_compote_order", residentId: "plesk", name: "Компот", items: { berry_compote: 2 }, coins: 90 },
    { id: "tutorial_planks_order", residentId: "builder", name: "Доски", items: { planks: 2 }, coins: 120 }];
  old.catalog.stageOrders = old.catalog.stageOrders.filter(course => course.homeLevel !== 1);
  old.tutorialOrder = { version: 2, step: 0, ingredientsClaimed: true, completed: false, terms: teaching };
  const headId = crypto.randomUUID(), tailId = crypto.randomUUID();
  const command = { requestId: headId, ownerPublicId: owner, expectedRevision: old.revision,
    action: "start_production", targetId: "make_planks", quantity: 1, totalPrice: 0 };
  cache.setItem(`zhiv:economy:production:v1:${owner}`, JSON.stringify({ version: 1, owner, snapshot: old,
    entries: [{ requestId: headId, targetId: "make_planks", command }, { requestId: tailId, targetId: "grow_berries" }] }));
  const tracker = createEconomyAudioFeedbackTracker(), events = [], sends = [], replies = [];
  const session = createEconomySession(owner, { get: async () => assert.fail("the sent head must be reconciled before a read"),
    send: value => { sends.push(value); return new Promise(resolve => replies.push(resolve)); } }, () => assert.fail(), undefined, journal(cache));
  const unsubscribe = session.subscribe(() => events.push(...tracker.update(session.getSnapshot()))), stop = session.activate();
  try {
    await flush();
    assert.equal(session.getSnapshot().pendingProductionCount, 2, "a schema update cannot discard a saved queue");
    assert.deepEqual(session.getSnapshot().pendingProductionIds, [headId, tailId]);
    assert.equal(session.getSnapshot().snapshotConfirmed, false);
    const delivery = session.refresh(); await flush();
    assert.deepEqual(sends, [command], "the uncertain head retains the exact original idempotency key and revision");
    assert.deepEqual(events, []);
    const acceptedHead = { ...productionProjection(live, [{ requestId: headId, targetId: "make_planks" }]), revision: 9 };
    replies[0]({ ...result(acceptedHead), replayed: true }); await flush();
    assert.equal(session.getSnapshot().pendingProductionCount, 1);
    assert.deepEqual(sends[1], { ...command, requestId: tailId, expectedRevision: 9, targetId: "grow_berries" });
    const acceptedTail = { ...productionProjection(acceptedHead, [{ requestId: tailId, targetId: "grow_berries" }]), revision: 10 };
    replies[1](result(acceptedTail)); await delivery;
    assert.equal(session.getSnapshot().pendingProductionCount, 0);
    assert.equal(session.getSnapshot().productionStarts, undefined);
    assert.deepEqual(events, [], "loading and delivering pre-update intents is never another user click");
  } finally { stop(); unsubscribe(); }
});

test("a failed durable save has no production input receipt and cannot sound as accepted", async () => {
  const cache = storage();
  const tracker = createEconomyAudioFeedbackTracker(), events = [];
  const session = createEconomySession(owner, { get: async () => state(), send: async () => assert.fail() }, () => assert.fail(), undefined, journal(cache));
  const unsubscribe = session.subscribe(() => events.push(...tracker.update(session.getSnapshot()))), stop = session.activate();
  try {
    await session.refresh(); cache.setItem = () => { throw new Error("Disk full"); };
    assert.equal(session.act("start_production", "make_planks"), false);
    assert.equal(session.getSnapshot().pendingProductionCount, 0);
    assert.equal(session.getSnapshot().productionStarts, undefined);
    assert.deepEqual(events, []);
  } finally { stop(); unsubscribe(); }
});
