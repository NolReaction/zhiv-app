import assert from "node:assert/strict";
import test, { after, beforeEach } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false } });
const identities = await vite.ssrLoadModule("/lib/dev/api-store.ts");
const economy = await vite.ssrLoadModule("/lib/dev/economy-store.ts");
const model = await vite.ssrLoadModule("/features/economy/domain/model.ts");
const stages = await vite.ssrLoadModule("/features/economy/domain/stage-orders.ts");
const food = await vite.ssrLoadModule("/features/economy/domain/food.ts");
const now = Date.parse("2026-10-14T09:00:00Z");
beforeEach(() => { identities.resetDevStoreForTests(); economy.resetDevEconomyStoreForTests(); });
after(() => vite.close());
const read = (p, minutes = 0) => economy.getDevEconomy(p.token, now + minutes * 60000);
const row = p => globalThis.__zhivDevEconomyStore.profiles.get(p.me.user.publicId);
const player = (home = 2, version = 2) => {
  const p = identities.createDevIdentity("Заказы второго этапа", crypto.randomUUID()); read(p);
  Object.assign(row(p).state.buildings, { home, woodlot: 1, workshop: 1, dryer: 1, quarry: 2, kiln: 1, warehouse: 1 });
  row(p).state.tutorialOrder = { version, step: version === 2 ? 4 : 0, completed: true, ingredientsClaimed: true, terms: null };
  row(p).state.wallet = { coins: 50, pearls: 0 }; row(p).state.inventory = {};
  return p;
};
const quote = p => stages.stageResidentOrder(read(p));
const request = (p, action = "complete_resident_order", targetId = quote(p)?.id ?? "stage2_rope_order", extra = {}) => ({
  requestId: crypto.randomUUID(), ownerPublicId: p.me.user.publicId, expectedRevision: read(p).revision, action, targetId, quantity: 1, totalPrice: 0, ...extra,
});
const send = (p, action = "complete_resident_order", targetId, extra = {}, minutes = 0) => economy.commandDevEconomy(p.token, request(p, action, targetId, extra), now + minutes * 60000);

test("new stage quotes and failed commands do not persist a course, alter revision or grant ingredients", () => {
  const p = player(), stored = structuredClone(row(p).state), before = read(p);
  assert.equal(quote(p).id, "stage2_rope_order"); assert.deepEqual(quote(p).items, { rope: 2 }); assert.equal(quote(p).coins, 90);
  assert.deepEqual(row(p).state, stored); assert.deepEqual(read(p), before);
  assert.throws(() => send(p), { code: "ECONOMY_RESOURCES" });
  assert.throws(() => send(p, "replace_resident_order"), { code: "ECONOMY_STAGE_ORDER_UNAVAILABLE" });
  assert.throws(() => send(p, "complete_resident_order", "stage2_bricks_order"), { code: "ECONOMY_STAGE_ORDER_UNAVAILABLE" });
  assert.deepEqual(row(p).state, stored); assert.deepEqual(read(p), before);
  const after = send(p, "start_production", "gather_fiber").state;
  assert.deepEqual(row(p).state.stageOrders.stages["2"].terms.items, { rope: 2 });
  assert.deepEqual(after.wallet, before.wallet); assert.deepEqual(after.inventory, before.inventory);
});

test("claiming house two pins the first permanent request without minting its supplies", () => {
  const p = player(1), state = row(p).state;
  state.wallet.coins = 250; state.inventory = { wood: 3, stone: 2, planks: 2 };
  assert.equal(quote(p), null);
  const started = send(p, "start_construction", "home").state, job = started.jobs[0];
  assert.equal(started.stageOrders.stages["2"], undefined);
  const claimed = send(p, "claim_job", job.id, {}, 10).state;
  assert.equal(claimed.buildings.home, 2); assert.deepEqual(claimed.stageOrders.stages["2"].terms.items, { rope: 2 });
  assert.deepEqual(claimed.inventory, {}); assert.equal(claimed.wallet.coins, 0);
});

test("five frozen course requests settle sequentially without rerolling the ordinary board or replaying goods and rewards", () => {
  const p = player(), expected = [[{ rope: 2 }, 90], [{ stone: 6 }, 360], [{ clay: 4 }, 180], [{ charcoal: 2 }, 150], [{ bricks: 4 }, 600]], receipts = [];
  const board = food.residentOrderBoard(read(p), now).offers; let paid = 0;
  for (const [step, [items, coins]] of expected.entries()) {
    const offer = quote(p); assert.deepEqual(offer.items, items); assert.equal(offer.coins, coins);
    row(p).state.inventory = { ...items };
    const cmd = request(p), result = economy.commandDevEconomy(p.token, cmd, now); receipts.push([cmd, result.acceptedRevision]); paid += coins;
    assert.equal(result.state.stageOrders.stages["2"].step, step + 1); assert.equal(result.state.stageOrders.stages["2"].completed, step === 4);
    assert.deepEqual(result.state.inventory, {}); assert.equal(result.state.wallet.coins, 50 + paid);
    assert.deepEqual(food.residentOrderBoard(result.state, now).offers, board);
    assert.throws(() => send(p, "complete_resident_order", offer.id), { code: "ECONOMY_STAGE_ORDER_UNAVAILABLE" });
  }
  const latest = read(p); assert.equal(paid, 1380); assert.equal(quote(p), null);
  for (const [cmd, revision] of receipts) {
    const replay = economy.commandDevEconomy(p.token, cmd, now);
    assert.equal(replay.replayed, true); assert.equal(replay.acceptedRevision, revision); assert.deepEqual(replay.state, latest);
  }
  assert.throws(() => send(p, "complete_resident_order", "stage2_bricks_order", { quantity: 2 }), { code: "INVALID_ECONOMY_COMMAND" });
});

