import assert from "node:assert/strict";
import test, { after, beforeEach } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false } });
const identities = await vite.ssrLoadModule("/lib/dev/api-store.ts");
const economy = await vite.ssrLoadModule("/lib/dev/economy-store.ts");
const model = await vite.ssrLoadModule("/features/economy/domain/model.ts");
const rules = await vite.ssrLoadModule("/features/economy/domain/rules.ts");
const tutorial = await vite.ssrLoadModule("/features/economy/domain/tutorial-order.ts");
const food = await vite.ssrLoadModule("/features/economy/domain/food.ts");
const now = Date.parse("2026-10-13T20:00:00Z");
const player = () => identities.createDevIdentity("Ученик", crypto.randomUUID());
const read = (p, at = now) => economy.getDevEconomy(p.token, at);
const row = p => { read(p); return globalThis.__zhivDevEconomyStore.profiles.get(p.me.user.publicId); };
const offer = p => tutorial.tutorialResidentOrder(read(p));
const request = (p, action = "complete_resident_order", extra = {}) => ({ requestId: crypto.randomUUID(), ownerPublicId: p.me.user.publicId,
  expectedRevision: read(p).revision, action, targetId: offer(p)?.id ?? tutorial.TUTORIAL_ORDER_ID, quantity: 1, totalPrice: 0, ...extra });
const send = (p, action = "complete_resident_order", extra = {}, at = now) => economy.commandDevEconomy(p.token, request(p, action, extra), at);
const legacyTerms = { id: tutorial.TUTORIAL_ORDER_ID, residentId: "plesk", name: "Первый заказ", description: "Прежние условия",
  items: { berries: 3, wood: 2 }, coins: 100 };
const legacy = (p, ingredientsClaimed = true, completed = false) => {
  const saved = row(p); saved.state.tutorialOrder = { ingredientsClaimed, completed, terms: structuredClone(legacyTerms) };
  saved.state.inventory = { berries: 3, wood: 2, stone: 5 }; return saved;
};
beforeEach(() => { identities.resetDevStoreForTests(); economy.resetDevEconomyStoreForTests(); });
after(() => vite.close());

test("new tutorial pins an immediately available two-raspberry request without minting goods", () => {
  const p = player(), before = read(p), snapshot = structuredClone(before);
  assert.deepEqual(before.wallet, { coins: 100, pearls: 0 }); assert.deepEqual(before.inventory, { wood: 3, stone: 5 });
  assert.deepEqual(offer(p).items, { berries: 2 }); assert.equal(offer(p).coins, 30);
  assert.equal(before.tutorialOrder.version, 2); assert.equal(before.tutorialOrder.step, 0);
  assert.equal(before.tutorialOrder.ingredientsClaimed, true);
  tutorial.tutorialOrderProgress(before); assert.deepEqual(before, snapshot); assert.deepEqual(read(p), snapshot);
  assert.equal(food.residentOrderBoard(before, now).offers.length, 3);
  assert.throws(() => send(p, "claim_tutorial_order"), { code: "ECONOMY_TUTORIAL_ORDER_CLAIMED" });
  assert.throws(() => send(p), { code: "ECONOMY_RESOURCES" }); assert.deepEqual(read(p), snapshot);
});

test("four requests consume real inventory sequentially, pay 330 coins and preserve the ordinary board", () => {
  const p = player(), initial = read(p), board = food.residentOrderBoard(initial, now), ids = [];
  const expected = [[{ berries: 2 }, 30], [{ wood: 2 }, 90], [{ berry_compote: 2 }, 90], [{ planks: 2 }, 120]];
  let total = 0;
  for (const [step, [items, coins]] of expected.entries()) {
    const current = offer(p); ids.push(current.id);
    assert.deepEqual(current.items, items); assert.equal(current.coins, coins);
    assert.equal(read(p).tutorialOrder.step, step);
    row(p).state.inventory = { ...items, stone: 5 };
    const after = send(p).state; total += coins;
    assert.deepEqual(after.inventory, { stone: 5 }); assert.equal(after.wallet.coins, initial.wallet.coins + total);
    assert.equal(after.wallet.pearls, 0); assert.equal(after.tutorialOrder.step, step + 1);
    assert.equal(after.tutorialOrder.completed, step === 3);
    assert.equal(after.residentOrders.completed, step + 1); assert.equal(after.residentOrders.earnedCoins, total);
    assert.deepEqual(food.residentOrderBoard(after, now).offers, board.offers);
    assert.equal(model.economyResultSchema.safeParse({ requestId: crypto.randomUUID(), acceptedRevision: after.revision, replayed: false, message: "ok", state: after }).success, true);
    assert.throws(() => send(p, "complete_resident_order", { targetId: current.id }), { code: "ECONOMY_TUTORIAL_ORDER_UNAVAILABLE" });
  }
  assert.equal(new Set(ids).size, 4); assert.equal(total, 330); assert.equal(offer(p), null);
});

