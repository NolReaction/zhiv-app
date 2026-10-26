import assert from "node:assert/strict";
import test, { after, beforeEach } from "node:test";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root,
  resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false } });
const identities = await vite.ssrLoadModule("/lib/dev/api-store.ts");
const economy = await vite.ssrLoadModule("/lib/dev/economy-store.ts");
const game = await vite.ssrLoadModule("/lib/dev/game-store.ts");
const api = await vite.ssrLoadModule("/features/game/game-api.ts");
const math = await vite.ssrLoadModule("/features/game/achievement-progress.ts");
const model = await vite.ssrLoadModule("/features/economy/domain/model.ts");
const collection = await vite.ssrLoadModule("/features/economy/domain/collection-progress.ts");
const achievementCatalog = JSON.parse(readFileSync(new URL("../apps/api/src/main/resources/world/achievements-catalog.json", import.meta.url), "utf8"));
const collectionCatalog = JSON.parse(readFileSync(new URL("../apps/api/src/main/resources/world/collections-catalog.json", import.meta.url), "utf8"));
beforeEach(() => { identities.resetDevStoreForTests(); game.resetDevGameStoreForTests(); });
after(() => vite.close());
const player = () => identities.createDevIdentity("Исследователь", crypto.randomUUID());
function awards(p, now = Date.now(), catalog = 6) { return game.getDevGameAchievements(p.token, now, catalog).value; }
function command(p, action, targetId, now, quantity = 1, totalPrice = 0) {
  return { requestId: crypto.randomUUID(), ownerPublicId: p.me.user.publicId, expectedRevision: economy.getDevEconomy(p.token, now).revision,
    action, targetId, quantity, totalPrice };
}
function issue(p, action, target, now, quantity = 1) { return economy.commandDevEconomy(p.token, command(p, action, target, now, quantity), now); }
const card = (p, id, now) => awards(p, now).achievements.find(value => value.id === id);

test("catalog6 adds current activity cards while catalog5 and catalog4 remain readable", () => {
  const p = player();
  const current = awards(p), legacy = awards(p, Date.now(), 4);
  assert.equal(current.achievements.length, 19);
  const v5 = awards(p, Date.now(), 5);
  assert.equal(v5.achievements.length, 15);
  assert.equal(api.gameAchievementsSchema.safeParse(v5).success, true);
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
  economy.getDevEconomy(p.token, now);
  globalThis.__zhivDevEconomyStore.profiles.get(p.me.user.publicId).state.buildings.warehouse = 3;
  const canceled = issue(p, "start_exploration", "forest", now).state.jobs[0];
  assert.equal(card(p, "first_path", now).unlockedAt, null);
  issue(p, "cancel_exploration", canceled.id, now + 1000);
  assert.equal(card(p, "familiar_trails", now).progress, 0);
  const forestSeconds = model.economyCatalog.explorations.find(route => route.id === "forest").seconds;
  const firstFindTrip = Math.ceil(collectionCatalog.travel.secondsPerFind / forestSeconds);
  assert(firstFindTrip <= 10, "this route reaches a real collection interval within the observed ten claims");
  let firstAt, tenthAt;
  for (let count = 1; count <= 10; count++) {
    const job = issue(p, "start_exploration", "forest", now).state.jobs[0];
    now = Date.parse(job.finishesAt);
    const request = command(p, "claim_job", job.id, now);
    economy.commandDevEconomy(p.token, request, now);
    assert.equal(economy.commandDevEconomy(p.token, request, now + 1000).replayed, true);
    if (count < firstFindTrip) assert.equal(card(p, "lucky_find", now).unlockedAt, null, "short completed trips cannot award a find before its work threshold");
    if (count === 1) firstAt = new Date(now).toISOString();
    if (count === 10) tenthAt = new Date(now).toISOString();
  }
  const first = card(p, "first_path", now + 5000), explorer = card(p, "explorer", now + 5000);
  assert.equal(first.unlockedAt, firstAt);
  assert.deepEqual(explorer.tiers.map(value => value.unlockedAt), [tenthAt, null, null]);
  assert.equal(explorer.unlockedAt, tenthAt); assert.equal(explorer.target, 50); assert.equal(explorer.progress, 10);
  assert.equal(economy.getDevEconomy(p.token, now).completedExplorations, 10);
  assert.equal(card(p, "lucky_find", now).unlockedAt, new Date(Date.parse(firstAt) + (firstFindTrip - 1) * forestSeconds * 1000).toISOString());
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
    assert.equal(card(p, "generous_garden", now).progress, index + 1);
  }
  assert.equal(card(p, "master_recipes", now).unlockedAt, null);
});

