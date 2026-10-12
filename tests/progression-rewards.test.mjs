import assert from "node:assert/strict";
import test, { beforeEach, after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root,
  resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false } });
const rules = await vite.ssrLoadModule("/features/game/progression-rewards.ts");
const ids = await vite.ssrLoadModule("/lib/dev/api-store.ts");
const economy = await vite.ssrLoadModule("/lib/dev/economy-store.ts");
const model = await vite.ssrLoadModule("/features/economy/domain/model.ts");
const rewards = await vite.ssrLoadModule("/lib/dev/progression-rewards-store.ts");
const api = await vite.ssrLoadModule("/features/game/game-rewards-api.ts");
const game = await vite.ssrLoadModule("/lib/dev/game-store.ts");
beforeEach(() => { ids.resetDevStoreForTests(); game.resetDevGameStoreForTests(); });
after(() => vite.close());
const at = text => Date.parse(text);
const player = () => ids.createDevIdentity("Мохлик", crypto.randomUUID());
const request = (p, extra = {}) => ({ requestId: crypto.randomUUID(), ownerPublicId: p.me.user.publicId, kind: "daily", ...extra });
const claim = (p, command, now) => rewards.claimDevProgressionReward(p.token, command, now);
const profile = p => globalThis.__zhivDevEconomyStore.profiles.get(p.me.user.publicId);
const row = (p, id, level, now) => rewards.getDevProgressionRewards(p.token, now).achievementRewards.find(r => r.achievementId === id && r.level === level);

test("shared catalog totals 2150 achievement pearls and valuable seven-step bundles", () => {
  const catalog = rules.progressionRewardsCatalog;
  assert.equal(Object.values(catalog.achievementPearls).flat().reduce((a, b) => a + b), 2150);
  assert.deepEqual(catalog.daily.reduce((sum, r) => ({ coins: sum.coins + r.coins, pearls: sum.pearls + r.pearls,
    items: sum.items + Object.values(r.items).reduce((a, b) => a + b, 0) }), { coins: 0, pearls: 0, items: 0 }), { coins: 5500, pearls: 450, items: 106 });
  assert.deepEqual([...new Set(catalog.daily.flatMap(r => Object.keys(r.items)))].sort(), ["ancient_core", "berries", "fiber", "fish", "planks", "rope", "stone", "wood"]);
});

test("completed home tiers add useful materials within fixed pearl and relic budgets", () => {
  const totals = [5500, 11000, 22000, 44000, 66000], minutes = [250, 490, 840, 1260, 1520];
  for (let home = 1; home <= 5; home++) {
    const cycle = rules.dailyRewardCycle(home);
    assert.equal(cycle.length, 7);
    assert.equal(cycle.reduce((sum, reward) => sum + reward.coins, 0), totals[home - 1]);
    assert.equal(cycle.reduce((sum, reward) => sum + reward.pearls, 0), 450, "paid progression cannot multiply free pearls");
    assert.equal(cycle.reduce((sum, reward) => sum + (reward.items.ancient_core ?? 0), 0), 1);
    assert.ok(cycle.every(reward => Object.keys(reward.items).length >= 2));
    let workshopMinutes = 0;
    for (const reward of cycle) for (const [id, amount] of Object.entries(reward.items)) {
      const item = model.economyCatalog.items.find(item => item.id === id);
      assert.ok(item, `known item ${id}`);
      if (item.category !== "crafted") continue;
      // Count direct single-output recipe time only, not recursively saved inputs or queue scheduling.
      const recipes = model.economyCatalog.recipes.filter(recipe => Object.keys(recipe.rewards).length === 1 && recipe.rewards[id]);
      assert.ok(recipes.some(recipe => recipe.requiredHomeLevel <= home), `${id} must be unlocked at house ${home}`);
      workshopMinutes += amount * Math.min(...recipes.map(recipe => recipe.seconds / recipe.rewards[id])) / 60;
    }
    assert.equal(workshopMinutes, minutes[home - 1]);
  }
  assert.deepEqual(rules.dailyRewardCycle(0), rules.dailyRewardCycle(1));
  assert.deepEqual(rules.dailyRewardCycle(99), rules.dailyRewardCycle(5));
  assert.deepEqual(rules.dailyRewardCycle(NaN), rules.dailyRewardCycle(1));
  const copy = rules.dailyRewardCycle(5); copy[0].items.hardwood = 999;
  assert.equal(rules.dailyRewardCycle(5)[0].items.hardwood, 16, "previews cannot mutate shared catalog");
});

