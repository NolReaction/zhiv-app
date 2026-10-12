import assert from "node:assert/strict";
import test, { after, beforeEach } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false } });
const identities = await vite.ssrLoadModule("/lib/dev/api-store.ts");
const economy = await vite.ssrLoadModule("/lib/dev/economy-store.ts");
const model = await vite.ssrLoadModule("/features/economy/domain/model.ts");
const rules = await vite.ssrLoadModule("/features/economy/domain/rules.ts");
const tutorial = await vite.ssrLoadModule("/features/economy/domain/tutorial-order.ts");
const food = await vite.ssrLoadModule("/features/economy/domain/food.ts");
const { formatPearls } = await vite.ssrLoadModule("/features/economy/domain/money.ts");
const now = Date.parse("2026-10-11T20:00:00Z");
const targetId = tutorial.TUTORIAL_ORDER_ID;
const player = () => identities.createDevIdentity("Ученик", crypto.randomUUID());
const read = (p, at = now) => economy.getDevEconomy(p.token, at);
const row = p => { read(p); return globalThis.__zhivDevEconomyStore.profiles.get(p.me.user.publicId); };
const request = (p, action = "claim_tutorial_order", extra = {}) => ({ requestId: crypto.randomUUID(), ownerPublicId: p.me.user.publicId,
  expectedRevision: read(p).revision, action, targetId, quantity: 1, totalPrice: 0, ...extra });
const send = (p, action = "claim_tutorial_order", extra = {}, at = now) => economy.commandDevEconomy(p.token, request(p, action, extra), at);
const fresh = () => rules.newEconomyState({ resources: { sparks: 0, wood: 0, stone: 0 }, houseLevel: 1, workshopLevel: 0 });
beforeEach(() => identities.resetDevStoreForTests());
after(() => vite.close());

test("new players start with requested visible currencies and ten ordinary fish, stone and wood", () => {
  const state = fresh();
  assert.deepEqual(state.wallet, { coins: 2500, pearls: 1000 });
  assert.equal(formatPearls(state.wallet.pearls), "500");
  assert.deepEqual(state.inventory, { fish: 10, wood: 10, stone: 10 });
  assert.deepEqual(state.fishing.catches, {}, "a starting fish is not a caught collection entry");
  assert.equal(state.workshopStarterClaimed, false);
  assert.deepEqual(read(player()).inventory, state.inventory);
});

test("legacy conversion remains additive and old persisted wallets never refill", () => {
  const state = rules.newEconomyState({ resources: { sparks: 100, wood: 81, stone: 49 }, houseLevel: 4, workshopLevel: 2 });
  assert.deepEqual(state.migration, { version: 1, coinsGranted: 360, woodGranted: 9, stoneGranted: 7 });
  assert.deepEqual(state.wallet, { coins: 2860, pearls: 1000 });
  assert.deepEqual(state.inventory, { fish: 10, wood: 19, stone: 17 });
  const p = player(), saved = row(p);
  saved.state.wallet = { coins: 27, pearls: 8 }; saved.state.inventory = { stone: 2 };
  delete saved.state.tutorialOrder;
  assert.deepEqual(read(p).wallet, { coins: 27, pearls: 8 });
  assert.deepEqual(read(p).inventory, { stone: 2 });
  assert.deepEqual(read(p).tutorialOrder, { ingredientsClaimed: false, completed: false, terms: null });
  const old = read(p); delete old.tutorialOrder; delete old.catalog.onboarding;
  assert.equal(model.economyViewSchema.safeParse(old).success, true, "older API snapshots stay compatible");
});

test("reading an available tutorial is free of state mutations and ordinary board changes", () => {
  const p = player(), before = read(p), snapshot = structuredClone(before);
  assert.equal(tutorial.tutorialResidentOrder(before).id, targetId);
  tutorial.tutorialOrderProgress(before);
  assert.deepEqual(before, snapshot);
  assert.deepEqual(read(p), snapshot);
  assert.equal(food.residentOrderBoard(before, now).offers.length, 3);
});

test("the explicit claim grants exact extra ingredients, pins terms and preserves all regular requests", () => {
  const p = player(), before = read(p), board = food.residentOrderBoard(before, now);
  const result = send(p), after = result.state;
  assert.deepEqual(after.wallet, before.wallet);
  assert.deepEqual(after.inventory, { fish: 10, wood: 12, stone: 10, berries: 3 });
  assert.equal(after.tutorialOrder.ingredientsClaimed, true); assert.equal(after.tutorialOrder.completed, false);
  assert.deepEqual(after.tutorialOrder.terms, model.economyCatalog.onboarding.residentOrder);
  assert.deepEqual(food.residentOrderBoard(after, now).offers, board.offers);
  assert.deepEqual(after.jobs, before.jobs); assert.deepEqual(after.buildings, before.buildings);
  assert.equal(model.economyResultSchema.safeParse(result).success, true);
});

test("completion uses ordinary inventory debit and one coin reward without replacing a board slot", () => {
  const p = player(), accepted = send(p).state, board = food.residentOrderBoard(accepted, now);
  const result = send(p, "complete_resident_order").state;
  assert.deepEqual(result.inventory, { fish: 10, wood: 10, stone: 10 });
  assert.equal(result.wallet.coins, accepted.wallet.coins + 100);
  assert.equal(result.wallet.pearls, accepted.wallet.pearls);
  assert.equal(result.tutorialOrder.completed, true);
  assert.equal(result.residentOrders.completed, board.completed + 1);
  assert.equal(result.residentOrders.earnedCoins, board.earnedCoins + 100);
  assert.deepEqual(food.residentOrderBoard(result, now).offers, board.offers);
  assert.equal(tutorial.tutorialResidentOrder(result), null);
});

