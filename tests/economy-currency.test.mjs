import assert from "node:assert/strict";
import test, { after, beforeEach } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, resolve: { alias: { "@": root } },
  server: { middlewareMode: true, hmr: false, ws: false } });
const money = await vite.ssrLoadModule("/features/economy/domain/money.ts");
const model = await vite.ssrLoadModule("/features/economy/domain/model.ts");
const rules = await vite.ssrLoadModule("/features/economy/domain/rules.ts");
const sale = await vite.ssrLoadModule("/features/economy/domain/local-sale.ts");
const ids = await vite.ssrLoadModule("/lib/dev/api-store.ts");
const economy = await vite.ssrLoadModule("/lib/dev/economy-store.ts");
const rewards = await vite.ssrLoadModule("/lib/dev/progression-rewards-store.ts");
const rewardRules = await vite.ssrLoadModule("/features/game/progression-rewards.ts");
beforeEach(() => ids.resetDevStoreForTests());
after(() => vite.close());
const player = () => ids.createDevIdentity("Мохлик", crypto.randomUUID());
const currentState = p => { economy.getDevEconomy(p.token); return globalThis.__zhivDevEconomyStore.profiles.get(p.me.user.publicId); };
const request = (p, action, targetId, revision, totalPrice = 0, quantity = 1) => ({ requestId: crypto.randomUUID(), ownerPublicId: p.me.user.publicId,
  expectedRevision: revision, action, targetId, totalPrice, quantity });

function legacyState() {
  const p = player(), state = structuredClone(currentState(p).state);
  delete state.currencyScale; delete state.pearlScale;
  state.wallet = { coins: 123, pearls: 4 }; state.migration.coinsGranted = 7;
  state.jobs = [{ id: crypto.randomUUID(), kind: "construction", targetId: "home", targetLevel: 2, recipeId: null,
    startedAt: "2026-10-01T00:00:00.000Z", finishesAt: "2026-10-05T00:00:00.000Z", cost: { coins: 150, items: { wood: 20 } }, rewards: {}, catalogVersion: 2 }];
  return state;
}

test("denomination is one guarded conversion of money, with materials clocks jobs and progress preserved", () => {
  const legacy = legacyState(), frozen = structuredClone(legacy), nominal = money.redenominateEconomyState(legacy);
  assert.deepEqual(legacy, frozen, "the conversion does not partially mutate the input");
  assert.equal(nominal.currencyScale, 10); assert.deepEqual(nominal.wallet, { coins: 1230, pearls: 200 });
  assert.equal(nominal.migration.coinsGranted, 70); assert.equal(nominal.jobs[0].cost.coins, 1500);
  for (const field of ["inventory", "buildings", "progression", "fishing", "completedExplorations"]) assert.deepEqual(nominal[field], legacy[field]);
  assert.deepEqual({ ...nominal.jobs[0], cost: legacy.jobs[0].cost }, legacy.jobs[0]);
  assert.deepEqual(money.redenominateEconomyState(nominal), nominal, "loading twice cannot multiply again");
  assert.equal(money.nominalEconomyMoney(-3, 1), -30); assert.equal(money.nominalEconomyMoney(-30, 10), -30);
  assert.throws(() => money.nominalEconomyMoney(10, 2));
});

test("whole-stack NPC rounding and minimum quantities are exactly old proceeds times ten", () => {
  for (const base of [1, 2, 3, 4, 8, 12, 64]) for (const quantity of [1, 2, 3, 9, 10, 99, 10000]) for (const rate of [1, 6000, 10000]) {
    assert.equal(sale.economyLocalSellPrice(base * 10, quantity, { payoutBps: rate }), Math.floor(base * quantity * rate / 10000) * 10);
    assert.equal(sale.economyLocalSaleMinimumQuantity(base * 10, { payoutBps: rate }), Math.max(1, Math.ceil(10000 / (base * rate))));
  }
  assert.equal(sale.economyLocalSellPrice(30, 1, { payoutBps: 6000 }), 10, "one berry still floors1.8 retired coins before converting");
  assert.equal(sale.economyLocalSellPrice(30, 5, { payoutBps: 6000 }), 90);
  assert.equal(sale.economyLocalSaleLimit(30, 99, money.ECONOMY_MAX_BALANCE - 20, { payoutBps: 6000 }), 1);
});

test("construction keeps the full-duration denomination while charging smaller time steps", () => {
  const now = Date.parse("2026-10-05T12:00:00Z"), interval = model.economyCatalog.constructionSpeedup.secondsPerPearl * 1000;
  assert.equal(interval, 300000);
  for (const remaining of [0, 1, interval - 1, interval, interval + 1, 8 * 3600000, 72 * 3600000]) {
    assert.equal(rules.constructionSpeedupPrice({ kind: "construction", finishesAt: new Date(now + remaining).toISOString() }, now), Math.ceil(remaining * 50 / interval / 2) * 2);
  }
});

