import assert from "node:assert/strict";
import test, { after, beforeEach } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false } });
const identities = await vite.ssrLoadModule("/lib/dev/api-store.ts");
const economy = await vite.ssrLoadModule("/lib/dev/economy-store.ts");
const model = await vite.ssrLoadModule("/features/economy/model.ts");
const { fishingTripCost, fishingWeights, fishingOdds, selectFishingCatch } = await vite.ssrLoadModule("/features/economy/fishing.ts");
const now = Date.parse("2026-10-04T20:00:00Z");
beforeEach(() => { identities.resetDevStoreForTests(); economy.resetDevEconomyStoreForTests(); });
after(() => vite.close());
const player = () => identities.createDevIdentity("Fisher", crypto.randomUUID());
const read = (p, at = now) => economy.getDevEconomy(p.token, at);
const stored = p => globalThis.__zhivDevEconomyStore.profiles.get(p.me.user.publicId).state;
const command = (p, action, targetId, extra = {}, at = now) => ({ requestId: crypto.randomUUID(), ownerPublicId: p.me.user.publicId,
  expectedRevision: read(p, at).revision, action, targetId, quantity: 1, totalPrice: 0, ...extra });
const issue = (p, action, targetId, extra = {}, at = now) => economy.commandDevEconomy(p.token, command(p, action, targetId, extra, at), at).state;
const fund = p => { read(p); stored(p).wallet.coins = 100_000; };

test("old snapshots and profiles receive a free starter rod, never retroactive catch records", () => {
  const p = player(), snapshot = read(p);
  const old = structuredClone(snapshot); delete old.fishing; delete old.catalog.fishing;
  const parsed = model.economyViewSchema.parse(old);
  assert.deepEqual(parsed.fishing, { ownedRods: ["reed_rod"], equippedRodId: "reed_rod", ownedHooks: ["bare_hook"], equippedHookId: "bare_hook", equippedBaitId: null, catches: {} });
  assert.equal(parsed.catalog.fishing, undefined);
  delete stored(p).fishing; stored(p).inventory.fish = 50;
  assert.deepEqual(read(p).fishing, parsed.fishing);
});

test("Pleska catalog has no buy-sell arbitrage and upgrades visibly improve uncommon catch odds", () => {
  const config = model.economyCatalog.fishing;
  for (const fish of config.fish) assert.ok(fish.buyPrice > model.economyCatalog.items.find(item => item.id === fish.itemId).baseSellPrice);
  for (const bait of config.baits) assert.ok(bait.price > model.economyCatalog.items.find(item => item.id === bait.itemId).baseSellPrice);
  const base = fishingWeights("reed_rod", null), upgraded = fishingWeights("willow_rod", "worm_bait");
  const chance = weights => weights.find(fish => fish.itemId === "fish_mooncarp").weight / weights.reduce((total, fish) => total + fish.weight, 0);
  assert.ok(chance(upgraded) > chance(base));
  assert.equal(base.reduce((sum, fish) => sum + fish.weight, 0), 10000);
  // Same UUID vectors are asserted in Kotlin to keep weighted drawing identical.
  assert.deepEqual(["00000000-0000-4000-8000-000000000001", "a2f6bce4-1d99-4c0f-a910-656320724833", "ffffffff-ffff-4fff-bfff-ffffffffffff"]
    .map(id => selectFishingCatch(id, "willow_rod", "worm_bait")), ["fish_rudd", "fish_silverfin", "fish"]);
});

test("changing rods cannot turn a completed random draw into a better fish by downgrading", () => {
  const config = model.economyCatalog.fishing, rank = id => config.fish.findIndex(fish => fish.itemId === id);
  // Includes the old modulo selector's counterexample and many independent seeds.
  const seeds = ["00000000-0000-4000-8000-000000000038", ...Array.from({ length: 1000 }, (_, index) => `00000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`)];
  for (const seed of seeds) for (const bait of [null, "crumb_bait", "worm_bait"]) {
    const ranks = config.rods.map(rod => rank(selectFishingCatch(seed, rod.id, bait)));
    assert.ok(ranks[0] <= ranks[1] && ranks[1] <= ranks[2], `${seed}: stronger tackle must preserve or improve the fish`);
  }
});

