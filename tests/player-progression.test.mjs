import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false } });
after(() => vite.close());
const rules = await vite.ssrLoadModule("/features/economy/domain/rules.ts");
const model = await vite.ssrLoadModule("/features/economy/domain/model.ts");
const progress = await vite.ssrLoadModule("/features/economy/domain/player-progression.ts");
const relations = await vite.ssrLoadModule("/features/economy/domain/trade-relations.ts");
const now = Date.parse("2026-11-01T12:00:00Z");
const fresh = () => rules.newEconomyState({ resources: { sparks: 0, wood: 0, stone: 0 }, houseLevel: 1, workshopLevel: 0 });
const command = (action, targetId) => ({ action, targetId, requestId: crypto.randomUUID(), ownerPublicId: "0123-4567-89AB", expectedRevision: 0, quantity: 1, totalPrice: 0 });
function apply(state, action, targetId, at = now) { return rules.applyEconomyCommand(state, command(action, targetId), at, () => crypto.randomUUID()); }
function order(state, at = now) { progress.awardPlayerProgression(progress.capturePlayerProgression(state), state, command("complete_resident_order", "resident_request"), at); }
function production(state, quantity) {
  const recipe = model.economyCatalog.recipes.find(item => item.id === "make_planks");
  state.jobs.push({ id: crypto.randomUUID(), kind: "production", targetId: recipe.buildingId, recipeId: recipe.id, targetLevel: null,
    startedAt: new Date(now - recipe.seconds * quantity * 1000).toISOString(), finishesAt: new Date(now).toISOString(),
    rewards: Object.fromEntries(Object.entries(recipe.rewards).map(([id, amount]) => [id, amount * quantity])),
    cost: { coins: 0, items: {} }, catalogVersion: 15 });
  apply(state, "claim_job", state.jobs.at(-1).id);
}

test("level curve is monotonic, bounded and reports local progress rather than lifetime taps", () => {
  assert.equal(progress.getPlayerLevel(0).level, 1);
  assert.equal(progress.getPlayerLevel(49).level, 1);
  assert.equal(progress.getPlayerLevel(50).level, 2);
  assert.equal(progress.getPlayerLevel(4050).level, 10);
  assert.equal(progress.getPlayerLevel(490050).level, 100);
  assert.equal(progress.getPlayerLevel(Number.MAX_SAFE_INTEGER).level, 100);
  assert.equal(progress.getPlayerLevelProgress(125).ratio, 0.5);
  assert.equal(progress.PLAYER_LEVELS.length, 100);
  assert.equal(progress.playerProgressionCatalog.levelRewards.reduce((sum, reward) => sum + reward.rewardPearls, 0), 150);
  assert.equal(progress.playerProgressionCatalog.season.milestones.reduce((sum, reward) => sum + reward.rewardPearls, 0), 10);
});

test("completed production gives equal XP for a batch and individual jobs, with only one discovery bonus", () => {
  const batch = fresh(), units = fresh();
  production(batch, 10);
  for (let index = 0; index < 10; index++) production(units, 1);
  assert.equal(batch.progression.player.xp, units.progression.player.xp);
  assert.equal(batch.progression.player.workSeconds, units.progression.player.workSeconds);
  assert.equal(batch.progression.player.xp, batch.progression.player.workSeconds / 60 + 25);
  assert.equal(batch.progression.player.lastAward.source, "production");
  assert.equal(model.economyProgressionSchema.safeParse(batch.progression).success, true);
});

test("construction rewards are given on receipt, never on a repeated receipt", () => {
  const state = fresh();
  const id = crypto.randomUUID();
  state.jobs = [{ id, kind: "construction", targetId: "workshop", targetLevel: 1, recipeId: null,
    startedAt: new Date(now - 60000).toISOString(), finishesAt: new Date(now).toISOString(), rewards: {}, cost: { coins: 0, items: {} }, catalogVersion: 15 }];
  apply(state, "claim_job", id);
  assert.equal(state.progression.player.xp, 100);
  const before = structuredClone(state);
  assert.throws(() => apply(state, "claim_job", id), { code: "ECONOMY_JOB_GONE" });
  assert.deepEqual(state, before);
});

test("purchases, inspections and unconfirmed tutorial opening do not generate experience", () => {
  const state = fresh();
  for (const action of ["buy_fishing_item", "sell", "open_ship_voyage", "claim_tutorial_order", "cancel_production"]) {
    progress.awardPlayerProgression(progress.capturePlayerProgression(state), state, command(action, "any"), now);
    assert.equal(state.progression.player, undefined);
  }
});