test("wallet limit and existing prices scale while item limits and legacy conversion head start stay equivalent", () => {
  assert.equal(model.ECONOMY_MAX_PEARLS, 50_000_000_000); assert.equal(model.ECONOMY_MAX_BALANCE, 10_000_000_000); assert.equal(model.ECONOMY_MAX_ITEMS, 1_000_000_000);
  for (const [id, base] of Object.entries({ berries: 3, wood: 4, stone: 3, fiber: 2, fish: 8 }))
    assert.equal(model.economyCatalog.items.find(item => item.id === id).baseSellPrice, base * 10);
  assert.equal(model.economyCatalog.buildings.find(item => item.id === "home").levels[1].cost.coins, 1500);
  assert.deepEqual(rules.convertLegacyEconomy({ sparks: 1_000_000, wood: 100, stone: 400 }), { version: 1, coinsGranted: 5000, woodGranted: 10, stoneGranted: 20 });
  const p = player(), view = economy.getDevEconomy(p.token); view.wallet.coins = model.ECONOMY_MAX_BALANCE;
  assert.equal(model.economyViewSchema.safeParse(view).success, true);
  view.inventory.wood = model.ECONOMY_MAX_ITEMS + 1; assert.equal(model.economyViewSchema.safeParse(view).success, false);
  assert.equal(rewardRules.progressionRewardsCatalog.pearlScale, 50);
  assert.equal(Object.values(rewardRules.progressionRewardsCatalog.achievementPearls).flat().reduce((a, b) => a + b), 2150);
});

test("DEV HMR upgrades old profiles and live offers once, retaining historical offer units", () => {
  const p = player(), row = currentState(p), old = legacyState(); row.state = old; row.revision = 7;
  const now = Date.now();
  const listing = status => ({ id: crypto.randomUUID(), sellerPublicId: p.me.user.publicId, itemId: "wood", quantity: 1,
    totalPrice: 4, status, createdAt: new Date(now).toISOString(), closedAt: status === "active" ? null : new Date(now).toISOString() });
  const active = listing("active"), closed = listing("sold");
  globalThis.__zhivDevEconomyStore.listings.set(active.id, active); globalThis.__zhivDevEconomyStore.listings.set(closed.id, closed);
  const first = economy.getDevEconomy(p.token, now), second = economy.getDevEconomy(p.token, now);
  assert.equal(first.revision, 8); assert.equal(second.revision, 8); assert.deepEqual(first.wallet, { coins: 1230, pearls: 200 });
  assert.equal(active.totalPrice, 40); assert.equal(active.currencyScale, 10);
  assert.equal(closed.totalPrice, 4); assert.equal(closed.currencyScale, 1, "closed historical prices stay raw");
});

test("a pre-change ordinary receipt still replays its original body without another debit", () => {
  const p = player(), row = currentState(p); row.state = legacyState(); row.revision = 7;
  const command = request(p, "start_construction", "home", 6), signature = JSON.stringify([command.ownerPublicId, command.expectedRevision,
    command.action, command.targetId, command.quantity, command.totalPrice]);
  row.receipts.set(command.requestId, { signature, message: "Строительство начато", acceptedRevision: 7 });
  const replay = economy.commandDevEconomy(p.token, command);
  assert.equal(replay.replayed, true); assert.equal(replay.acceptedRevision, 7); assert.equal(replay.state.revision, 8);
  assert.equal(replay.state.wallet.coins, 1230); assert.equal(replay.state.jobs.length, 1);
  assert.equal(row.receipts.get(command.requestId).signature, signature);
});

test("pre-change paid gift is projected in current units and stays consumed without another credit", () => {
  const p = player(), owner = p.me.user.publicId, now = Date.parse("2026-10-05T12:00:00Z");
  rewards.getDevProgressionRewards(p.token, now); const economyRow = currentState(p), state = legacyState();
  state.wallet = { coins: 20, pearls: 2 }; economyRow.state = state; economyRow.revision = 1;
  const command = { requestId: crypto.randomUUID(), ownerPublicId: owner, kind: "daily" }, signature = JSON.stringify(command);
  const claimedAt = "2026-10-04T12:00:00.000Z", original = { kind: "daily", step: 7, reward: { coins: 0, pearls: 2, items: {} }, claimedAt };
  const rewardRow = globalThis.__zhivDevProgressionRewards.get(owner);
  rewardRow.daily = { step: 1, lastClaimAt: claimedAt, lastClaimDate: "2026-10-04" };
  rewardRow.receipts.set(command.requestId, { signature, claim: original, acceptedRevision: 1 });
  const first = rewards.claimDevProgressionReward(p.token, command, now), second = rewards.claimDevProgressionReward(p.token, command, now);
  assert.equal(first.replayed, true); assert.equal(first.claim.reward.pearls, 100); assert.equal(first.claim.claimedAt, claimedAt);
  assert.equal(first.economy.wallet.pearls, 100); assert.deepEqual(second.economy.wallet, first.economy.wallet);
  assert.equal(first.acceptedRevision, 1); assert.equal(rewardRow.receipts.get(command.requestId).claim.reward.pearls, 2);
});

