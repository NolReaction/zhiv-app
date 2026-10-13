import assert from "node:assert/strict";
import test, { after, beforeEach } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false } });
const identities = await vite.ssrLoadModule("/lib/dev/api-store.ts");
const economy = await vite.ssrLoadModule("/lib/dev/economy-store.ts");
const { economyCatalog, economyCatalogSchema, ECONOMY_MAX_BALANCE } = await vite.ssrLoadModule("/features/economy/domain/model.ts");
const { economyLocalSellPrice: quote, economyLocalSaleMinimumQuantity: minimum, economyLocalSaleLimit: limit } = await vite.ssrLoadModule("/features/economy/domain/local-sale.ts");
const now = Date.parse("2026-10-05T00:00:00Z"), config = economyCatalog.localBuyer;
beforeEach(() => { identities.resetDevStoreForTests(); economy.resetDevEconomyStoreForTests(); });
after(() => vite.close());
const player = () => identities.createDevIdentity("Fisher", crypto.randomUUID());
const read = p => economy.getDevEconomy(p.token, now);
const stored = p => globalThis.__zhivDevEconomyStore.profiles.get(p.me.user.publicId).state;
const command = (p, action, targetId, quantity = 1, totalPrice = 0) => ({ requestId: crypto.randomUUID(), ownerPublicId: p.me.user.publicId,
  expectedRevision: read(p).revision, action, targetId, quantity, totalPrice: totalPrice * 10 });
const issue = (p, action, targetId, quantity = 1, totalPrice = 0) => economy.commandDevEconomy(p.token, command(p, action, targetId, quantity, totalPrice), now);

test("sale discount belongs to the server catalog and older snapshots retain full quotes", () => {
  assert.equal(config.payoutBps, 6000);
  const legacy = structuredClone(economyCatalog); delete legacy.localBuyer;
  assert.equal(economyCatalogSchema.parse(legacy).localBuyer, undefined);
  assert.equal(quote(30, 9), 270); assert.equal(quote(30, 9, config), 160);
  assert.equal(minimum(10), 1); assert.equal(minimum(10, config), 2);
  assert.equal(economyCatalog.fishing.rods.find(rod => rod.id === "river_rod").price, 1800);
  assert.equal(economyCatalog.fishing.rods.find(rod => rod.id === "willow_rod").price, 9000);
});

test("whole-stack flooring cannot be improved by splitting and large quotes retain exact integer arithmetic", () => {
  for (const base of [10, 20, 30, 80, 340, 1800, ECONOMY_MAX_BALANCE]) {
    for (const quantity of [1, 2, 3, 7, 9999, 10_000]) {
      assert.equal(quote(base, quantity, config), Number(BigInt(base / 10) * BigInt(quantity) * 6000n / 10000n) * 10);
      assert.ok(quote(base, quantity, config) >= quantity * quote(base, 1, config));
      for (const split of [0, Math.floor(quantity / 2), quantity])
        assert.ok(quote(base, split, config) + quote(base, quantity - split, config) <= quote(base, quantity, config));
    }
  }
});

test("wallet quantity limits use discounted packet proceeds and exclude zero-revenue sales", () => {
  assert.equal(limit(30, 100, ECONOMY_MAX_BALANCE - 50, config), 3);
  assert.equal(quote(30, 3, config), 50); assert.equal(quote(30, 4, config), 70);
  assert.equal(limit(10, 1, 0, config), 0); assert.equal(limit(10, 2, ECONOMY_MAX_BALANCE - 10, config), 2);
  assert.equal(limit(30, 100, ECONOMY_MAX_BALANCE, config), 0);
  assert.equal(limit(30, 100_000, 0, config), 10_000);
  assert.equal(limit(30, 100, ECONOMY_MAX_BALANCE - 50), 1, "old catalog uses full-price headroom");
});