test("claim and completion receipt retries cannot mint twice, including after a later command", () => {
  const p = player(), gift = request(p), first = economy.commandDevEconomy(p.token, gift, now);
  const submit = request(p, "complete_resident_order"), complete = economy.commandDevEconomy(p.token, submit, now);
  send(p, "start_production", { targetId: "grow_berries" });
  const latest = read(p);
  for (const [cmd, original] of [[gift, first], [submit, complete]]) {
    const replay = economy.commandDevEconomy(p.token, cmd, now);
    assert.equal(replay.replayed, true); assert.equal(replay.acceptedRevision, original.acceptedRevision);
    assert.deepEqual(replay.state, latest);
  }
  assert.throws(() => send(p), { code: "ECONOMY_TUTORIAL_ORDER_CLAIMED" });
  assert.throws(() => send(p, "complete_resident_order"), { code: "ECONOMY_TUTORIAL_ORDER_UNAVAILABLE" });
  assert.deepEqual(read(p), latest);
});

test("saved tutorial terms survive clock rotation, serialization and later catalog changes", () => {
  const p = player(); send(p);
  const saved = row(p), original = structuredClone(saved.state.tutorialOrder.terms);
  saved.state = JSON.parse(JSON.stringify(saved.state));
  const preview = read(p); preview.catalog.onboarding.residentOrder.items = { stone: 50 }; preview.catalog.onboarding.residentOrder.coins = 999;
  assert.deepEqual(tutorial.tutorialResidentOrder(preview).items, original.items);
  assert.equal(tutorial.tutorialResidentOrder(preview).coins, original.coins);
  const future = now + 30 * 86400000;
  const accepted = economy.commandDevEconomy(p.token, request(p, "complete_resident_order"), future);
  assert.equal(accepted.state.tutorialOrder.completed, true);
  assert.equal(accepted.state.wallet.coins, 2600);
});

test("selling ingredients does not permit another grant and a failed submit leaves the order pending", () => {
  const p = player(); send(p); send(p, "sell", { targetId: "berries", quantity: 3 });
  const before = read(p);
  assert.throws(() => send(p, "complete_resident_order"), { code: "ECONOMY_RESOURCES" });
  assert.throws(() => send(p), { code: "ECONOMY_TUTORIAL_ORDER_CLAIMED" });
  assert.deepEqual(read(p), before);
  row(p).state.inventory.berries = 3;
  assert.equal(send(p, "complete_resident_order").state.tutorialOrder.completed, true);
});

test("full and escrow-reserved storage reject the whole gift without consuming its marker", () => {
  const p = player(), saved = row(p); saved.state.inventory = { stone: 300 };
  const before = read(p);
  assert.throws(() => send(p), { code: "ECONOMY_STORAGE_FULL" }); assert.deepEqual(read(p), before);
  const state = fresh(); state.inventory = { stone: 295 };
  const untouched = structuredClone(state);
  assert.throws(() => rules.applyEconomyCommand(state, request(p), now, crypto.randomUUID, { wood: 1 }), { code: "ECONOMY_STORAGE_FULL" });
  assert.deepEqual(state, untouched);
  saved.state.inventory = { stone: 295 };
  assert.equal(send(p).state.storage.used, 300);
});

test("wallet limits reject completion before consuming goods or completion state", () => {
  const p = player(); send(p); row(p).state.wallet.coins = model.ECONOMY_MAX_BALANCE - 99;
  const before = read(p);
  assert.throws(() => send(p, "complete_resident_order"), { code: "ECONOMY_CAPACITY" });
  assert.deepEqual(read(p), before);
});

test("unclaimed requests cannot complete or replace and grants validate targets quantity and price", () => {
  const p = player(), before = read(p);
  for (const action of ["complete_resident_order", "replace_resident_order"])
    assert.throws(() => send(p, action), { code: "ECONOMY_TUTORIAL_ORDER_UNAVAILABLE" });
  for (const extra of [{ targetId: "workshop" }, { quantity: 2 }, { totalPrice: 1 }])
    assert.throws(() => send(p, "claim_tutorial_order", extra), { code: "INVALID_ECONOMY_COMMAND" });
  assert.deepEqual(read(p), before);
  send(p);
  assert.throws(() => send(p, "replace_resident_order"), { code: "ECONOMY_TUTORIAL_ORDER_UNAVAILABLE" });
});

test("separate accounts keep separate tutorial grants and owner guards reject stale clients", () => {
  const p = player(), other = player(), cmd = request(p);
  assert.throws(() => economy.commandDevEconomy(other.token, cmd, now), { code: "ECONOMY_OWNER_CHANGED" });
  send(p); assert.equal(read(other).tutorialOrder.ingredientsClaimed, false);
  assert.equal(send(other).state.tutorialOrder.ingredientsClaimed, true);
  assert.throws(() => economy.commandDevEconomy(p.token, { ...cmd, requestId: crypto.randomUUID() }, now), { code: "ECONOMY_REVISION_CONFLICT" });
});

test("independent workshop gift remains available before and after tutorial practice", () => {
  const p = player(); send(p); send(p, "complete_resident_order");
  const before = read(p), workshop = send(p, "claim_workshop_starter", { targetId: "workshop" }).state;
  assert.equal(workshop.workshopStarterClaimed, true);
  assert.equal(workshop.wallet.coins - before.wallet.coins, 1200);
  assert.equal(workshop.inventory.wood - before.inventory.wood, 10);
  assert.equal(workshop.inventory.stone - before.inventory.stone, 8);
  assert.deepEqual(workshop.tutorialOrder, before.tutorialOrder);
});
