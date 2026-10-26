import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, resolve: { alias: { "@": root } },
  server: { middlewareMode: true, hmr: false, ws: false } });
after(() => vite.close());
const { economyCatalog: catalog } = await vite.ssrLoadModule("/features/economy/domain/model.ts");
const rules = await vite.ssrLoadModule("/features/economy/domain/rules.ts");
const relations = await vite.ssrLoadModule("/features/economy/domain/trade-relations.ts");
const food = await vite.ssrLoadModule("/features/economy/domain/food.ts");
const { orderDifficulty } = await vite.ssrLoadModule("/features/economy/domain/order-difficulty.ts");
const now = Date.parse("2026-10-26T12:00:00Z"), day = 86400000;
const fresh = () => rules.newEconomyState({ resources: { sparks: 0, wood: 0, stone: 0 }, houseLevel: 1, workshopLevel: 0 });

test("new accounts and rank-only imports have no free activity; previews do not refresh it", () => {
  const state = fresh();
  state.tradeRelations.reputation.builder = 1600;
  const before = structuredClone(state);
  assert.equal(relations.tradeRelationProgress(state, "builder", catalog, now).rankBonusBps, 1000);
  assert.equal(relations.tradeRelationBonusBps(state, "builder", catalog, now), 0);
  assert.deepEqual(state, before);
  for (const invalid of [-1, NaN, Infinity, .5]) {
    assert.equal(relations.awardTradeOrderXp(state, "builder", invalid, now), 0);
    assert.deepEqual(state, before, "malformed reward amounts cannot restore support");
  }
});

test("activity retains three full days then decays for seven while earned ranks remain permanent", () => {
  const state = fresh(); state.tradeRelations.reputation.builder = 1600;
  for (let index = 1; index <= 4; index++) {
    relations.awardTradeOrderXp(state, "builder", 10, now);
    assert.equal(relations.tradeActivityBps(state, "builder", catalog, now), index * 2500);
  }
  const before = structuredClone(state);
  for (const [elapsed, bps] of [[0, 10000], [3, 10000], [6.5, 5000], [10, 0], [365, 0]]) {
    const progress = relations.tradeRelationProgress(state, "builder", catalog, now + elapsed * day);
    assert.equal(progress.activityBps, bps); assert.equal(progress.bonusBps, bps / 10);
    assert.equal(progress.xp, 1640); assert.equal(progress.rankIndex, 4);
  }
  assert.deepEqual(state, before);
});

test("real help restores activity after daily XP is exhausted while purchases and clock rollback do not", () => {
  const state = fresh(), at = now + 10 * day;
  state.tradeRelations.reputation.builder = 1600;
  state.tradeRelations.activity.builder = { pointsBps: 10000, updatedAt: new Date(now).toISOString() };
  state.tradeRelations.dailyCycle = Math.floor(at / day);
  state.tradeRelations.dailyOrderXp.builder = catalog.tradeRelations.dailyOrderXpCap;
  assert.equal(relations.awardTradeOrderXp(state, "builder", 20, at), 0);
  assert.equal(relations.tradeActivityBps(state, "builder", catalog, at), 2500);
  assert.equal(state.tradeRelations.reputation.builder, 1600);
  const saved = structuredClone(state.tradeRelations.activity);
  relations.awardTradePurchaseXp(state, "plesk", at);
  assert.deepEqual(state.tradeRelations.activity, saved);
  relations.awardTradeOrderXp(state, "builder", 20, at - day);
  assert.deepEqual(state.tradeRelations.activity, saved);
  for (let index = 0; index < 3; index++) relations.awardTradeOrderXp(state, "builder", 20, at);
  assert.equal(relations.tradeActivityBps(state, "builder", catalog, at), 10000);
});

test("a rejected or repeated delivery cannot recharge support without consuming its actual basket", () => {
  const state = fresh();
  state.inventory = {};
  const offer = food.residentOrderBoard(state, now).offers.find(offer => offer.residentId === "builder");
  const command = { requestId: crypto.randomUUID(), ownerPublicId: "0123-4567-89AB", expectedRevision: 0,
    action: "complete_resident_order", targetId: offer.id, quantity: 1, totalPrice: 0 };
  const run = () => rules.applyEconomyCommand(state, command, now, () => crypto.randomUUID());
  assert.throws(run, { code: "ECONOMY_RESOURCES" });
  assert.deepEqual(state.tradeRelations.activity, {});
  state.inventory = { ...offer.items }; run();
  assert.equal(relations.tradeActivityBps(state, "builder", catalog, now), 2500);
  assert.throws(run, { code: "ECONOMY_ORDER_CHANGED" });
  assert.equal(relations.tradeActivityBps(state, "builder", catalog, now), 2500);
});

test("legacy local activity is anchored once and a fresh empty map never becomes a compatibility grant", () => {
  const state = fresh(); state.tradeRelations.reputation.builder = 800;
  relations.migrateTradeActivity(state, now);
  assert.deepEqual(state.tradeRelations.activity, {});
  delete state.tradeRelations.activity;
  relations.migrateTradeActivity(state, now);
  assert.equal(relations.tradeActivityBps(state, "builder", catalog, now), 10000);
  const saved = structuredClone(state.tradeRelations.activity);
  relations.migrateTradeActivity(state, now + 30 * day);
  assert.deepEqual(state.tradeRelations.activity, saved);
  assert.equal(relations.tradeActivityBps(state, "builder", catalog, now + 30 * day), 0);
});

test("weekly tiers expose choice and pay only their frozen final pearl reward", () => {
  assert.deepEqual([1799, 1800, 7199, 7200].map(seconds => orderDifficulty(seconds)), ["ordinary", "challenging", "challenging", "masterful"]);
  assert.deepEqual([10799, 10800, 35999, 36000].map(seconds => orderDifficulty(seconds, true)), ["ordinary", "challenging", "challenging", "masterful"]);
  const state = fresh();
  state.buildings = Object.fromEntries(catalog.buildings.map(building => [building.id, building.levels.at(-1).level]));
  state.progression.recipes = Object.fromEntries(catalog.recipes.map(recipe => [recipe.id, 100]));
  state.fishing.ownedRods = catalog.fishing.rods.map(rod => rod.id); state.fishing.ownedHooks = catalog.fishing.hooks.map(hook => hook.id);
  const choices = relations.weeklyOrderBoard(state, now).offers;
  const key = choice => `${choice.residentId}:${orderDifficulty(choice.effortSeconds, true)}`;
  assert.equal(new Set(choices.map(key)).size, choices.length);
  assert(new Set(choices.map(choice => orderDifficulty(choice.effortSeconds, true))).size === 3);
  for (const choice of choices) {
    const raw = { ordinary: 40, challenging: 80, masterful: 140 }[orderDifficulty(choice.effortSeconds, true)];
    assert.equal(choice.pearls, raw); assert.deepEqual(choice.stages.map(stage => stage.pearls), [0, 0, raw]);
  }
});