test("purchases charge authoritative prices once, durable rods are unique and buying fish never opens collection", () => {
  const p = player(); fund(p);
  const buy = command(p, "buy_fishing_item", "river_rod", { totalPrice: 18050 });
  const result = economy.commandDevEconomy(p.token, buy, now);
  assert.equal(result.state.wallet.coins, 82000);
  assert.deepEqual(result.state.fishing.ownedRods, ["reed_rod", "river_rod"]);
  assert.equal(result.state.storage.used, 0, "durable rods are not warehouse stacks");
  assert.equal(economy.commandDevEconomy(p.token, buy, now).replayed, true);
  assert.throws(() => issue(p, "buy_fishing_item", "river_rod", { totalPrice: 18000 }), { code: "ECONOMY_FISHING_OWNED" });
  const bought = issue(p, "buy_fishing_item", "fish_mooncarp", { quantity: 2, totalPrice: 1280 });
  assert.equal(bought.inventory.fish_mooncarp, 2);
  assert.deepEqual(bought.fishing.catches, {});
  const sold = issue(p, "sell_fish", "fish_mooncarp", { quantity: 2 });
  assert.equal(sold.wallet.coins, 81360);
  assert.deepEqual(sold.fishing.catches, {});
});

test("stale quotes, unsupported items, bulk rods, full escrow storage and insufficient coins leave snapshots unchanged", () => {
  const p = player(); fund(p);
  const before = read(p);
  for (const [target, extra, code] of [["river_rod", { totalPrice: 17990 }, "ECONOMY_FISHING_PRICE_CHANGED"],
    ["wood", { totalPrice: 1000 }, "ECONOMY_FISHING_ITEM"], ["river_rod", { quantity: 2, totalPrice: 36000 }, "INVALID_ECONOMY_COMMAND"],
    ["crumb_bait", { quantity: 11, totalPrice: 330 }, "INVALID_ECONOMY_COMMAND"]]) {
    assert.throws(() => issue(p, "buy_fishing_item", target, extra), { code });
    assert.deepEqual(read(p), before);
  }
  stored(p).inventory.wood = 190;
  const owner = p.me.user.publicId, id = crypto.randomUUID();
  globalThis.__zhivDevEconomyStore.listings.set(id, { id, sellerPublicId: owner, itemId: "stone", quantity: 10, totalPrice: 10,
    status: "active", createdAt: new Date(now).toISOString(), closedAt: null });
  const full = read(p);
  assert.throws(() => issue(p, "buy_fishing_item", "crumb_bait", { totalPrice: 30 }), { code: "ECONOMY_STORAGE_FULL" });
  assert.deepEqual(read(p), full);
  assert.equal(issue(p, "buy_fishing_item", "river_rod", { totalPrice: 18000 }).storage.available, 0, "a rod does not consume storage");
  stored(p).wallet.coins = 0;
  const poor = read(p);
  assert.throws(() => issue(p, "buy_fishing_item", "willow_rod", { totalPrice: 72000 }), { code: "ECONOMY_RESOURCES" });
  assert.deepEqual(read(p), poor);
});

test("loadout is validated, fishing spends one bait and locks catch before later equipment changes", () => {
  const p = player(); fund(p);
  assert.throws(() => issue(p, "equip_fishing_rod", "willow_rod"), { code: "ECONOMY_FISHING_ROD" });
  assert.throws(() => issue(p, "equip_fishing_bait", "worm_bait"), { code: "ECONOMY_RESOURCES" });
  issue(p, "buy_fishing_item", "river_rod", { totalPrice: 18000 }); issue(p, "equip_fishing_rod", "river_rod");
  issue(p, "buy_fishing_item", "worm_bait", { quantity: 2, totalPrice: 140 }); issue(p, "equip_fishing_bait", "worm_bait");
  assert.deepEqual(fishingTripCost({ coins: 0, items: {} }, read(p)), { coins: 0, items: { worm_bait: 1 } });
  assert.throws(() => issue(p, "start_fishing", "forest"), { code: "ECONOMY_FISHING_ROUTE" });
  const start = command(p, "start_fishing", "shore");
  const active = economy.commandDevEconomy(p.token, start, now).state, job = active.jobs[0];
  assert.notEqual(job.id, start.requestId, "client request IDs cannot choose the draw");
  assert.equal(active.inventory.worm_bait, 1);
  assert.equal(job.fishing.rodId, "river_rod"); assert.equal(job.fishing.baitId, "worm_bait");
  assert.equal(Object.values(job.rewards).reduce((a, b) => a + b, 0), 4, "species replaces one original fish");
  assert.equal(active.fishingCastSeed, undefined, "internal draw state is not a public field");
  assert.notEqual(stored(p).fishingCastSeed, job.id, "the public job UUID does not reveal the draw seed");
  const replay = economy.commandDevEconomy(p.token, start, now);
  assert.equal(replay.replayed, true); assert.deepEqual(replay.state.jobs, [job]);
  issue(p, "equip_fishing_rod", "reed_rod"); issue(p, "equip_fishing_bait", "none");
  assert.deepEqual(read(p).jobs[0], job);
  const claimed = issue(p, "claim_job", job.id, {}, Date.parse(job.finishesAt));
  for (const [id, quantity] of Object.entries(job.rewards)) assert.equal(claimed.fishing.catches[id], quantity);
  assert.equal(stored(p).fishingCastSeed, null);
  issue(p, "sell_fish", "fish", { quantity: job.rewards.fish }, Date.parse(job.finishesAt));
  assert.deepEqual(read(p).fishing.catches, claimed.fishing.catches);
});