test("completed receipts replay safely after the next stage and stale clients cannot skip or pay twice", () => {
  const p = player(); row(p).state.inventory.berries = 2;
  const submit = request(p), completed = economy.commandDevEconomy(p.token, submit, now);
  const next = send(p).state;
  send(p, "start_production", { targetId: "grow_berries" }); const latest = read(p);
  const replay = economy.commandDevEconomy(p.token, submit, now);
  assert.equal(replay.replayed, true); assert.equal(replay.acceptedRevision, completed.acceptedRevision); assert.deepEqual(replay.state, latest);
  assert.throws(() => economy.commandDevEconomy(p.token, { ...submit, requestId: crypto.randomUUID() }, now), { code: "ECONOMY_REVISION_CONFLICT" });
  assert.equal(next.tutorialOrder.step, 2); assert.equal(next.wallet.coins, 220);
  assert.throws(() => send(p, "claim_tutorial_order", { targetId: tutorial.TUTORIAL_ORDER_ID }), { code: "ECONOMY_TUTORIAL_ORDER_CLAIMED" });
  assert.deepEqual(read(p), latest);
});

test("new pinned terms survive clock rotation, JSON serialization and catalog preview changes", () => {
  const p = player(), saved = row(p), original = structuredClone(saved.state.tutorialOrder.terms);
  saved.state = JSON.parse(JSON.stringify(saved.state)); saved.state.inventory.berries = 2;
  const preview = read(p); preview.catalog.onboarding.residentOrders[0].items = { stone: 50 }; preview.catalog.onboarding.residentOrders[0].coins = 999;
  assert.deepEqual(tutorial.tutorialResidentOrder(preview).items, original.items);
  assert.equal(tutorial.tutorialResidentOrder(preview).coins, original.coins);
  const result = economy.commandDevEconomy(p.token, request(p), now + 30 * 86400000).state;
  assert.equal(result.tutorialOrder.step, 1); assert.equal(result.wallet.coins, 130);
});

test("legacy conversion remains additive while saved wallets, inventories and missing course versions never refill", () => {
  const state = rules.newEconomyState({ resources: { sparks: 100, wood: 81, stone: 49 }, houseLevel: 4, workshopLevel: 2 });
  assert.deepEqual(state.migration, { version: 1, coinsGranted: 360, woodGranted: 9, stoneGranted: 7 });
  assert.deepEqual(state.wallet, { coins: 460, pearls: 0 }); assert.deepEqual(state.inventory, { wood: 12, stone: 12 });
  const p = player(), saved = row(p); saved.state.wallet = { coins: 27, pearls: 8 }; saved.state.inventory = { stone: 2 }; delete saved.state.tutorialOrder;
  const old = read(p); assert.deepEqual(old.wallet, { coins: 27, pearls: 8 }); assert.deepEqual(old.inventory, { stone: 2 });
  assert.equal(old.tutorialOrder.version, 1); assert.equal(old.tutorialOrder.ingredientsClaimed, false); assert.equal(old.tutorialOrder.completed, false);
  delete old.tutorialOrder; delete old.catalog.onboarding;
  assert.equal(model.economyViewSchema.safeParse(old).success, true);
});

test("legacy claimed terms are frozen, settle once under their old reward and never begin the new chain", () => {
  const p = player(), saved = legacy(p), before = read(p);
  saved.state = JSON.parse(JSON.stringify(saved.state));
  const preview = read(p); preview.catalog.onboarding.residentOrder.items = { stone: 50 }; preview.catalog.onboarding.residentOrder.coins = 999;
  assert.deepEqual(tutorial.tutorialResidentOrder(preview).items, legacyTerms.items); assert.equal(tutorial.tutorialResidentOrder(preview).coins, 100);
  const cmd = request(p), completed = economy.commandDevEconomy(p.token, cmd, now + 30 * 86400000).state;
  assert.deepEqual(completed.inventory, { stone: 5 }); assert.equal(completed.wallet.coins, before.wallet.coins + 100);
  assert.equal(completed.tutorialOrder.version, 1); assert.equal(completed.tutorialOrder.completed, true); assert.equal(offer(p), null);
  assert.equal(economy.commandDevEconomy(p.token, cmd, now).replayed, true);
  assert.throws(() => send(p), { code: "ECONOMY_TUTORIAL_ORDER_UNAVAILABLE" });
});