test("claim chooses the current server home tier and replay preserves the actually credited bundle", () => {
  const p = player(), now = at("2026-10-05T12:00:00Z"), stale = rewards.getDevProgressionRewards(p.token, now);
  assert.equal(stale.daily.homeLevel, 1);
  const value = profile(p);
  value.state.buildings.home = 4;
  value.state.wallet.pearls = 500_000;
  value.state.productionSlots = { workshop: 3, woodlot: 3, garden: 3, kiln: 3, dryer: 3 };
  const command = request(p), paid = claim(p, command, now);
  assert.deepEqual(paid.claim.reward, rules.dailyRewardCycle(4)[0]);
  assert.equal(paid.rewards.daily.homeLevel, 4);
  value.state.buildings.home = 5;
  const retry = claim(p, command, now + 1000);
  assert.deepEqual(retry.claim, paid.claim);
  assert.equal(retry.rewards.daily.homeLevel, 5, "fresh preview changes without rewriting historical receipt");
  assert.equal(retry.economy.wallet.coins, paid.economy.wallet.coins);
});

test("an unfinished home upgrade cannot unlock a higher daily tier", () => {
  const p = player(), now = at("2026-10-05T12:00:00Z"); rewards.getDevProgressionRewards(p.token, now);
  const value = profile(p);
  value.state.buildings.workshop = 1;
  value.state.wallet.coins = 1500;
  value.state.inventory = { wood: 20, stone: 15, planks: 6, rope: 2 };
  const start = economy.commandDevEconomy(p.token, { requestId: crypto.randomUUID(), ownerPublicId: p.me.user.publicId,
    expectedRevision: value.revision, action: "start_construction", targetId: "home", quantity: 1, totalPrice: 0 }, now).state;
  const ready = Date.parse(start.jobs[0].finishesAt);
  assert.equal(rewards.getDevProgressionRewards(p.token, ready).daily.homeLevel, 1);
  economy.commandDevEconomy(p.token, { requestId: crypto.randomUUID(), ownerPublicId: p.me.user.publicId,
    expectedRevision: value.revision, action: "claim_job", targetId: start.jobs[0].id, quantity: 1, totalPrice: 0 }, ready);
  assert.equal(rewards.getDevProgressionRewards(p.token, ready).daily.homeLevel, 2);
});

test("UTC midnight and twenty-hour fences both apply independently of player timezone", () => {
  const state = { step: 2, lastClaimAt: "2026-10-05T23:59:00Z", lastClaimDate: "2026-10-05" };
  assert.equal(rules.dailyRewardView(state, at("2026-10-06T00:00:00Z")).claimable, false);
  assert.equal(rules.dailyRewardView(state, at("2026-10-06T19:58:59Z")).claimable, false);
  assert.equal(rules.dailyRewardView(state, at("2026-10-06T19:59:00Z")).claimable, true);
  const early = { ...state, lastClaimAt: "2026-10-05T01:00:00Z" };
  assert.equal(rules.dailyRewardView(early, at("2026-10-05T23:59:59Z")).claimable, false);
  assert.equal(rules.dailyRewardView(early, at("2026-10-06T00:00:00Z")).claimable, true);
  assert.equal(rules.dailyRewardView(state, at("2026-10-05T20:00:00Z")).claimable, false, "clock correction cannot reopen a claim");
});

test("opening rewards changes no wallet; seven manual claims wrap and skipped days preserve the step", () => {
  const p = player(); let now = at("2026-10-05T12:00:00Z");
  const initial = economy.getDevEconomy(p.token, now), opened = rewards.getDevProgressionRewards(p.token, now);
  assert.equal(api.gameRewardsSchema.safeParse(opened).success, true);
  assert.equal(opened.achievementRewards.length, 21); assert.equal(opened.daily.step, 1);
  assert.deepEqual(economy.getDevEconomy(p.token, now).wallet, initial.wallet);
  let last;
  for (let step = 1; step <= 7; step++) {
    const beforeClaim = economy.getDevEconomy(p.token, now);
    last = claim(p, request(p), now);
    assert.equal(last.acceptedRevision, beforeClaim.revision + 1, "one atomic credit after the merchant window is reconciled");
    assert.equal(last.claim.step, step); assert.equal(last.replayed, false);
    assert.equal(api.gameRewardResultSchema.safeParse(last).success, true);
    assert.throws(() => claim(p, request(p), now + 1000), { code: "DAILY_REWARD_COOLDOWN" });
    now += (step === 2 ? 10 : 1) * 86400_000;
    assert.equal(rewards.getDevProgressionRewards(p.token, now).daily.step, step % 7 + 1);
  }
  const final = economy.getDevEconomy(p.token, now);
  assert.equal(final.wallet.coins - initial.wallet.coins, 5500); assert.equal(final.wallet.pearls - initial.wallet.pearls, 450);
  for (const [id, amount] of Object.entries({ wood: 28, stone: 20, fiber: 22, berries: 10, fish: 6, planks: 12, rope: 7, ancient_core: 1 })) assert.equal((final.inventory[id] ?? 0) - (initial.inventory[id] ?? 0), amount);
  assert.ok(final.revision >= initial.revision + 7); assert.equal(last.rewards.daily.step, 1);
});