test("cancel and retry retain a draw, forfeit bait and never create collection or permit free rerolls", () => {
  const p = player(); fund(p);
  issue(p, "buy_fishing_item", "crumb_bait", { totalPrice: 30 }); issue(p, "equip_fishing_bait", "crumb_bait");
  const first = issue(p, "start_fishing", "shore").jobs[0];
  issue(p, "cancel_exploration", first.id);
  assert.deepEqual(read(p).fishing.catches, {}); assert.equal(read(p).inventory.crumb_bait, undefined);
  assert.throws(() => issue(p, "start_fishing", "shore"), { code: "ECONOMY_RESOURCES" });
  issue(p, "buy_fishing_item", "crumb_bait", { totalPrice: 30 });
  const retry = issue(p, "start_fishing", "shore").jobs[0];
  assert.notEqual(retry.id, first.id); assert.equal(retry.fishing.fishId, first.fishing.fishId);
  issue(p, "cancel_exploration", retry.id, {}, Date.parse(retry.finishesAt));
  issue(p, "equip_fishing_bait", "none");
  const free = issue(p, "start_fishing", "shore").jobs[0];
  issue(p, "cancel_exploration", free.id);
  const repeatFree = issue(p, "start_fishing", "shore").jobs[0];
  assert.equal(repeatFree.fishing.fishId, free.fishing.fishId);
  assert.equal(read(p).completedExplorations, 0); assert.deepEqual(read(p).fishing.catches, {});
});

test("legacy shore claims count actual fish, whereas a forged metadata payload or wrong owner cannot grant a catch", () => {
  const p = player(), stranger = player(), active = issue(p, "start_exploration", "shore"), job = active.jobs[0];
  assert.equal(job.fishing, undefined);
  const at = Date.parse(job.finishesAt), request = command(p, "claim_job", job.id, {}, at);
  assert.throws(() => economy.commandDevEconomy(stranger.token, request, at), { code: "ECONOMY_OWNER_CHANGED" });
  assert.throws(() => economy.commandDevEconomy(p.token, { ...request, fishing: { catches: { fish_mooncarp: 100 } } }, at), { code: "INVALID_ECONOMY_COMMAND" });
  const completed = economy.commandDevEconomy(p.token, request, at).state;
  assert.deepEqual(completed.fishing.catches, { fish: 4 });
  assert.equal(economy.commandDevEconomy(p.token, request, at).replayed, true);
  assert.deepEqual(read(p).fishing.catches, { fish: 4 });
});