test("unclaimed legacy requests open without a new gift even in a full warehouse and keep their original frozen terms", () => {
  const p = player(), saved = legacy(p, false); saved.state.inventory = { stone: 50 };
  const before = read(p), cmd = request(p, "claim_tutorial_order"), opened = economy.commandDevEconomy(p.token, cmd, now).state;
  assert.deepEqual(opened.wallet, before.wallet); assert.deepEqual(opened.inventory, before.inventory);
  assert.equal(opened.tutorialOrder.ingredientsClaimed, true); assert.deepEqual(opened.tutorialOrder.terms, legacyTerms);
  assert.equal(economy.commandDevEconomy(p.token, cmd, now).replayed, true);
  assert.throws(() => send(p, "claim_tutorial_order"), { code: "ECONOMY_TUTORIAL_ORDER_CLAIMED" });
  assert.throws(() => send(p), { code: "ECONOMY_RESOURCES" });
});

test("sales do not permit another gift and wallet overflow rejects the whole completion without consuming goods", () => {
  const p = player(); row(p).state.inventory.berries = 2; send(p, "sell", { targetId: "berries", quantity: 2 });
  const before = read(p);
  assert.throws(() => send(p), { code: "ECONOMY_RESOURCES" }); assert.throws(() => send(p, "claim_tutorial_order"), { code: "ECONOMY_TUTORIAL_ORDER_CLAIMED" });
  assert.deepEqual(read(p), before);
  row(p).state.inventory.berries = 2; row(p).state.wallet.coins = model.ECONOMY_MAX_BALANCE - 29;
  const nearLimit = read(p); assert.throws(() => send(p), { code: "ECONOMY_CAPACITY" }); assert.deepEqual(read(p), nearLimit);
});

test("legacy unclaimed requests and malformed commands cannot complete or replace and accounts remain isolated", () => {
  const p = player(); legacy(p, false); const before = read(p);
  for (const action of ["complete_resident_order", "replace_resident_order"])
    assert.throws(() => send(p, action), { code: "ECONOMY_TUTORIAL_ORDER_UNAVAILABLE" });
  for (const extra of [{ targetId: "workshop" }, { quantity: 2 }, { totalPrice: 1 }])
    assert.throws(() => send(p, "claim_tutorial_order", extra), { code: "INVALID_ECONOMY_COMMAND" });
  assert.deepEqual(read(p), before);
  const other = player(), cmd = request(p, "claim_tutorial_order");
  assert.throws(() => economy.commandDevEconomy(other.token, cmd, now), { code: "ECONOMY_OWNER_CHANGED" });
  send(p, "claim_tutorial_order"); assert.equal(read(other).tutorialOrder.step, 0);
  assert.throws(() => economy.commandDevEconomy(p.token, { ...cmd, requestId: crypto.randomUUID() }, now), { code: "ECONOMY_REVISION_CONFLICT" });
});

test("home two requires four first-stage requests, but legacy completed and unfinished profiles retain construction eligibility", () => {
  for (const version of [1, 2]) for (const completed of [false, true]) {
    const p = player(), saved = row(p);
    saved.state.wallet.coins = 250; saved.state.inventory = { wood: 3, stone: 2, planks: 2 };
    Object.assign(saved.state.buildings, { woodlot: 1, dryer: 1, workshop: 1 });
    saved.state.tutorialOrder = { version, step: completed ? 4 : 0, ingredientsClaimed: true, completed, terms: completed ? null : structuredClone(legacyTerms) };
    const before = read(p);
    if (version === 2 && !completed) {
      assert.throws(() => send(p, "start_construction", { targetId: "home" }), { code: "ECONOMY_TUTORIAL_REQUIRED" }); assert.deepEqual(read(p), before);
    } else assert.equal(send(p, "start_construction", { targetId: "home" }).state.jobs[0].targetLevel, 2);
  }
});

test("future course IDs cannot skip a step and an unfinished stored step four cannot pay a fifth request", () => {
  const p = player(), saved = row(p);
  saved.state.inventory = { berries: 2, wood: 2, berry_compote: 2, planks: 2 };
  const initial = read(p);
  for (const terms of model.economyCatalog.onboarding.residentOrders.slice(1)) {
    assert.throws(() => send(p, "complete_resident_order", { targetId: terms.id }), { code: "ECONOMY_TUTORIAL_ORDER_UNAVAILABLE" });
    assert.deepEqual(read(p), initial);
  }
  saved.state.tutorialOrder.step = 4;
  const corrupt = read(p);
  assert.throws(() => send(p, "complete_resident_order", { targetId: tutorial.TUTORIAL_ORDER_ID }), { code: "ECONOMY_TUTORIAL_ORDER_UNAVAILABLE" });
  assert.deepEqual(read(p), corrupt);
});