test("lost-response replay preserves original reward, date and accepted revision alongside fresh economy", () => {
  const p = player(), now = at("2026-10-05T12:00:00Z"), command = request(p);
  const first = claim(p, command, now);
  claim(p, request(p), now + 86400_000);
  const retry = claim(p, command, now + 2 * 86400_000);
  assert.equal(retry.replayed, true); assert.deepEqual(retry.claim, first.claim);
  assert.equal(retry.requestId, command.requestId); assert.equal(retry.acceptedRevision, first.acceptedRevision);
  assert.ok(retry.economy.revision > retry.acceptedRevision); assert.equal(retry.rewards.daily.step, 3);
  assert.throws(() => claim(p, { ...command, kind: "achievement", achievementId: "first_path", level: 1 }, now), { code: "REWARD_REQUEST_CONFLICT" });
});

test("strict request and owner checks never credit forged quantities or another player", () => {
  const p = player(), other = player(), now = at("2026-10-05T12:00:00Z");
  for (const extra of [{ now }, { reward: { pearls: 100 } }, { step: 7 }, { homeLevel: 5 }]) assert.throws(() => claim(p, { ...request(p), ...extra }, now), { code: "INVALID_REWARD_CLAIM" });
  assert.throws(() => claim(p, request(other), now), { code: "ECONOMY_OWNER_CHANGED" });
  assert.throws(() => claim(p, request(p, { kind: "achievement", achievementId: "home_builder", level: 5 }), now), { code: "INVALID_REWARD_CLAIM" });
  assert.throws(() => claim(p, request(p, { kind: "achievement", achievementId: "first_path", level: 2 }), now), { code: "INVALID_REWARD_CLAIM" });
  assert.throws(() => claim(p, request(p, { kind: "achievement", achievementId: "first_path", level: 1 }), now), { code: "ACHIEVEMENT_REWARD_UNAVAILABLE" });
  assert.equal(rewards.getDevProgressionRewards(p.token, now).daily.step, 1);
});

test("full storage failure consumes neither daily step nor request and can retry after freeing space", () => {
  const p = player(), now = at("2026-10-05T12:00:00Z"); claim(p, request(p), now);
  const later = now + 86400_000, command = request(p), value = profile(p);
  value.state.inventory = { wood: economy.getDevEconomy(p.token, later).storage.capacity };
  const before = structuredClone(value.state), revision = value.revision;
  assert.throws(() => claim(p, command, later), { code: "ECONOMY_STORAGE_FULL" });
  assert.deepEqual(value.state, before); assert.equal(value.revision, revision);
  assert.equal(rewards.getDevProgressionRewards(p.token, later).daily.step, 2);
  value.state.inventory.wood -= 20;
  const accepted = claim(p, command, later);
  assert.equal(accepted.replayed, false); assert.equal(accepted.claim.step, 2);
});

test("wallet limit failure does not lose the gift and uses current inventory instead of a stale snapshot", () => {
  const p = player(), now = at("2026-10-05T12:00:00Z"); rewards.getDevProgressionRewards(p.token, now);
  const value = profile(p), command = request(p), revision = value.revision; value.state.wallet.coins = 10_000_000_000;
  assert.throws(() => claim(p, command, now), { code: "ECONOMY_CAPACITY" });
  assert.equal(value.revision, revision); assert.equal(rewards.getDevProgressionRewards(p.token, now).daily.step, 1);
  value.state.wallet.coins -= 600; assert.equal(claim(p, command, now).economy.wallet.coins, 10_000_000_000);
});

