import assert from "node:assert/strict";
import test, { after, beforeEach } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root,
  resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false } });
const identities = await vite.ssrLoadModule("/lib/dev/api-store.ts");
const economy = await vite.ssrLoadModule("/lib/dev/economy-store.ts");
const game = await vite.ssrLoadModule("/lib/dev/game-store.ts");
const api = await vite.ssrLoadModule("/features/game/game-api.ts");
const math = await vite.ssrLoadModule("/features/game/achievement-progress.ts");
const model = await vite.ssrLoadModule("/features/economy/model.ts");
const collection = await vite.ssrLoadModule("/features/economy/collection-progress.ts");
beforeEach(() => { identities.resetDevStoreForTests(); game.resetDevGameStoreForTests(); });
after(() => vite.close());
const player = () => identities.createDevIdentity("Исследователь", crypto.randomUUID());
function awards(p, now = Date.now(), catalog = 5) { return game.getDevGameAchievements(p.token, now, catalog).value; }
function command(p, action, targetId, now, quantity = 1, totalPrice = 0) {
  return { requestId: crypto.randomUUID(), ownerPublicId: p.me.user.publicId, expectedRevision: economy.getDevEconomy(p.token, now).revision,
    action, targetId, quantity, totalPrice };
}
function issue(p, action, target, now, quantity = 1) { return economy.commandDevEconomy(p.token, command(p, action, target, now, quantity), now); }
const card = (p, id, now) => awards(p, now).achievements.find(value => value.id === id);

test("catalog5 keeps all15 stable cards and legacy catalog4 remains unchanged", () => {
  const p = player();
  const current = awards(p), legacy = awards(p, Date.now(), 4);
  assert.equal(current.achievements.length, 15);
  assert.equal(api.gameAchievementsSchema.safeParse(current).success, true);
  assert.equal(legacy.achievements.length, 7);
  assert.ok(legacy.achievements.every(value => !Object.hasOwn(value, "tiers")));
  assert.equal(api.gameAchievementsSchema.safeParse(legacy).success, true);
  const broken = structuredClone(current);
  broken.achievements.find(value => value.id === "explorer").tiers[1].unlockedAt = new Date().toISOString();
  assert.equal(api.gameAchievementsSchema.safeParse(broken).success, false, "a later stage cannot precede its first award");
});

test("successful claim persists first path and each explorer tier once, start cancel and replay cannot award", () => {
  const p = player(); let now = Date.now();
  const canceled = issue(p, "start_exploration", "forest", now).state.jobs[0];
  assert.equal(card(p, "first_path", now).unlockedAt, null);
  issue(p, "cancel_exploration", canceled.id, now + 1000);
  assert.equal(card(p, "familiar_trails", now).progress, 0);
  let firstAt, tenthAt;
  for (let count = 1; count <= 10; count++) {
    const job = issue(p, "start_exploration", "forest", now).state.jobs[0];
    now = Date.parse(job.finishesAt);
    const request = command(p, "claim_job", job.id, now);
    economy.commandDevEconomy(p.token, request, now);
    assert.equal(economy.commandDevEconomy(p.token, request, now + 1000).replayed, true);
    if (count === 1) firstAt = new Date(now).toISOString();
    if (count === 10) tenthAt = new Date(now).toISOString();
  }
  const first = card(p, "first_path", now + 5000), explorer = card(p, "explorer", now + 5000);
  assert.equal(first.unlockedAt, firstAt);
  assert.deepEqual(explorer.tiers.map(value => value.unlockedAt), [tenthAt, null, null]);
  assert.equal(explorer.unlockedAt, tenthAt); assert.equal(explorer.target, 50); assert.equal(explorer.progress, 10);
  assert.equal(economy.getDevEconomy(p.token, now).completedExplorations, 10);
  assert.equal(card(p, "lucky_find", now).unlockedAt, new Date(Date.parse(firstAt) + 3 * 1800_000).toISOString());
});

test("berries count only after actual collection and repeating one recipe stays one unique recipe", () => {
  const p = player(); let now = Date.now();
  for (let index = 0; index < 2; index++) {
    const job = issue(p, "start_production", "grow_berries", now).state.jobs[0];
    now = Date.parse(job.finishesAt);
    assert.throws(() => issue(p, "claim_job", job.id, now), { code: "ECONOMY_COLLECTION_REQUIRED" });
    assert.equal(card(p, "master_recipes", now).progress, index);
    const collecting = issue(p, "start_collection", job.id, now).state.jobs[0];
    now = Date.parse(collecting.collection.finishesAt);
    issue(p, "claim_job", job.id, now);
    assert.equal(card(p, "master_recipes", now).progress, 1);
  }
  assert.equal(card(p, "master_recipes", now).unlockedAt, null);
});

