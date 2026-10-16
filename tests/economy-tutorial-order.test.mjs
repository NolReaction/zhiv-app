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
const stages = await vite.ssrLoadModule("/features/economy/domain/stage-orders.ts");
const food = await vite.ssrLoadModule("/features/economy/domain/food.ts");
const now = Date.parse("2026-10-13T20:00:00Z");
const player = () => identities.createDevIdentity("Ученик", crypto.randomUUID());
const read = (p, at = now) => economy.getDevEconomy(p.token, at);
const row = p => { read(p); return globalThis.__zhivDevEconomyStore.profiles.get(p.me.user.publicId); };
const offer = p => tutorial.tutorialResidentOrder(read(p)) ?? stages.stageResidentOrder(read(p));
const request = (p, action = "complete_resident_order", extra = {}) => ({ requestId: crypto.randomUUID(), ownerPublicId: p.me.user.publicId,
  expectedRevision: read(p).revision, action, targetId: offer(p)?.id ?? tutorial.TUTORIAL_ORDER_ID, quantity: 1, totalPrice: 0, ...extra });
const send = (p, action = "complete_resident_order", extra = {}, at = now) => economy.commandDevEconomy(p.token, request(p, action, extra), at);
const legacyTerms = { id: tutorial.TUTORIAL_ORDER_ID, residentId: "plesk", name: "Первый заказ", description: "Прежние условия",
  items: { berries: 3, wood: 2 }, coins: 100 };
const legacy = (p, ingredientsClaimed = true, completed = false) => {
  const saved = row(p); saved.state.tutorialOrder = { ingredientsClaimed, completed, terms: structuredClone(legacyTerms) };
  saved.state.inventory = { berries: 3, wood: 2, stone: 5 }; return saved;
};
const previousRequests = [
  { ...structuredClone(model.economyCatalog.onboarding.residentOrder), items: { berries: 2 }, coins: 30 },
  ...model.economyCatalog.stageOrders.find(stage => stage.homeLevel === 1).orders.map(order => ({ ...structuredClone(order), id: order.id.replace("stage1_", "tutorial_") })),
];
beforeEach(() => { identities.resetDevStoreForTests(); economy.resetDevEconomyStoreForTests(); });
after(() => vite.close());

test("one ripe raspberry completes the only teaching request without a gift or automatic house progress", () => {
  const p = player(), before = read(p), snapshot = structuredClone(before);
  assert.deepEqual(before.wallet, { coins: 100, pearls: 0 }); assert.deepEqual(before.inventory, { wood: 3, stone: 5 });
  assert.deepEqual(offer(p).items, { berries: 1 }); assert.equal(offer(p).coins, 15);
  assert.equal(before.tutorialOrder.version, 3); assert.equal(before.tutorialOrder.step, 0);
  assert.equal(before.tutorialOrder.ingredientsClaimed, true); assert.equal(stages.stageResidentOrder(before), null);
  tutorial.tutorialOrderProgress(before); assert.deepEqual(before, snapshot); assert.deepEqual(read(p), snapshot);
  assert.equal(food.residentOrderBoard(before, now).offers.length, 3);
  assert.throws(() => send(p, "claim_tutorial_order"), { code: "ECONOMY_TUTORIAL_ORDER_CLAIMED" });
  assert.throws(() => send(p), { code: "ECONOMY_RESOURCES" }); assert.deepEqual(read(p), snapshot);
  row(p).state.inventory.berries = 1;
  const finished = send(p).state;
  assert.equal(finished.tutorialOrder.completed, true); assert.equal(finished.tutorialOrder.step, 1);
  assert.equal(tutorial.tutorialResidentOrder(finished), null); assert.equal(stages.stageResidentOrder(finished).id, "stage1_wood_order");
  assert.equal(finished.stageOrders.stages["1"].step, 0); assert.equal(finished.wallet.coins, 115);
});