test("accepted terms survive JSON persistence and later catalog changes without a new price or ingredient grant", () => {
  const p = player(); send(p, "start_production", "gather_fiber");
  row(p).state = JSON.parse(JSON.stringify(row(p).state)); row(p).state.inventory = { rope: 2 };
  const preview = read(p); preview.catalog.stageOrders[0].orders[0].coins = 999; preview.catalog.stageOrders[0].orders[0].items = { wood: 50 };
  assert.deepEqual(stages.stageResidentOrder(preview).items, { rope: 2 }); assert.equal(stages.stageResidentOrder(preview).coins, 90);
  const result = send(p, "complete_resident_order", "stage2_rope_order", {}, 30 * 1440).state;
  assert.equal(result.wallet.coins, 140); assert.deepEqual(result.inventory, {}); assert.equal(result.stageOrders.stages["2"].step, 1);
});

test("home three requires the new course but unfinished legacy v1 and already developed settlements remain compatible", () => {
  const cost = model.economyCatalog.buildings.find(building => building.id === "home").levels[2].cost;
  for (const version of [1, 2]) {
    const p = player(2, version); row(p).state.wallet.coins = cost.coins; row(p).state.inventory = { ...cost.items };
    const before = read(p);
    if (version === 2) { assert.throws(() => send(p, "start_construction", "home"), { code: "ECONOMY_STAGE_REQUIRED" }); assert.deepEqual(read(p), before); }
    else { row(p).state.tutorialOrder.completed = false; assert.equal(send(p, "start_construction", "home").state.jobs[0].targetLevel, 3); }
  }
  const p = player(3); assert.equal(quote(p), null); assert.equal(read(p).stageOrders.stages["2"], undefined);
  assert.equal(stages.stageCourseRequired(read(p), 4), false);
});

test("course receipts keep owner and revision fences and overflowing wallets cannot consume pending goods", () => {
  const p = player(), other = player(); row(p).state.inventory = { rope: 2 }; const cmd = request(p);
  assert.throws(() => economy.commandDevEconomy(other.token, cmd, now), { code: "ECONOMY_OWNER_CHANGED" });
  const result = economy.commandDevEconomy(p.token, cmd, now);
  assert.throws(() => economy.commandDevEconomy(p.token, { ...cmd, requestId: crypto.randomUUID() }, now), { code: "ECONOMY_REVISION_CONFLICT" });
  assert.throws(() => economy.commandDevEconomy(p.token, { ...cmd, targetId: "stage2_stone_order" }, now), { code: "ECONOMY_REQUEST_CONFLICT" });
  row(p).state.inventory = { stone: 6 }; row(p).state.wallet.coins = model.ECONOMY_MAX_BALANCE - 359;
  const before = read(p); assert.throws(() => send(p), { code: "ECONOMY_CAPACITY" }); assert.deepEqual(read(p), before);
  assert.equal(result.state.stageOrders.stages["2"].step, 1); assert.equal(read(other).stageOrders.stages["2"].step, 0);
});

test("merging courses conserves the furthest frozen step and never reopens a completed reward", () => {
  const terms = model.economyCatalog.stageOrders[0].orders;
  const first = { version: 1, stages: { "2": { step: 2, completed: false, terms: { ...terms[2], coins: 177 } } } };
  const second = { version: 1, stages: { "2": { step: 4, completed: false, terms: { ...terms[4], coins: 599 } } } };
  const merged = stages.mergeStageOrders(first, second); assert.equal(merged.stages["2"].step, 4); assert.equal(merged.stages["2"].terms.coins, 599);
  const finished = { version: 1, stages: { "2": { step: 5, completed: true, terms: terms[4] } } };
  for (const pair of [[finished, first], [first, finished]]) {
    const result = stages.mergeStageOrders(...pair); assert.equal(result.stages["2"].completed, true); assert.equal(result.stages["2"].step, 5);
    assert.equal(stages.stageResidentOrder({ ...read(player()), stageOrders: result }), null);
  }
  assert.equal(first.stages["2"].step, 2); assert.equal(second.stages["2"].step, 4);
});
