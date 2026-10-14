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

test("seven frozen course requests settle sequentially without rerolling the ordinary board or replaying goods and rewards", () => {
  const p = player(), expected = [[{ rope: 2 }, 90], [{ stone: 6 }, 360], [{ clay: 4 }, 180], [{ charcoal: 2 }, 150], [{ bricks: 4 }, 600], [{ fish_common: 6 }, 360], [{ grilled_fish: 3 }, 250]], receipts = [];
  const board = food.residentOrderBoard(read(p), now).offers; let paid = 0;
  for (const [step, [items, coins]] of expected.entries()) {
    const offer = quote(p); assert.deepEqual(offer.items, items); assert.equal(offer.coins, coins);
    row(p).state.inventory = { ...items };
    const cmd = request(p), result = economy.commandDevEconomy(p.token, cmd, now); receipts.push([cmd, result.acceptedRevision]); paid += coins;
    assert.equal(result.state.stageOrders.stages["2"].step, step + 1); assert.equal(result.state.stageOrders.stages["2"].completed, step === expected.length - 1);
    assert.equal(stages.stageCourseRequired(result.state, 3), step < expected.length - 1);
    assert.deepEqual(result.state.inventory, {}); assert.equal(result.state.wallet.coins, 50 + paid);
    assert.deepEqual(food.residentOrderBoard(result.state, now).offers, board);
    assert.throws(() => send(p, "complete_resident_order", offer.id), { code: "ECONOMY_STAGE_ORDER_UNAVAILABLE" });
  }
  const latest = read(p); assert.equal(paid, 1990); assert.equal(quote(p), null);
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

test("accepted legacy brick terms remain frozen before the appended fish and meal requests", () => {
  const p = player(), terms = { ...model.economyCatalog.stageOrders[0].orders[4], items: { bricks: 3 }, coins: 590, description: "Прежние принятые условия" };
  row(p).state.stageOrders = { version: 1, stages: { "2": { step: 4, completed: false, terms } } };
  row(p).state = JSON.parse(JSON.stringify(row(p).state)); row(p).state.inventory = { bricks: 3 };
  const offer = quote(p); assert.deepEqual(offer.items, { bricks: 3 }); assert.equal(offer.coins, 590); assert.equal(offer.description, terms.description);
  const result = send(p, "complete_resident_order", "stage2_bricks_order").state;
  assert.equal(result.wallet.coins, 640); assert.deepEqual(result.inventory, {});
  assert.equal(result.stageOrders.stages["2"].step, 5); assert.equal(result.stageOrders.stages["2"].completed, false);
  assert.equal(stages.stageResidentOrder(result).id, "stage2_fish_order"); assert.deepEqual(stages.stageResidentOrder(result).items, { fish_common: 6 });
  assert.equal(stages.stageCourseRequired(result, 3), true);
});

test("persisted legacy courses completed at step five stay closed and retain their paid brick receipt", () => {
  const p = player(), state = row(p).state, terms = structuredClone(model.economyCatalog.stageOrders[0].orders[4]);
  state.stageOrders = { version: 1, stages: { "2": { step: 5, completed: true, terms } } };
  state.wallet.coins = 1430; state.residentOrders = { ...read(p).residentOrders, completed: 5, earnedCoins: 1380 };
  const cmd = request(p, "complete_resident_order", "stage2_bricks_order"), acceptedRevision = row(p).revision + 1;
  row(p).revision = acceptedRevision;
  row(p).receipts.set(cmd.requestId, {
    signature: JSON.stringify([cmd.ownerPublicId, cmd.expectedRevision, cmd.action, cmd.targetId, cmd.quantity, cmd.totalPrice]),
    message: "Все постоянные заказы этапа выполнены. Монеты получены", acceptedRevision,
  });
  row(p).state = JSON.parse(JSON.stringify(row(p).state));
  row(p).receipts = new Map(JSON.parse(JSON.stringify([...row(p).receipts])));
  const before = read(p); assert.equal(quote(p), null); assert.equal(stages.stageCourseRequired(before, 3), false);
  const replay = economy.commandDevEconomy(p.token, cmd, now);
  assert.equal(replay.replayed, true); assert.equal(replay.acceptedRevision, acceptedRevision); assert.deepEqual(replay.state, before);
  for (const targetId of ["stage2_bricks_order", "stage2_fish_order", "stage2_fish_meal_order"])
    assert.throws(() => send(p, "complete_resident_order", targetId), { code: "ECONOMY_STAGE_ORDER_UNAVAILABLE" });
  assert.deepEqual(read(p), before); assert.equal(read(p).stageOrders.stages["2"].step, 5);
});

test("home three requires the new course while unfinished legacy tutorial v1 remains compatible", () => {
  const cost = model.economyCatalog.buildings.find(building => building.id === "home").levels[2].cost;
  for (const version of [1, 2]) {
    const p = player(2, version); row(p).state.wallet.coins = cost.coins; row(p).state.inventory = { ...cost.items };
    const before = read(p);
    if (version === 2) { assert.throws(() => send(p, "start_construction", "home"), { code: "ECONOMY_STAGE_REQUIRED" }); assert.deepEqual(read(p), before); }
    else { row(p).state.tutorialOrder.completed = false; assert.equal(send(p, "start_construction", "home").state.jobs[0].targetLevel, 3); }
  }
});

test("home four requires the stage three course for every tutorial version", () => {
  const target = model.economyCatalog.buildings.find(building => building.id === "home").levels[3], cost = target.cost;
  const course = model.economyCatalog.stageOrders.find(stage => stage.homeLevel === 3);
  for (const version of [1, 2]) {
    const p = player(3, version); row(p).state.wallet.coins = cost.coins; row(p).state.inventory = { ...cost.items };
    Object.assign(row(p).state.buildings, target.requiredBuildings); row(p).state.tutorialOrder.completed = version === 2;
    const before = read(p); assert.equal(quote(p).id, "stage3_foundation_order"); assert.equal(before.stageOrders.stages["2"], undefined);
    assert.equal(stages.stageCourseRequired(before, 4), true);
    assert.throws(() => send(p, "start_construction", "home"), { code: "ECONOMY_STAGE_REQUIRED" }); assert.deepEqual(read(p), before);
    row(p).state.stageOrders = { version: 1, stages: { "3": { step: course.orders.length, completed: true, terms: null } } };
    assert.equal(stages.stageCourseRequired(read(p), 4), false);
    assert.equal(send(p, "start_construction", "home").state.jobs[0].targetLevel, 4);
  }
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