test("three separate house requests spend real goods, pay 300 and preserve the ordinary board", () => {
  const p = player(), initial = read(p), board = food.residentOrderBoard(initial, now);
  const expected = [["tutorial_first_order", { berries: 1 }, 15], ["stage1_wood_order", { wood: 2 }, 90],
    ["stage1_compote_order", { berry_compote: 2 }, 90], ["stage1_planks_order", { planks: 2 }, 120]];
  let total = 0;
  for (const [index, [id, items, coins]] of expected.entries()) {
    const current = offer(p); assert.equal(current.id, id); assert.deepEqual(current.items, items); assert.equal(current.coins, coins);
    row(p).state.inventory = { ...items, stone: 5 };
    const after = send(p).state; total += coins;
    assert.deepEqual(after.inventory, { stone: 5 }); assert.equal(after.wallet.coins, initial.wallet.coins + total);
    assert.equal(after.wallet.pearls, 0); assert.equal(after.tutorialOrder.completed, true);
    assert.equal(after.residentOrders.completed, index + 1); assert.equal(after.residentOrders.earnedCoins, total);
    assert.deepEqual(food.residentOrderBoard(after, now).offers, board.offers);
    assert.equal(model.economyResultSchema.safeParse({ requestId: crypto.randomUUID(), acceptedRevision: after.revision, replayed: false, message: "ok", state: after }).success, true);
    assert.throws(() => send(p, "complete_resident_order", { targetId: current.id }), { code: index === 0 ? "ECONOMY_TUTORIAL_ORDER_UNAVAILABLE" : "ECONOMY_STAGE_ORDER_UNAVAILABLE" });
  }
  assert.equal(total, 315); assert.equal(offer(p), null); assert.equal(read(p).stageOrders.stages["1"].completed, true);
});

test("completed receipts replay after the first house request and stale clients cannot pay twice", () => {
  const p = player(); row(p).state.inventory.berries = 1;
  const submit = request(p), completed = economy.commandDevEconomy(p.token, submit, now);
  const next = send(p).state;
  send(p, "start_production", { targetId: "grow_berries" }); const latest = read(p);
  const replay = economy.commandDevEconomy(p.token, submit, now);
  assert.equal(replay.replayed, true); assert.equal(replay.acceptedRevision, completed.acceptedRevision); assert.deepEqual(replay.state, latest);
  assert.throws(() => economy.commandDevEconomy(p.token, { ...submit, requestId: crypto.randomUUID() }, now), { code: "ECONOMY_REVISION_CONFLICT" });
  assert.equal(next.tutorialOrder.step, 1); assert.equal(next.stageOrders.stages["1"].step, 1); assert.equal(next.wallet.coins, 205);
  assert.throws(() => send(p, "claim_tutorial_order", { targetId: tutorial.TUTORIAL_ORDER_ID }), { code: "ECONOMY_TUTORIAL_ORDER_CLAIMED" });
  assert.deepEqual(read(p), latest);
});

test("new pinned terms survive rotation, JSON serialization and catalog preview edits", () => {
  const p = player(), saved = row(p), original = structuredClone(saved.state.tutorialOrder.terms);
  saved.state = JSON.parse(JSON.stringify(saved.state)); saved.state.inventory.berries = 1;
  const preview = read(p); preview.catalog.onboarding.residentOrder.items = { stone: 50 }; preview.catalog.onboarding.residentOrder.coins = 999;
  assert.deepEqual(tutorial.tutorialResidentOrder(preview).items, original.items);
  assert.equal(tutorial.tutorialResidentOrder(preview).coins, original.coins);
  const result = economy.commandDevEconomy(p.token, request(p), now + 30 * 86400000).state;
  assert.equal(result.tutorialOrder.step, 1); assert.equal(result.wallet.coins, 115);
});