test("earned achievement tiers pay manually once and duplicate keys cannot reopen payout", () => {
  const p = player(); let now = at("2026-10-05T12:00:00Z");
  const initial = economy.getDevEconomy(p.token, now), state = initial;
  const start = economy.commandDevEconomy(p.token, { requestId: crypto.randomUUID(), ownerPublicId: p.me.user.publicId,
    expectedRevision: state.revision, action: "start_exploration", targetId: "forest", quantity: 1, totalPrice: 0 }, now).state;
  now = Date.parse(start.jobs[0].finishesAt);
  economy.commandDevEconomy(p.token, { requestId: crypto.randomUUID(), ownerPublicId: p.me.user.publicId,
    expectedRevision: start.revision, action: "claim_job", targetId: start.jobs[0].id, quantity: 1, totalPrice: 0 }, now);
  assert.equal(row(p, "first_path", 1, now).eligible, true);
  assert.equal(economy.getDevEconomy(p.token, now).wallet.pearls, initial.wallet.pearls, "earning is not an automatic payout");
  const command = request(p, { kind: "achievement", achievementId: "first_path", level: 1 }), first = claim(p, command, now);
  assert.equal(first.claim.reward.pearls, 50); assert.equal(first.economy.wallet.pearls, initial.wallet.pearls + 50);
  assert.equal(row(p, "first_path", 1, now).claimedAt, first.claim.claimedAt);
  assert.equal(claim(p, command, now + 5000).replayed, true);
  assert.throws(() => claim(p, request(p, { kind: "achievement", achievementId: "first_path", level: 1 }), now), { code: "ACHIEVEMENT_REWARD_CLAIMED" });
});

test("new admin tiers stay cosmetic until each real target qualifies; repeated grants do not reset dates or claims", () => {
  const p = player(), now = at("2026-10-05T12:00:00Z"); economy.getDevEconomy(p.token, now);
  ids.grantDevAchievementForAdmin(p.me.user.publicId, "explorer", now);
  assert.equal(row(p, "explorer", 1, now).blockedReason, "admin_grant");
  assert.equal(row(p, "explorer", 3, now).eligible, false);
  const originalAt = row(p, "explorer", 1, now).earnedAt;
  const value = profile(p); value.state.completedExplorations = 10;
  ids.awardDevEconomyAchievements(p.me.user.publicId, value.state, now + 5000);
  assert.equal(row(p, "explorer", 1, now + 5000).eligible, true);
  assert.equal(row(p, "explorer", 2, now + 5000).blockedReason, "admin_grant");
  const paid = claim(p, request(p, { kind: "achievement", achievementId: "explorer", level: 1 }), now + 5000);
  ids.grantDevAchievementForAdmin(p.me.user.publicId, "explorer", now + 10000);
  const current = row(p, "explorer", 1, now + 10000);
  assert.equal(current.claimedAt, paid.claim.claimedAt); assert.equal(current.earnedAt, originalAt); assert.equal(current.eligible, false);
});

test("legacy finite ownership is grandfathered while obsolete full_collection has no payout", () => {
  const p = player(), now = at("2026-10-05T12:00:00Z");
  economy.getDevEconomy(p.token, now);
  ids.awardDevGameTaps(p.me.user.publicId, 1000, now);
  const own = row(p, "thousand_taps", 1, now); assert.equal(own.eligible, true);
  const hidden = row(p, "full_collection", 1, now); assert.equal(hidden.pearls, 0); assert.equal(hidden.blockedReason, "no_reward");
  assert.equal(claim(p, request(p, { kind: "achievement", achievementId: "thousand_taps", level: 1 }), now).claim.reward.pearls, 50);
});

test("reward UUID fences are shared with ordinary economy commands in both directions", () => {
  const p = player(), now = at("2026-10-05T12:00:00Z"), command = request(p), first = claim(p, command, now);
  assert.throws(() => economy.commandDevEconomy(p.token, { requestId: command.requestId, ownerPublicId: p.me.user.publicId,
    expectedRevision: first.economy.revision, action: "start_exploration", targetId: "forest", quantity: 1, totalPrice: 0 }, now), { code: "ECONOMY_REQUEST_CONFLICT" });
  const id = crypto.randomUUID(); economy.commandDevEconomy(p.token, { requestId: id, ownerPublicId: p.me.user.publicId,
    expectedRevision: first.economy.revision, action: "start_exploration", targetId: "forest", quantity: 1, totalPrice: 0 }, now);
  assert.throws(() => claim(p, { ...request(p), requestId: id }, now + 86400_000), { code: "ECONOMY_REQUEST_CONFLICT" });
});

