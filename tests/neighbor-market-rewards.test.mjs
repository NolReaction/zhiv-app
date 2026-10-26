import assert from "node:assert/strict";
import test, { after, beforeEach } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, logLevel: "silent",
  resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false } });
const identities = await vite.ssrLoadModule("/lib/dev/api-store.ts");
const economy = await vite.ssrLoadModule("/lib/dev/economy-store.ts");
const rewards = await vite.ssrLoadModule("/lib/dev/progression-rewards-store.ts");
const neighbor = await vite.ssrLoadModule("/lib/dev/neighbor-store.ts");
const { neighborDefaultSettings } = await vite.ssrLoadModule("/features/economy/domain/neighbor-model.ts");
const now = Date.parse("2026-10-26T01:00:00Z");
beforeEach(() => identities.resetDevStoreForTests());
after(() => vite.close());
const read = (p, at = now) => economy.getDevEconomy(p.token, at);
const row = p => globalThis.__zhivDevEconomyStore.profiles.get(p.me.user.publicId);
function player(inventory = { wood: 1 }) {
  const p = identities.createDevIdentity("Торговец", crypto.randomUUID()); read(p);
  Object.assign(row(p).state.buildings, { home: 2, bridge: 1, warehouse: 6 });
  row(p).state.inventory = { ...inventory }; row(p).state.wallet.coins = 100000;
  return p;
}
const command = (p, action, targetId, quantity = 1, totalPrice = 0, at = now) => economy.commandDevEconomyMarket(p.token, {
  requestId: crypto.randomUUID(), ownerPublicId: p.me.user.publicId, expectedRevision: read(p, at).revision,
  action, targetId, quantity, totalPrice,
}, at);
const firstSale = (p, at = now) => rewards.getDevProgressionRewards(p.token, at).achievementRewards.find(row => row.achievementId === "first_sale");
const claim = (p, at = now) => rewards.claimDevProgressionReward(p.token, {
  requestId: crypto.randomUUID(), ownerPublicId: p.me.user.publicId, kind: "achievement", achievementId: "first_sale", level: 1,
}, at);

test("Berest first sale pays only its coins and never qualifies the real-player sale medal", () => {
  const p = player({ wood: 3 }), before = read(p), lot = command(p, "create_listing", "wood", 1, 60).listing;
  assert.equal(economy.runDevNeighborTick(now + 180000), 1);
  assert.equal(economy.getDevConfirmedMarketSales(p.me.user.publicId), 0);
  assert.equal(firstSale(p, now + 180001).eligible, false);
  assert.equal(firstSale(p, now + 180001).earnedAt, null);
  assert.throws(() => claim(p, now + 180002), { code: "ACHIEVEMENT_REWARD_UNAVAILABLE" });
  command(p, "claim_sale", lot.id, 1, 0, now + 180003);
  assert.equal(read(p, now + 180004).wallet.coins, before.wallet.coins + 57);
  assert.equal(read(p, now + 180004).wallet.pearls, before.wallet.pearls);
  assert.equal(firstSale(p, now + 180004).earnedAt, null, "a later normal write/read must not award the NPC sale indirectly");
  const next = command(p, "create_listing", "wood", 1, 60, now + 180005).listing;
  assert.equal(economy.runDevNeighborTick(now + 360005), 0, "NPC relief is consumed despite the medal staying unearned");
  const buyer = player({});
  assert.ok(economy.getDevEconomyMarket(buyer.token, {}, now + 360006).listings.some(row => row.id === next.id));
  command(buyer, "buy_listing", next.id, 1, 60, now + 360006);
  assert.equal(firstSale(p, now + 360006).eligible, true, "the later real buyer still qualifies normally");
  assert.equal(claim(p, now + 360006).claim.reward.pearls, 20);
});

test("self-trade cannot create coins, XP or a first-sale achievement", () => {
  const p = player(), lot = command(p, "create_listing", "wood", 1, 30).listing, before = read(p);
  assert.throws(() => command(p, "buy_listing", lot.id, 1, 30), { code: "ECONOMY_MARKET_SELF_TRADE" });
  assert.deepEqual(read(p), before);
  assert.equal(firstSale(p).eligible, false); assert.equal(economy.getDevConfirmedMarketSales(p.me.user.publicId), 0);
});

test("two players cycling one item lose each fee, earn no reputation and claim the sale pearls only once each", () => {
  neighbor.configureDevNeighbor({ ...neighborDefaultSettings, autoBuyEnabled: false });
  const a = player(), b = player({}), initial = [read(a), read(b)], people = [a, b];
  let at = now;
  for (let cycle = 0; cycle < 10; cycle++) for (const [seller, buyer] of [[a, b], [b, a]]) {
    at += 301000;
    const lot = command(seller, "create_listing", "wood", 1, 30, at).listing;
    const shelf = economy.getDevEconomyMarket(buyer.token, {}, at);
    assert.ok(shelf.listings.some(row => row.id === lot.id));
    command(buyer, "buy_listing", lot.id, 1, 30, at);
    command(seller, "claim_sale", lot.id, 1, 0, at);
    if (cycle === 0) assert.equal(claim(seller, at).claim.reward.pearls, 20);
    else assert.throws(() => claim(seller, at), { code: "ACHIEVEMENT_REWARD_CLAIMED" });
  }
  const final = people.map(p => read(p, at));
  assert.equal(final[0].wallet.coins + final[1].wallet.coins, initial[0].wallet.coins + initial[1].wallet.coins - 40);
  assert.equal(final[0].wallet.pearls + final[1].wallet.pearls, initial[0].wallet.pearls + initial[1].wallet.pearls + 40);
  assert.equal(final[0].inventory.wood, 1); assert.equal(final[1].inventory.wood ?? 0, 0);
  for (const [index, p] of people.entries()) {
    assert.deepEqual(final[index].tradeRelations, initial[index].tradeRelations);
    assert.deepEqual(final[index].progression, initial[index].progression);
    assert.equal(final[index].completedExplorations, initial[index].completedExplorations);
    assert.equal(economy.getDevConfirmedMarketSales(p.me.user.publicId), 1);
    const usage = economy.getDevEconomyMarket(p.token, {}, at).tradeBudget;
    assert.equal(usage.buysUsed, 300); assert.equal(usage.salesUsed, 300);
  }
});
