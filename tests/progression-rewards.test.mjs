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
const model = await vite.ssrLoadModule("/features/economy/model.ts");
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

test("shared catalog totals 430 achievement pearls and a modest ordinary seven-step cycle", () => {
  const catalog = rules.progressionRewardsCatalog;
  assert.equal(Object.values(catalog.achievementPearls).flat().reduce((a, b) => a + b), 430);
  assert.deepEqual(catalog.daily.reduce((sum, r) => ({ coins: sum.coins + r.coins, pearls: sum.pearls + r.pearls,
    items: sum.items + Object.values(r.items).reduce((a, b) => a + b, 0) }), { coins: 0, pearls: 0, items: 0 }), { coins: 500, pearls: 30, items: 6 });
  assert.deepEqual([...new Set(catalog.daily.flatMap(r => Object.keys(r.items)))].sort(), ["fiber", "stone", "wood"]);
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
    last = claim(p, request(p), now);
    assert.equal(last.claim.step, step); assert.equal(last.replayed, false);
    assert.equal(api.gameRewardResultSchema.safeParse(last).success, true);
    assert.throws(() => claim(p, request(p), now + 1000), { code: "DAILY_REWARD_COOLDOWN" });
    now += (step === 2 ? 10 : 1) * 86400_000;
    assert.equal(rewards.getDevProgressionRewards(p.token, now).daily.step, step % 7 + 1);
  }
  const final = economy.getDevEconomy(p.token, now);
  assert.equal(final.wallet.coins - initial.wallet.coins, 500); assert.equal(final.wallet.pearls - initial.wallet.pearls, 30);
  for (const id of ["wood", "stone", "fiber"]) assert.equal((final.inventory[id] ?? 0) - (initial.inventory[id] ?? 0), 2);
  assert.equal(final.revision, initial.revision + 7); assert.equal(last.rewards.daily.step, 1);
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
  for (const extra of [{ now }, { reward: { pearls: 100 } }, { step: 7 }]) assert.throws(() => claim(p, { ...request(p), ...extra }, now), { code: "INVALID_REWARD_CLAIM" });
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
  value.state.inventory.wood -= 2;
  const accepted = claim(p, command, later);
  assert.equal(accepted.replayed, false); assert.equal(accepted.claim.step, 2);
});

test("wallet limit failure does not lose the gift and uses current inventory instead of a stale snapshot", () => {
  const p = player(), now = at("2026-10-05T12:00:00Z"); rewards.getDevProgressionRewards(p.token, now);
  const value = profile(p), command = request(p); value.state.wallet.coins = 10_000_000_000;
  assert.throws(() => claim(p, command, now), { code: "ECONOMY_CAPACITY" });
  assert.equal(value.revision, 0); assert.equal(rewards.getDevProgressionRewards(p.token, now).daily.step, 1);
  value.state.wallet.coins -= 200; assert.equal(claim(p, command, now).economy.wallet.coins, 10_000_000_000);
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
  assert.equal(first.claim.reward.pearls, 10); assert.equal(first.economy.wallet.pearls, initial.wallet.pearls + 10);
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
  assert.equal(claim(p, request(p, { kind: "achievement", achievementId: "thousand_taps", level: 1 }), now).claim.reward.pearls, 10);
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
    expectedRevision: value.revision, action: "sell", targetId: "wood", quantity: 2, totalPrice: 0 }, later);
  const received = claim(p, pending, later);
  assert.equal(received.claim.step, 2); assert.equal(received.economy.storage.overflow, 0);
  assert.equal(received.economy.storage.reserved, 2, "gift did not consume or ignore escrow");
});