test("biomes cover exactly the menu directions and known recipe/catch IDs prevent forged progress", () => {
  const state = economy.getDevEconomy(player().token);
  state.progression = collection.newEconomyProgression();
  state.progression.routes = { forest: 1, shore: 1, coastal_deposits: 9, invented_cave: 999 };
  assert.equal(math.economyAchievementProgress(state).familiar_trails, 2);
  state.progression.routes = { forest: 1, coastal_deposits: 1, cave: 1 };
  state.progression.recipes = Object.fromEntries([...model.economyCatalog.recipes.slice(0, 5).map(recipe => [recipe.id, 100]), ["unknown", 999]]);
  state.inventory = Object.fromEntries(model.economyCatalog.fishing.fish.map(fish => [fish.itemId, 99]));
  assert.equal(math.economyAchievementProgress(state).familiar_trails, 3);
  assert.equal(math.economyAchievementProgress(state).master_recipes, 5);
  assert.equal(math.economyAchievementProgress(state).river_atlas, 0, "ownership or purchased fish is not a personal catch");
  state.fishing.catches = Object.fromEntries([...model.economyCatalog.fishing.fish.map(fish => [fish.itemId, 1]), ["unknown", 999]]);
  assert.equal(math.economyAchievementProgress(state).river_atlas, 12);
  assert.equal(math.economyAchievementProgress(economy.getDevEconomy(player().token)).explorer, 0);
});

test("expanded river atlas requires twelve catches but preserves an earned former four-species tier and its date", () => {
  const p = player(), now = Date.now(), earnedAt = '2026-01-01T12:00:00.000Z';
  economy.getDevEconomy(p.token, now);
  const row = globalThis.__zhivDevEconomyStore.profiles.get(p.me.user.publicId);
  row.state.fishing.catches = Object.fromEntries(['fish', 'fish_silverfin', 'fish_reedperch', 'fish_mooncarp'].map(id => [id, 1]));
  assert.equal(card(p, 'river_atlas', now).progress, 4);
  assert.equal(card(p, 'river_atlas', now).target, 12);
  assert.equal(card(p, 'river_atlas', now).unlockedAt, null);
  // Persisted pre-expansion tier is authoritative; no recatch or new award is required.
  const store = globalThis.__zhivDevStore, ownerId = store.publicIds.get(p.me.user.publicId);
  store.achievementTierAwards.get(ownerId).set('river_atlas', new Map([[1, earnedAt]]));
  store.achievementRewardEligibility.set(ownerId, new Map([['river_atlas:1', true]]));
  const restored = card(p, 'river_atlas', now + 1000);
  assert.equal(restored.unlockedAt, earnedAt); assert.equal(restored.tiers[0].unlockedAt, earnedAt);
  assert.equal(identities.getDevAchievementRewardEligibility(p.me.user.publicId, 'river_atlas', 1), true);
  assert.deepEqual(row.state.fishing.catches, { fish: 1, fish_silverfin: 1, fish_reedperch: 1, fish_mooncarp: 1 });
});

test("inherited collection, wrong chapter time and merge of inherited-only worlds do not claim personal finds", () => {
  const state = economy.getDevEconomy(player().token);
  state.progression.collections = { finds: ["acorn"], travelSeconds: 0, quarrySeconds: 14400 };
  assert.equal(math.economyAchievementProgress(state).lucky_find, 0);
  state.progression.collections.travelSeconds = 7200;
  assert.equal(math.economyAchievementProgress(state, 0, ["acorn"]).lucky_find, 0);
  assert.equal(math.economyAchievementProgress(state).lucky_find, 1);
  const all = ["acorn", "feather", "fern_leaf", "moon_moth", "river_stone", "winged_seed"];
  state.progression.collections.finds = [...all];
  assert.equal(math.economyAchievementProgress(state, 0, all).lucky_find, 0, "merge must compare combined inherited ownership");
  state.progression.collections.finds.push("quartz_cluster");
  assert.equal(math.economyAchievementProgress(state, 0, all).lucky_find, 1);
});

test("first sale belongs to seller after confirmed payment, not NPC sales, listing creation or cancellation", () => {
  const seller = player(), buyer = player(), now = Date.now();
  for (const p of [seller, buyer]) {
    economy.getDevEconomy(p.token, now);
    const row = globalThis.__zhivDevEconomyStore.profiles.get(p.me.user.publicId);
    row.state.buildings.home = 2; row.state.completedExplorations = 1;
    row.state.wallet.coins = 1000; row.state.inventory = { berries: 10 };
  }
  issue(seller, "sell", "berries", now, 1);
  assert.equal(card(seller, "first_sale", now).unlockedAt, null);
  const create = command(seller, "create_listing", "berries", now, 2, 60);
  economy.commandDevEconomyMarket(seller.token, create, now);
  const canceled = economy.getDevEconomyMarket(seller.token, now).mine[0];
  economy.commandDevEconomyMarket(seller.token, command(seller, "cancel_listing", canceled.id, now), now);
  assert.equal(card(seller, "first_sale", now).unlockedAt, null);
  economy.commandDevEconomyMarket(seller.token, command(seller, "create_listing", "berries", now, 2, 60), now);
  const lot = economy.getDevEconomyMarket(seller.token, now).mine[0];
  assert.equal(card(seller, "first_sale", now).unlockedAt, null);
  economy.getDevEconomyMarket(buyer.token, now);
  const buy = command(buyer, "buy_listing", lot.id, now, 2, 60);
  economy.commandDevEconomyMarket(buyer.token, buy, now);
  economy.commandDevEconomyMarket(buyer.token, buy, now + 1000);
  assert.equal(card(seller, "first_sale", now + 5000).unlockedAt, new Date(now).toISOString());
  assert.equal(card(buyer, "first_sale", now).unlockedAt, null);
});