test("generic sale honors accepted minimum and revision receipt once while Pleska pays full price", () => {
  const p = player(); read(p); stored(p).inventory = { berries: 9, fish: 4 };
  const before = read(p);
  assert.throws(() => issue(p, "sell", "berries", 3, 4), { code: "ECONOMY_SALE_PRICE_CHANGED" });
  assert.deepEqual(read(p), before);
  const sale = command(p, "sell", "berries", 3, 3);
  const accepted = economy.commandDevEconomy(p.token, sale, now);
  assert.equal(accepted.state.wallet.coins, before.wallet.coins + 30); assert.equal(accepted.state.inventory.berries, 6);
  assert.equal(economy.commandDevEconomy(p.token, sale, now).replayed, true);
  assert.equal(read(p).wallet.coins, before.wallet.coins + 30);
  assert.throws(() => economy.commandDevEconomy(p.token, { ...sale, requestId: crypto.randomUUID() }, now), { code: "ECONOMY_REVISION_CONFLICT" });
  assert.equal(issue(p, "sell", "fish", 2).state.wallet.coins, before.wallet.coins + 70, "generic buyer discounts the whole common fish stack");
  assert.equal(issue(p, "sell_fish", "fish", 2).state.wallet.coins, before.wallet.coins + 150, "Pleska pays the full common class price");
});

test("zero-proceeds and wallet-overflow failures are atomic and rounded headroom can be filled exactly", () => {
  const p = player(); read(p); stored(p).inventory = { crumb_bait: 2, berries: 4 };
  const before = read(p);
  assert.throws(() => issue(p, "sell", "crumb_bait"), { code: "ECONOMY_SALE_QUANTITY" });
  assert.deepEqual(read(p), before);
  assert.equal(issue(p, "sell", "crumb_bait", 2, 1).state.wallet.coins, before.wallet.coins + 10);
  stored(p).wallet.coins = ECONOMY_MAX_BALANCE - 30;
  const full = read(p);
  assert.throws(() => issue(p, "sell", "berries", 4), { code: "ECONOMY_CAPACITY" });
  assert.deepEqual(read(p), full);
  assert.equal(issue(p, "sell", "berries", 3, 3).state.wallet.coins, ECONOMY_MAX_BALANCE);
});

test("discount preserves smoking margin against specialist raw-fish value and merchant recovery remains free", () => {
  const smoked = economyCatalog.items.find(item => item.id === "smoked_fish");
  const recipe = economyCatalog.recipes.find(item => item.id === "smoke_fish");
  const commonFishValue = economyCatalog.items.find(item => item.id === "fish_common").baseSellPrice;
  const wood = economyCatalog.items.find(item => item.id === "wood");
  const proceeds = quote(smoked.baseSellPrice, recipe.rewards.smoked_fish, config);
  assert.ok(proceeds > recipe.cost.items.fish_common * commonFishValue + quote(wood.baseSellPrice, recipe.cost.items.wood, config, "wood"),
    "cooking even the highest-value allowed common fish retains a sale margin after the buyer discount");
  for (const recipeId of ["grow_berries", "grow_berries_overnight"]) {
    const recipe = economyCatalog.recipes.find(item => item.id === recipeId);
    assert.deepEqual(recipe.cost, { coins: 0, items: {} });
    assert.ok(quote(30, recipe.rewards.berries, config) > 0);
  }
});


test("first two stages' NPC prices pay one exact unit without discount and their stack limits use the same quote", () => {
  const prices = { berries: 10, strawberries: 40, wood: 30, stone: 40, planks: 40, berry_compote: 30, grilled_fish: 55,
    fiber: 10, rope: 30, clay: 30, charcoal: 50, bricks: 100 };
  assert.deepEqual(config.unitPrices, prices);
  for (const [id, price] of Object.entries(prices)) {
    const base = economyCatalog.items.find(item => item.id === id).baseSellPrice;
    assert.equal(quote(base, 1, config, id), price); assert.equal(quote(base, 3, config, id), price * 3);
    assert.equal(minimum(base, config, id), 1);
    assert.equal(limit(base, 10, ECONOMY_MAX_BALANCE - price * 2, config, id), 2);
    const p = player(); read(p); stored(p).inventory = { [id]: 3 };
    const before = read(p), sold = issue(p, "sell", id, 1).state;
    assert.equal(sold.wallet.coins, before.wallet.coins + price); assert.equal(sold.inventory[id], 2);
    assert.throws(() => issue(p, "sell", id, 1, (price + 10) / 10), { code: "ECONOMY_SALE_PRICE_CHANGED" });
    stored(p).wallet.coins = ECONOMY_MAX_BALANCE - price;
    const nearCap = read(p); assert.throws(() => issue(p, "sell", id, 2), { code: "ECONOMY_CAPACITY" }); assert.deepEqual(read(p), nearCap);
    assert.equal(issue(p, "sell", id, 1).state.wallet.coins, ECONOMY_MAX_BALANCE);
  }
});