test("twelve species cover five rarities and exact gear odds stay monotonic without a bait resale profit", () => {
  const config = model.economyCatalog.fishing;
  assert.equal(config.fish.length, 12);
  assert.deepEqual([...new Set(config.fish.map(fish => fish.rarity))], ['common', 'uncommon', 'rare', 'epic', 'legendary']);
  const base = fishingOdds({}, config);
  assert.equal(base.find(fish => fish.itemId === 'fish_shark').probability, 0.0001);
  const strongest = fishingOdds({}, config, { rodId: 'willow_rod', hookId: 'silver_hook', baitId: 'worm_bait' });
  assert.equal(strongest.find(fish => fish.itemId === 'fish_shark').probability, 13 / 10804);
  const value = odds => odds.reduce((sum, fish) => sum + fish.probability * model.economyCatalog.items.find(item => item.id === fish.itemId).baseSellPrice, 0);
  assert.ok(Math.abs(value(base) - 111.524) < 1e-9);
  const loadouts = config.rods.flatMap(rod => config.hooks.flatMap(hook => [null, ...config.baits.map(bait => bait.itemId)].map(baitId => ({
    bonus: rod.rareBonus + hook.rareBonus + (config.baits.find(bait => bait.itemId === baitId)?.rareBonus ?? 0),
    odds: fishingOdds({}, config, { rodId: rod.id, hookId: hook.id, baitId }),
  })))).sort((a, b) => a.bonus - b.bonus);
  for (let i = 1; i < loadouts.length; i++) for (let end = 1; end < config.fish.length; end++) {
    const prefix = row => row.odds.slice(0, end).reduce((sum, fish) => sum + fish.probability, 0);
    assert.ok(prefix(loadouts[i]) <= prefix(loadouts[i - 1]) + 1e-12, 'Stronger gear cannot move the saved quantile to cheaper fish');
  }
  for (const rod of config.rods) for (const hook of config.hooks) for (const bait of config.baits) {
    const noBait = value(fishingOdds({}, config, { rodId: rod.id, hookId: hook.id, baitId: null }));
    const withBait = value(fishingOdds({}, config, { rodId: rod.id, hookId: hook.id, baitId: bait.itemId }));
    assert.ok(withBait - noBait < bait.price, 'Bait buys collection odds, never an expected immediate profit');
  }
});

test("hooks are unique durable purchases, validated loadout and saved trip metadata survive cancellation and equipment changes", () => {
  const p = player(); fund(p);
  assert.throws(() => issue(p, 'equip_fishing_hook', 'silver_hook'), { code: 'ECONOMY_FISHING_HOOK' });
  assert.throws(() => issue(p, 'buy_fishing_item', 'barbed_hook', { quantity: 2, totalPrice: 24000 }), { code: 'INVALID_ECONOMY_COMMAND' });
  const buy = command(p, 'buy_fishing_item', 'silver_hook', { totalPrice: 42000 });
  const purchased = economy.commandDevEconomy(p.token, buy, now);
  assert.equal(purchased.state.wallet.coins, 58000); assert.equal(purchased.state.storage.used, 0);
  assert.deepEqual(purchased.state.fishing.ownedHooks, ['bare_hook', 'silver_hook']);
  assert.equal(economy.commandDevEconomy(p.token, buy, now).replayed, true);
  assert.throws(() => issue(p, 'buy_fishing_item', 'silver_hook', { totalPrice: 42000 }), { code: 'ECONOMY_FISHING_OWNED' });
  issue(p, 'equip_fishing_hook', 'silver_hook');
  const job = issue(p, 'start_fishing', 'shore').jobs[0];
  assert.equal(job.fishing.hookId, 'silver_hook');
  assert.equal(Object.values(job.rewards).reduce((a, b) => a + b, 0), 4);
  assert.equal(Date.parse(job.finishesAt) - Date.parse(job.startedAt), 45 * 60 * 1000);
  issue(p, 'equip_fishing_hook', 'bare_hook');
  assert.deepEqual(read(p).jobs[0], job);
  issue(p, 'cancel_exploration', job.id); issue(p, 'equip_fishing_hook', 'silver_hook');
  const retry = issue(p, 'start_fishing', 'shore').jobs[0];
  assert.equal(retry.fishing.fishId, job.fishing.fishId);
  const claimed = issue(p, 'claim_job', retry.id, {}, Date.parse(retry.finishesAt));
  assert.deepEqual(claimed.fishing.catches, retry.rewards);
  const old = structuredClone(claimed); delete old.fishing.ownedHooks; delete old.fishing.equippedHookId;
  assert.deepEqual(model.economyViewSchema.parse(old).fishing.ownedHooks, ['bare_hook']);
  assert.equal(model.economyViewSchema.parse(old).fishing.equippedHookId, 'bare_hook');
});

test("every new fish loses coins on immediate NPC resale and purchased rarities never become catches", () => {
  const p = player(); fund(p);
  for (const fish of model.economyCatalog.fishing.fish) {
    const before = read(p).wallet.coins;
    issue(p, 'buy_fishing_item', fish.itemId, { totalPrice: fish.buyPrice });
    issue(p, 'sell_fish', fish.itemId);
    assert.ok(read(p).wallet.coins < before, fish.itemId);
    assert.deepEqual(read(p).fishing.catches, {});
  }
});