test("v2 active first request needs one berry while preserving its promised reward and original receipt", () => {
  const p = player(), saved = row(p);
  saved.state.tutorialOrder = { version: 2, step: 0, ingredientsClaimed: true, completed: false, terms: structuredClone(previousRequests[0]) };
  saved.state.inventory = { berries: 1 };
  const stored = structuredClone(saved), view = read(p);
  assert.deepEqual(offer(p).items, { berries: 1 }); assert.equal(offer(p).coins, 30); assert.equal(view.tutorialOrder.version, 3);
  assert.deepEqual(saved, stored, "GET must not mutate the stored v2 record or revision");
  const cmd = request(p), result = economy.commandDevEconomy(p.token, cmd, now);
  assert.equal(result.state.wallet.coins, 130); assert.equal(result.state.stageOrders.stages["1"].step, 0);
  assert.equal(saved.state.tutorialOrder.version, 3);
  assert.equal(economy.commandDevEconomy(p.token, cmd, now).replayed, true); assert.equal(read(p).wallet.coins, 130);
});

test("v2 paid progress becomes stage progress without another reward or a changed active quote", () => {
  for (let step = 1; step <= 4; step++) {
    const p = player(), saved = row(p), completed = step === 4;
    saved.state.tutorialOrder = { version: 2, step, ingredientsClaimed: true, completed,
      terms: { ...structuredClone(previousRequests[Math.min(step, 3)]), coins: 137 } };
    saved.state.wallet.coins = 51;
    saved.state.residentOrders = { ...read(p).residentOrders, completed: step, earnedCoins: 137 * step };
    const stored = structuredClone(saved), view = read(p);
    assert.equal(stages.stageOrderProgress(saved.state).step, step - 1);
    assert.equal(view.tutorialOrder.version, 3); assert.equal(view.tutorialOrder.completed, true);
    assert.equal(view.stageOrders.stages["1"].step, step - 1); assert.equal(view.stageOrders.stages["1"].completed, completed);
    assert.equal(view.wallet.coins, 51); assert.deepEqual(saved, stored);
    if (completed) { assert.equal(offer(p), null); continue; }
    assert.equal(offer(p).id, previousRequests[step].id); assert.equal(offer(p).coins, 137);
    assert.deepEqual(offer(p).items, previousRequests[step].items);
    saved.state.inventory = structuredClone(previousRequests[step].items);
    const cmd = request(p), result = economy.commandDevEconomy(p.token, cmd, now);
    assert.equal(result.state.wallet.coins, 188); assert.equal(result.state.stageOrders.stages["1"].step, step);
    assert.equal(result.state.residentOrders.completed, step + 1);
    if (step < 3) assert.equal(offer(p).id, previousRequests[step + 1].id.replace("tutorial_", "stage1_"));
    assert.equal(economy.commandDevEconomy(p.token, cmd, now).replayed, true); assert.equal(read(p).wallet.coins, 188);
  }
});

test("legacy conversion is additive and saved wallets, inventories and absent versions never refill", () => {
  const state = rules.newEconomyState({ resources: { sparks: 100, wood: 81, stone: 49 }, houseLevel: 4, workshopLevel: 2 });
  assert.deepEqual(state.migration, { version: 1, coinsGranted: 360, woodGranted: 9, stoneGranted: 7 });
  assert.deepEqual(state.wallet, { coins: 460, pearls: 0 }); assert.deepEqual(state.inventory, { wood: 12, stone: 12 });
  const p = player(), saved = row(p); saved.state.wallet = { coins: 27, pearls: 8 }; saved.state.inventory = { stone: 2 }; delete saved.state.tutorialOrder;
  const old = read(p); assert.deepEqual(old.wallet, { coins: 27, pearls: 8 }); assert.deepEqual(old.inventory, { stone: 2 });
  assert.equal(old.tutorialOrder.version, 1); assert.equal(old.tutorialOrder.ingredientsClaimed, false); assert.equal(old.tutorialOrder.completed, false);
  delete old.tutorialOrder; delete old.catalog.onboarding;
  assert.equal(model.economyViewSchema.safeParse(old).success, true);
});