test("distinct current routes and known recipe/catch IDs prevent forged progress", () => {
  const state = economy.getDevEconomy(player().token);
  state.progression = collection.newEconomyProgression();
  state.progression.routes = { forest: 1, shore: 1, coastal_deposits: 9, invented_cave: 999 };
  assert.equal(math.economyAchievementProgress(state).familiar_trails, 3);
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

test("familiar trails count different completed routes including restored far bank, never biome labels or invented routes", () => {
  const initial = economy.getDevEconomy(player().token);
  for (const route of model.economyCatalog.explorations) {
    const visited = { ...initial, progression: { ...collection.newEconomyProgression(), routes: { [route.id]: 100, invented: 999 } } };
    assert.equal(math.economyAchievementProgress(visited).familiar_trails, 1, route.id);
  }
  assert.equal(achievementCatalog.version, 6);
  const sameFormerBiome = { ...initial, progression: { ...collection.newEconomyProgression(),
    routes: { forest: 2, forest_camp: 1, old_woodland: 1, invented: 999 } } };
  assert.equal(math.economyAchievementProgress(sameFormerBiome).familiar_trails, 3);
});

test("known retired quarry recipes retain historic achievement progress without counting new mining as crafting", () => {
  const p = player(); let now = Date.now();
  const initial = economy.getDevEconomy(p.token, now);
  const row = globalThis.__zhivDevEconomyStore.profiles.get(p.me.user.publicId);
  row.state.buildings = { ...initial.buildings, home: 3, quarry: 2 };
  const paid = { id: crypto.randomUUID(), kind: "production", targetId: "quarry", recipeId: "quarry_stone", targetLevel: null,
    startedAt: new Date(now - 1_800_000).toISOString(), finishesAt: new Date(now).toISOString(),
    rewards: { stone: 8 }, cost: { coins: 0, items: {} }, catalogVersion: 3 };
  row.state.jobs.push(paid);
  assert.equal(model.economyCatalog.recipes.some(recipe => recipe.id === paid.recipeId), false);
  issue(p, "claim_job", paid.id, now);
  assert.equal(card(p, "master_recipes", now).progress, 1, "an already-issued old production keeps its promised recipe progress");
  const mining = issue(p, "start_exploration", "quarry_ore", now).state.jobs[0];
  now = Date.parse(mining.finishesAt);
  const claimed = issue(p, "claim_job", mining.id, now).state;
  assert.equal(claimed.progression.routes.quarry_ore, 1);
  assert.equal(claimed.progression.recipes.quarry_ore, undefined);
  assert.equal(card(p, "master_recipes", now).progress, 1);
  assert.equal(math.economyAchievementProgress(claimed).familiar_trails, 1, "a completed quarry route qualifies");
  const historical = structuredClone(claimed);
  historical.progression.recipes.quarry_sand = 4;
  historical.progression.recipes.quarry_forged = 99;
  historical.progression.recipes.cave = 99;
  assert.equal(math.economyAchievementProgress(historical).master_recipes, 2, "only explicitly grandfathered recipe IDs count");
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
    row.state.buildings.home = 2; row.state.buildings.bridge = 1; row.state.completedExplorations = 0;
    row.state.wallet.coins = 1000; row.state.inventory = { berries: 10 };
  }
  issue(seller, "sell", "berries", now, 1);
  assert.equal(card(seller, "first_sale", now).unlockedAt, null);
  const create = command(seller, "create_listing", "berries", now, 2, 20);
  economy.commandDevEconomyMarket(seller.token, create, now);
  const canceled = economy.getDevEconomyMarket(seller.token, {}, now).mine[0];
  economy.commandDevEconomyMarket(seller.token, command(seller, "cancel_listing", canceled.id, now), now);
  assert.equal(card(seller, "first_sale", now).unlockedAt, null);
  economy.commandDevEconomyMarket(seller.token, command(seller, "create_listing", "berries", now, 2, 20), now);
  const lot = economy.getDevEconomyMarket(seller.token, {}, now).mine[0];
  assert.equal(card(seller, "first_sale", now).unlockedAt, null);
  const quote = economy.getDevEconomyMarket(buyer.token, {}, now).listings.find(item => item.id === lot.id);
  assert.ok(quote, "the buyer can only purchase the lot shown in the current market showcase");
  const buy = command(buyer, "buy_listing", quote.id, now, quote.quantity, quote.totalPrice);
  economy.commandDevEconomyMarket(buyer.token, buy, now);
  economy.commandDevEconomyMarket(buyer.token, buy, now + 1000);
  assert.equal(card(seller, "first_sale", now + 5000).unlockedAt, new Date(now).toISOString());
  assert.equal(card(buyer, "first_sale", now).unlockedAt, null);
});

test("current activity medals read only verified counters and clamp large cumulative totals safely", () => {
  const state = economy.getDevEconomy(player().token);
  state.inventory = { fish: 200, grilled_fish: 100, berries: 500 };
  let progress = math.economyAchievementProgress(state);
  for (const id of ["patient_angler", "campfire_cook", "helpful_neighbor", "generous_garden"]) assert.equal(progress[id], 0);
  state.fishing.catches = { fish: 9, fish_silverfin: 1, forged: Number.MAX_SAFE_INTEGER };
  state.progression.recipes = { cook_grilled_fish: 3, cook_compote: 2, grow_berries: 9, grow_strawberries: 1, forged: 999, quarry_stone: 100 };
  state.residentOrders.completed = 5;
  progress = math.economyAchievementProgress(state);
  assert.equal(progress.patient_angler, 10);
  assert.equal(progress.campfire_cook, 5);
  assert.equal(progress.generous_garden, 10);
  assert.equal(progress.helpful_neighbor, 5);
  state.fishing.catches.fish = Number.MAX_SAFE_INTEGER;
  state.progression.recipes.cook_grilled_fish = Number.MAX_SAFE_INTEGER;
  state.progression.recipes.grow_berries = Number.MAX_SAFE_INTEGER;
  progress = math.economyAchievementProgress(state);
  assert.equal(progress.patient_angler, 200); assert.equal(progress.campfire_cook, 100); assert.equal(progress.generous_garden, 200);
});

test("an earned former biome medal keeps its timestamp and eligibility after route condition replacement", () => {
  const p = player(), now = Date.now(), earnedAt = "2026-01-01T12:00:00.000Z";
  economy.getDevEconomy(p.token, now); awards(p, now);
  const store = globalThis.__zhivDevStore, ownerId = store.publicIds.get(p.me.user.publicId);
  store.achievementTierAwards.get(ownerId).set("familiar_trails", new Map([[1, earnedAt]]));
  store.achievementRewardEligibility.set(ownerId, new Map([["familiar_trails:1", true]]));
  const restored = card(p, "familiar_trails", now);
  assert.equal(restored.unlockedAt, earnedAt); assert.equal(restored.progress, 3);
  assert.equal(identities.getDevAchievementRewardEligibility(p.me.user.publicId, "familiar_trails", 1), true);
});

test("a campfire batch advances one cooking result only after claim and duplicate receipt cannot count twice", () => {
  const p = player(); let now = Date.now();
  economy.getDevEconomy(p.token, now);
  const row = globalThis.__zhivDevEconomyStore.profiles.get(p.me.user.publicId);
  row.state.inventory.fish = 3;
  row.state.fishing.stock = { fish: 3 };
  const started = issue(p, "start_production", "cook_grilled_fish", now).state;
  const job = started.jobs.find(job => job.recipeId === "cook_grilled_fish");
  assert.equal(card(p, "campfire_cook", now).progress, 0);
  now = Date.parse(job.finishesAt);
  const request = command(p, "claim_job", job.id, now);
  const first = economy.commandDevEconomy(p.token, request, now);
  assert.equal(first.replayed, false); assert.equal(card(p, "campfire_cook", now).progress, 1);
  assert.equal(economy.commandDevEconomy(p.token, request, now + 1000).replayed, true);
  assert.equal(card(p, "campfire_cook", now + 1000).progress, 1);
});