test("season awards are one-time, use display pearl denomination and retain badges after month end", () => {
  const state = fresh(), pearls = state.wallet.pearls;
  for (let index = 0; index < 7; index++) order(state);
  assert.equal(state.progression.player.xp, 175);
  assert.equal(state.progression.player.season.points, 105);
  assert.equal(state.wallet.pearls - pearls, 4);
  assert.deepEqual(state.progression.player.season.awardedMilestones, [100]);
  assert.deepEqual(state.progression.player.badges, ["2026-11:helper"]);
  order(state);
  assert.equal(state.wallet.pearls - pearls, 4);
  const december = Date.parse("2026-12-01T00:00:00Z");
  assert.equal(progress.getCooperationSeason(state.progression, december).points, 0);
  order(state, december);
  assert.equal(state.progression.player.season.points, 15);
  assert.equal(state.progression.player.xp, 225);
  assert.ok(state.progression.player.badges.includes("2026-11:helper"));
});

test("a full wallet retains earned pearls and releases them later without duplicate awards", () => {
  const state = fresh(); state.wallet.pearls = model.ECONOMY_MAX_PEARLS;
  for (let index = 0; index < 7; index++) order(state);
  assert.equal(state.progression.player.pendingPearls, 4);
  state.wallet.pearls -= 4;
  progress.awardPlayerProgression(progress.capturePlayerProgression(state), state, command("equip_fishing_rod", "reed_rod"), now);
  assert.equal(state.wallet.pearls, model.ECONOMY_MAX_PEARLS);
  assert.equal(state.progression.player.pendingPearls, 0);
  assert.deepEqual(state.progression.player.season.awardedMilestones, [100]);
});

test("career merge keeps best XP and unions paid rewards without creating currency", () => {
  const first = fresh(), second = fresh();
  for (let index = 0; index < 7; index++) order(first);
  order(second);
  const merged = progress.mergePlayerProgression(first.progression.player, second.progression.player);
  assert.equal(merged.xp, 175);
  assert.equal(merged.season.points, 105);
  assert.deepEqual(merged.season.awardedMilestones, [100]);
  assert.deepEqual(progress.mergePlayerProgression(merged, second.progression.player), merged);
});

test("permanent resident rank bonuses no longer decay between visits", () => {
  const state = fresh();
  state.tradeRelations.reputation.kamneshmyg = 1600;
  assert.equal(relations.tradeRelationBonusBps(state, "kamneshmyg", model.economyCatalog, now), 1000);
  assert.equal(relations.tradeRelationBonusBps(state, "kamneshmyg", model.economyCatalog, now + 365 * 86400000), 1000);
});

test("ship partial loads give no XP; completed cargo and voyage award exactly once", () => {
  const state = fresh();
  Object.assign(state.buildings, { home: 3, warehouse: 10, workshop: 3, kiln: 3, woodlot: 3, quarry: 3, dryer: 3, bridge: 1, lighthouse: 1 });
  apply(state, "open_ship_voyage", "port");
  assert.equal(state.progression.player, undefined);
  const voyage = structuredClone(state.ship.voyage);
  for (const cargo of voyage.orders) for (const [itemId, quantity] of Object.entries(cargo.items)) state.inventory[itemId] = (state.inventory[itemId] ?? 0) + quantity;
  const first = voyage.orders[0], [firstItem, firstAmount] = Object.entries(first.items)[0];
  assert.ok(firstAmount > 1);
  const load = (order, itemId, quantity) => rules.applyEconomyCommand(state, { ...command("load_ship_cargo", order.id),
    voyageId: voyage.id, orderId: order.id, itemId, quantity }, now, () => crypto.randomUUID());
  load(first, firstItem, 1);
  assert.equal(state.progression.player, undefined);
  for (const cargo of voyage.orders) for (const [itemId, quantity] of Object.entries(cargo.items)) {
    const remaining = quantity - (cargo.id === first.id && itemId === firstItem ? 1 : 0);
    if (remaining) load(cargo, itemId, remaining);
  }
  assert.equal(state.progression.player.xp, 180);
  assert.equal(state.progression.player.season.points, 60);
  assert.equal(state.progression.player.lastAward.source, "ship");
  const player = structuredClone(state.progression.player);
  assert.throws(() => load(first, firstItem, 1));
  assert.deepEqual(state.progression.player, player);
});