test("legacy claimed terms settle once under their old reward and never begin the new course", () => {
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

test("unclaimed legacy requests open without a new gift even in a full warehouse", () => {
  const p = player(), saved = legacy(p, false); saved.state.inventory = { stone: 50 };
  const before = read(p), cmd = request(p, "claim_tutorial_order"), opened = economy.commandDevEconomy(p.token, cmd, now).state;
  assert.deepEqual(opened.wallet, before.wallet); assert.deepEqual(opened.inventory, before.inventory);
  assert.equal(opened.tutorialOrder.ingredientsClaimed, true); assert.deepEqual(opened.tutorialOrder.terms, legacyTerms);
  assert.equal(economy.commandDevEconomy(p.token, cmd, now).replayed, true);
  assert.throws(() => send(p, "claim_tutorial_order"), { code: "ECONOMY_TUTORIAL_ORDER_CLAIMED" });
  assert.throws(() => send(p), { code: "ECONOMY_RESOURCES" });
});

test("sales cannot replenish gifts and overflow rejects completion without consuming the ripe berry", () => {
  const p = player(); row(p).state.inventory.berries = 1; send(p, "sell", { targetId: "berries", quantity: 1 });
  const before = read(p);
  assert.throws(() => send(p), { code: "ECONOMY_RESOURCES" }); assert.throws(() => send(p, "claim_tutorial_order"), { code: "ECONOMY_TUTORIAL_ORDER_CLAIMED" });
  assert.deepEqual(read(p), before);
  row(p).state.inventory.berries = 1; row(p).state.wallet.coins = model.ECONOMY_MAX_BALANCE - 14;
  const nearLimit = read(p); assert.throws(() => send(p), { code: "ECONOMY_CAPACITY" }); assert.deepEqual(read(p), nearLimit);
});

test("malformed commands cannot complete or replace a legacy request and accounts stay isolated", () => {
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

test("home two needs the teaching request and three small stage deliveries while older paid courses remain complete", () => {
  const p = player(), saved = row(p);
  const ready = () => { saved.state.wallet.coins = 250; saved.state.inventory = { wood: 3, stone: 2, planks: 2 };
    Object.assign(saved.state.buildings, { woodlot: 1, dryer: 1, workshop: 1 }); };
  ready(); assert.throws(() => send(p, "start_construction", { targetId: "home" }), { code: "ECONOMY_TUTORIAL_REQUIRED" });
  saved.state.inventory.berries = 1; send(p); ready();
  assert.throws(() => send(p, "start_construction", { targetId: "home" }), { code: "ECONOMY_STAGE_REQUIRED" });
  saved.state.stageOrders.stages["1"] = { ...saved.state.stageOrders.stages["1"], step: 3, completed: true };
  assert.equal(send(p, "start_construction", { targetId: "home" }).state.jobs[0].targetLevel, 2);
  for (const version of [1, 2]) {
    const other = player(), previous = row(other); previous.state.wallet.coins = 250;
    previous.state.inventory = { wood: 3, stone: 2, planks: 2 };
    Object.assign(previous.state.buildings, { woodlot: 1, dryer: 1, workshop: 1 });
    previous.state.tutorialOrder = { version, step: version === 2 ? 4 : 0, ingredientsClaimed: true, completed: true, terms: null };
    assert.equal(send(other, "start_construction", { targetId: "home" }).state.jobs[0].targetLevel, 2);
  }
});

test("future and forged previous tutorial IDs cannot skip the current first-house delivery", () => {
  const p = player(), saved = row(p); saved.state.inventory = { berries: 1, wood: 2, berry_compote: 2, planks: 2 };
  const initial = read(p);
  for (const terms of [...previousRequests.slice(1), ...model.economyCatalog.stageOrders.find(stage => stage.homeLevel === 1).orders]) {
    assert.throws(() => send(p, "complete_resident_order", { targetId: terms.id }), { code: "ECONOMY_STAGE_ORDER_UNAVAILABLE" });
    assert.deepEqual(read(p), initial);
  }
  saved.state.tutorialOrder.step = 1;
  const corrupt = read(p);
  assert.throws(() => send(p, "complete_resident_order", { targetId: tutorial.TUTORIAL_ORDER_ID }), { code: "ECONOMY_TUTORIAL_ORDER_UNAVAILABLE" });
  assert.deepEqual(read(p), corrupt);
});
