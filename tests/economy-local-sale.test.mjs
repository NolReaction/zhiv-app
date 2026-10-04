import assert from "node:assert/strict";
import test, { after, beforeEach } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false } });
const identities = await vite.ssrLoadModule("/lib/dev/api-store.ts");
const economy = await vite.ssrLoadModule("/lib/dev/economy-store.ts");
const { economyCatalog, economyCatalogSchema, ECONOMY_MAX_BALANCE } = await vite.ssrLoadModule("/features/economy/model.ts");
const { economyLocalSellPrice: quote, economyLocalSaleMinimumQuantity: minimum, economyLocalSaleLimit: limit } = await vite.ssrLoadModule("/features/economy/local-sale.ts");
const now = Date.parse("2026-10-05T00:00:00Z"), config = economyCatalog.localBuyer;
beforeEach(() => { identities.resetDevStoreForTests(); economy.resetDevEconomyStoreForTests(); });
after(() => vite.close());
const player = () => identities.createDevIdentity("Fisher", crypto.randomUUID());
const read = p => economy.getDevEconomy(p.token, now);
const stored = p => globalThis.__zhivDevEconomyStore.profiles.get(p.me.user.publicId).state;
const command = (p, action, targetId, quantity = 1, totalPrice = 0) => ({ requestId: crypto.randomUUID(), ownerPublicId: p.me.user.publicId,
  expectedRevision: read(p).revision, action, targetId, quantity, totalPrice });
const issue = (p, action, targetId, quantity = 1, totalPrice = 0) => economy.commandDevEconomy(p.token, command(p, action, targetId, quantity, totalPrice), now);

test("sale discount belongs to the server catalog and older snapshots retain full quotes", () => {
  assert.equal(config.payoutBps, 6000);
  const legacy = structuredClone(economyCatalog); delete legacy.localBuyer;
  assert.equal(economyCatalogSchema.parse(legacy).localBuyer, undefined);
  assert.equal(quote(3, 9), 27); assert.equal(quote(3, 9, config), 16);
  assert.equal(minimum(1), 1); assert.equal(minimum(1, config), 2);
  assert.equal(economyCatalog.fishing.rods.find(rod => rod.id === "river_rod").price, 1800);
  assert.equal(economyCatalog.fishing.rods.find(rod => rod.id === "willow_rod").price, 7200);
});

test("whole-stack flooring cannot be improved by splitting and large quotes retain exact integer arithmetic", () => {
  for (const base of [1, 2, 3, 8, 34, 180, ECONOMY_MAX_BALANCE]) {
    for (const quantity of [1, 2, 3, 7, 9999, 10_000]) {
      assert.equal(quote(base, quantity, config), Number(BigInt(base) * BigInt(quantity) * 6000n / 10000n));
      assert.ok(quote(base, quantity, config) >= quantity * quote(base, 1, config));
      for (const split of [0, Math.floor(quantity / 2), quantity])
        assert.ok(quote(base, split, config) + quote(base, quantity - split, config) <= quote(base, quantity, config));
    }
  }
});

test("wallet quantity limits use discounted packet proceeds and exclude zero-revenue sales", () => {
  assert.equal(limit(3, 100, ECONOMY_MAX_BALANCE - 5, config), 3);
  assert.equal(quote(3, 3, config), 5); assert.equal(quote(3, 4, config), 7);
  assert.equal(limit(1, 1, 0, config), 0); assert.equal(limit(1, 2, ECONOMY_MAX_BALANCE - 1, config), 2);
  assert.equal(limit(3, 100, ECONOMY_MAX_BALANCE, config), 0);
  assert.equal(limit(3, 100_000, 0, config), 10_000);
  assert.equal(limit(3, 100, ECONOMY_MAX_BALANCE - 5), 1, "old catalog uses full-price headroom");
});

test("generic sale honors accepted minimum and revision receipt once while Pleska pays full price", () => {
  const p = player(); read(p); stored(p).inventory = { berries: 9, fish: 4 };
  const before = read(p);
  assert.throws(() => issue(p, "sell", "berries", 3, 6), { code: "ECONOMY_SALE_PRICE_CHANGED" });
  assert.deepEqual(read(p), before);
  const sale = command(p, "sell", "berries", 3, 5);
  const accepted = economy.commandDevEconomy(p.token, sale, now);
  assert.equal(accepted.state.wallet.coins, 5); assert.equal(accepted.state.inventory.berries, 6);
  assert.equal(economy.commandDevEconomy(p.token, sale, now).replayed, true);
  assert.equal(read(p).wallet.coins, 5);
  assert.throws(() => economy.commandDevEconomy(p.token, { ...sale, requestId: crypto.randomUUID() }, now), { code: "ECONOMY_REVISION_CONFLICT" });
  assert.equal(issue(p, "sell", "fish", 2).state.wallet.coins, 14, "generic fish payout floors 16 * 60% to 9");
  assert.equal(issue(p, "sell_fish", "fish", 2).state.wallet.coins, 30, "Pleska pays all 16 coins");
});

test("zero-proceeds and wallet-overflow failures are atomic and rounded headroom can be filled exactly", () => {
  const p = player(); read(p); stored(p).inventory = { crumb_bait: 2, berries: 4 };
  const before = read(p);
  assert.throws(() => issue(p, "sell", "crumb_bait"), { code: "ECONOMY_SALE_QUANTITY" });
  assert.deepEqual(read(p), before);
  assert.equal(issue(p, "sell", "crumb_bait", 2, 1).state.wallet.coins, 1);
  stored(p).wallet.coins = ECONOMY_MAX_BALANCE - 5;
  const full = read(p);
  assert.throws(() => issue(p, "sell", "berries", 4), { code: "ECONOMY_CAPACITY" });
  assert.deepEqual(read(p), full);
  assert.equal(issue(p, "sell", "berries", 3, 5).state.wallet.coins, ECONOMY_MAX_BALANCE);
});

test("discount preserves smoking margin against specialist raw-fish value and merchant recovery remains free", () => {
  const smoked = economyCatalog.items.find(item => item.id === "smoked_fish");
  assert.equal(smoked.baseSellPrice, 34);
  assert.equal(quote(smoked.baseSellPrice, 1, config), 20);
  assert.ok(20 > 2 * 8 + quote(4, 1, config));
  for (const recipeId of ["grow_berries", "grow_berries_overnight"]) {
    const recipe = economyCatalog.recipes.find(item => item.id === recipeId);
    assert.deepEqual(recipe.cost, { coins: 0, items: {} });
    assert.ok(quote(3, recipe.rewards.berries, config) > 0);
  }
});