test("new market offers keep old price quantum and failed fractional-price orders leave escrow untouched", () => {
  const p = player(), row = currentState(p); row.state.buildings.home = 2; row.state.completedExplorations = 1; row.state.inventory.wood = 4;
  const revision = row.revision, command = request(p, "create_listing", "wood", revision, 41);
  assert.throws(() => economy.commandDevEconomyMarket(p.token, command), { code: "ECONOMY_MARKET_PRICE" });
  assert.equal(row.state.inventory.wood, 4); assert.equal(row.revision, revision);
  const result = economy.commandDevEconomyMarket(p.token, { ...command, totalPrice: 40 });
  assert.equal(result.listing.totalPrice, 40); assert.equal(result.state.storage.reserved, 1);
});


test("V40 snapshots multiply only pearls and preserve the full previous pearl balance capacity", () => {
  const old = legacyState(); old.currencyScale = 10; old.wallet = { coins: 1230, pearls: 10_000_000_000 };
  old.migration.coinsGranted = 70; old.jobs[0].cost.coins = 1500;
  const upgraded = money.redenominateEconomyState(old);
  assert.equal(upgraded.pearlScale, 50); assert.equal(upgraded.currencyScale, 10);
  assert.deepEqual(upgraded.wallet, { coins: 1230, pearls: 50_000_000_000 });
  assert.equal(upgraded.migration.coinsGranted, 70); assert.equal(upgraded.jobs[0].cost.coins, 1500);
  assert.strictEqual(money.redenominateEconomyState(upgraded), upgraded);
  for (const [value, scale] of [[2, 1], [20, 10], [100, 50]]) assert.equal(money.nominalEconomyPearls(value, scale), 100);
  assert.throws(() => money.nominalEconomyPearls(10, 5));
  assert.throws(() => money.nominalEconomyMoney(10, 50));
});

test("a V40 gift receipt keeps its original units while current pearls project by five once", () => {
  const p = player(), owner = p.me.user.publicId, now = Date.parse("2026-10-05T12:00:00Z");
  rewards.getDevProgressionRewards(p.token, now);
  const economyRow = currentState(p); economyRow.state.wallet = { coins: 500, pearls: 20 };
  economyRow.state.currencyScale = 10; delete economyRow.state.pearlScale;
  const command = { requestId: crypto.randomUUID(), ownerPublicId: owner, kind: "daily" };
  const original = { kind: "daily", step: 7, reward: { coins: 300, pearls: 20, items: { wood: 2 } }, claimedAt: "2026-10-04T12:00:00.000Z" };
  const rewardRow = globalThis.__zhivDevProgressionRewards.get(owner);
  rewardRow.receipts.set(command.requestId, { signature: JSON.stringify(command), claim: original, acceptedRevision: 0, currencyScale: 10 });
  const first = rewards.claimDevProgressionReward(p.token, command, now), second = rewards.claimDevProgressionReward(p.token, command, now);
  assert.deepEqual(first.claim.reward, { coins: 300, pearls: 100, items: { wood: 2 } });
  assert.deepEqual(first.economy.wallet, { coins: 500, pearls: 100 });
  assert.deepEqual(second.economy.wallet, first.economy.wallet);
  assert.equal(rewardRow.receipts.get(command.requestId).claim.reward.pearls, 20);
});


test("halved pearl presentation preserves odd balances, signed deltas and purchasing power", () => {
  assert.equal(money.ECONOMY_PEARL_SCALE, 50, "stored amounts and receipts keep their denomination");
  assert.equal(money.pearlDisplayAmount(1), 0.5);
  assert.equal(money.formatPearls(1), "0,5");
  assert.equal(money.formatPearls(-3), "-1,5");
  const costs = [1, 50, model.economyCatalog.fishing.shop.refreshPricePearls,
    ...model.economyCatalog.productionSlots.upgrades.map(tier => tier.pricePearls)];
  for (const balance of [0, 1, 99, 100, 1499, 1500, 6501, money.ECONOMY_MAX_PEARLS]) {
    for (const cost of costs) {
      const shown = money.pearlDisplayAmount(balance), shownCost = money.pearlDisplayAmount(cost);
      assert.equal(shown >= shownCost, balance >= cost);
      assert.equal(Math.floor(shown / shownCost), Math.floor(balance / cost));
      assert.equal(money.pearlDisplayAmount(balance - cost), shown - shownCost);
    }
  }
  const original = legacyState(), frozen = structuredClone(original);
  const normalized = money.redenominateEconomyState(original);
  const saved = structuredClone(normalized);
  assert.equal(money.formatPearls(normalized.wallet.pearls), "100");
  money.formatPearls(normalized.wallet.pearls);
  assert.deepEqual(normalized, saved, "rendering neither mutates saved money nor converts it twice");
  assert.deepEqual(original, frozen);
});