test("merge daily keeps the latest next step and next deadline without resetting paid history", () => {
  const left = { step: 5, lastClaimAt: "2026-10-05T23:00:00Z", lastClaimDate: "2026-10-05" };
  const right = { step: 2, lastClaimAt: "2026-10-06T10:00:00Z", lastClaimDate: "2026-10-06" };
  const merged = rules.mergeDailyRewards(left, right);
  assert.deepEqual(merged, right); assert.equal(rules.dailyRewardView(merged, at("2026-10-06T23:59:00Z")).claimable, false);
  assert.equal(rules.dailyRewardView(merged, at("2026-10-07T06:00:00Z")).claimable, true);
  assert.deepEqual(rules.mergeDailyRewards(right, { ...right, step: 7 }), right, "timestamp tie preserves target sequence");
});


test("repeat admin grant preserves finite historical eligibility when HMR lacks new flags", () => {
  const p = player(), now = at("2026-10-05T12:00:00Z");
  economy.getDevEconomy(p.token, now);
  ids.awardDevGameTaps(p.me.user.publicId, 1000, now);
  const value = profile(p); value.state.completedExplorations = 10;
  ids.awardDevEconomyAchievements(p.me.user.publicId, value.state, now);
  // Emulate a running store created before the eligibility field existed.
  globalThis.__zhivDevStore.achievementRewardEligibility.clear();
  ids.grantDevAchievementForAdmin(p.me.user.publicId, "thousand_taps", now + 1000);
  ids.grantDevAchievementForAdmin(p.me.user.publicId, "explorer", now + 1000);
  assert.equal(row(p, "thousand_taps", 1, now).eligible, true);
  assert.equal(row(p, "explorer", 1, now).eligible, true);
  assert.equal(row(p, "explorer", 2, now).blockedReason, "admin_grant", "newly added admin stage is still cosmetic");
});

test("materials reserved in active market lots still occupy storage during a daily item claim", () => {
  const p = player(), now = at("2026-10-05T12:00:00Z"); claim(p, request(p), now);
  const value = profile(p); value.state.buildings.home = 2; value.state.completedExplorations = 1;
  const capacity = economy.getDevEconomy(p.token, now).storage.capacity;
  value.state.inventory = { wood: capacity };
  const listing = { requestId: crypto.randomUUID(), ownerPublicId: p.me.user.publicId,
    expectedRevision: value.revision, action: "create_listing", targetId: "wood", quantity: 2, totalPrice: model.economyCatalog.items.find(item => item.id === "wood").baseSellPrice * 2 };
  economy.commandDevEconomyMarket(p.token, listing, now);
  const current = economy.getDevEconomy(p.token, now);
  assert.equal(current.storage.reserved, 2); assert.equal(current.storage.available, 0);
  const pending = request(p), later = now + 86400_000;
  assert.throws(() => claim(p, pending, later), { code: "ECONOMY_STORAGE_FULL" });
  economy.commandDevEconomy(p.token, { requestId: crypto.randomUUID(), ownerPublicId: p.me.user.publicId,
    expectedRevision: value.revision, action: "sell", targetId: "wood", quantity: 32, totalPrice: 0 }, later);
  const received = claim(p, pending, later);
  assert.equal(received.claim.step, 2); assert.equal(received.economy.storage.overflow, 0);
  assert.equal(received.economy.storage.reserved, 2, "gift did not consume or ignore escrow");
});


test("final gift credits its relic and currencies atomically, and exact replay never repeats them", () => {
  const p = player(), start = at("2026-10-05T12:00:00Z");
  for (let day = 0; day < 6; day++) claim(p, request(p), start + day * 86400_000);
  const now = start + 6 * 86400_000, command = request(p), value = profile(p);
  value.state.inventory = { wood: economy.getDevEconomy(p.token, now).storage.capacity };
  const wallet = structuredClone(value.state.wallet);
  assert.throws(() => claim(p, command, now), { code: "ECONOMY_STORAGE_FULL" });
  assert.deepEqual(value.state.wallet, wallet); assert.equal(rewards.getDevProgressionRewards(p.token, now).daily.step, 7);
  value.state.inventory.wood -= 7;
  const paid = claim(p, command, now);
  assert.equal(paid.economy.inventory.ancient_core, 1);
  assert.deepEqual(paid.economy.wallet, { coins: wallet.coins + 1500, pearls: wallet.pearls + 300 });
  const replay = claim(p, command, now + 1000);
  assert.equal(replay.replayed, true); assert.deepEqual(replay.claim, paid.claim);
  assert.deepEqual(replay.economy.wallet, paid.economy.wallet); assert.deepEqual(replay.economy.inventory, paid.economy.inventory);
  assert.equal(replay.rewards.daily.step, 1);
});
