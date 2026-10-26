import assert from "node:assert/strict";
import test, { after, beforeEach } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root,
  resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false } });
const rules = await vite.ssrLoadModule("/features/game/progression-rewards.ts");
const progress = await vite.ssrLoadModule("/features/game/achievement-progress.ts");
const compat = await vite.ssrLoadModule("/features/game/reward-catalog-compat.ts");
const api = await vite.ssrLoadModule("/features/game/game-rewards-api.ts");
const ids = await vite.ssrLoadModule("/lib/dev/api-store.ts");
const game = await vite.ssrLoadModule("/lib/dev/game-store.ts");
const economy = await vite.ssrLoadModule("/lib/dev/economy-store.ts");
const rewards = await vite.ssrLoadModule("/lib/dev/progression-rewards-store.ts");
const model = await vite.ssrLoadModule("/features/economy/domain/model.ts");
beforeEach(() => { ids.resetDevStoreForTests(); game.resetDevGameStoreForTests(); });
after(() => vite.close());

test("new pearl course redistributes the same finite budget without changing any earlier milestone", () => {
  let current = 0, legacy = 0, oldMilestones = 0;
  for (const [id, targets] of Object.entries(progress.GAME_ACHIEVEMENT_TARGETS)) {
    assert.deepEqual(targets.slice(0, progress.LEGACY_GAME_ACHIEVEMENT_TARGETS[id].length), progress.LEGACY_GAME_ACHIEVEMENT_TARGETS[id]);
    for (const [index] of targets.entries()) {
      current += rules.achievementPearlsForVersion(id, index + 1, 7);
      legacy += rules.achievementPearlsForVersion(id, index + 1, 6);
      if (index < progress.LEGACY_GAME_ACHIEVEMENT_TARGETS[id].length) oldMilestones += rules.achievementPearlsForVersion(id, index + 1, 6);
    }
  }
  assert.equal(current, 4120); assert.equal(oldMilestones, 4120); assert.equal(legacy, 5820);
  assert.equal(rules.achievementPearlsForVersion("master_recipes", 1) + rules.achievementPearlsForVersion("master_recipes", 2), 40);
  assert.equal(rules.achievementPearlsForVersion("master_recipes", 1, 6) + rules.achievementPearlsForVersion("master_recipes", 2, 6), 300);
});

test("a live legacy profile keeps unclaimed promises while new profiles receive redistributed amounts", () => {
  const player = ids.createDevIdentity("Сосед", crypto.randomUUID()), owner = player.me.user.publicId;
  const now = Date.parse("2026-10-26T12:00:00Z");
  rewards.getDevProgressionRewards(player.token, now);
  const profile = globalThis.__zhivDevProgressionRewards.get(owner);
  delete profile.achievementRewardVersion; // A pre-upgrade live DEV profile.
  globalThis.__zhivDevEconomyStore.profiles.get(owner).state.completedExplorations = 1;
  const opened = rewards.getDevProgressionRewards(player.token, now);
  assert.equal(opened.achievementRewards.find(row => row.achievementId === "first_path").pearls, 40);
  const command = { requestId: crypto.randomUUID(), ownerPublicId: owner, kind: "achievement", achievementId: "first_path", level: 1 };
  const paid = rewards.claimDevProgressionReward(player.token, command, now);
  assert.equal(paid.claim.reward.pearls, 40);
  profile.achievementRewardVersion = 7;
  const after = rewards.getDevProgressionRewards(player.token, now + 1).achievementRewards.find(row => row.achievementId === "first_path");
  assert.equal(after.pearls, 40, "claimed rows display their actual receipt, not a new catalog price");
  assert.equal(after.eligible, false);
  assert.deepEqual(rewards.claimDevProgressionReward(player.token, command, now + 2).claim, paid.claim);
  assert.throws(() => rewards.claimDevProgressionReward(player.token, { ...command, requestId: crypto.randomUUID() }, now + 3), { code: "ACHIEVEMENT_REWARD_CLAIMED" });
});

test("late recipe and activity tiers require their real counters and old clients retain all original rows", () => {
  const player = ids.createDevIdentity("Мастер", crypto.randomUUID()), owner = player.me.user.publicId;
  const now = Date.parse("2026-10-26T12:00:00Z");
  economy.getDevEconomy(player.token, now);
  const state = globalThis.__zhivDevEconomyStore.profiles.get(owner).state;
  const recipes = model.economyCatalog.recipes.filter(recipe => !recipe.retired);
  assert.equal(recipes.length, 61);
  state.progression.recipes = Object.fromEntries(recipes.slice(0, 60).map(recipe => [recipe.id, 1]));
  let opened = rewards.getDevProgressionRewards(player.token, now);
  const master = () => opened.achievementRewards.filter(row => row.achievementId === "master_recipes");
  assert.deepEqual(master().map(row => row.eligible), [true, true, true, false]);
  state.progression.recipes[recipes[60].id] = 1;
  state.completedExplorations = 1000; state.fishing.catches.fish = 1000; state.residentOrders.completed = 500;
  state.progression.recipes.cook_grilled_fish = 500; state.progression.recipes.grow_berries = 1000;
  opened = rewards.getDevProgressionRewards(player.token, now + 1);
  assert.ok(master().every(row => row.eligible));
  for (const id of ["explorer", "patient_angler", "campfire_cook", "helpful_neighbor", "generous_garden"])
    assert.equal(opened.achievementRewards.find(row => row.achievementId === id && row.level === 4).eligible, true);
  assert.equal(opened.achievementRewards.length, 40);
  for (const version of [4, 5, 6, 7, 8]) {
    const projected = compat.rewardCatalogView(opened, version);
    assert.equal(projected.achievementRewards.length, version === 8 ? 40 : version === 4 ? 21 : 33);
    assert.equal(api.gameRewardsSchema.safeParse(projected).success, true);
    if (version < 8) assert.ok(projected.achievementRewards.every(row => row.level <= progress.LEGACY_GAME_ACHIEVEMENT_TARGETS[row.achievementId].length));
  }
  const paid = rewards.claimDevProgressionReward(player.token, { requestId: crypto.randomUUID(), ownerPublicId: owner, kind: "achievement", achievementId: "master_recipes", level: 4 }, now + 2);
  assert.equal(paid.claim.reward.pearls, 300);
});
