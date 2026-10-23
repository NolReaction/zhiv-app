import assert from "node:assert/strict";
import test, { after, afterEach } from "node:test";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root,
  resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false } });
after(() => vite.close());
const { GAME_ACHIEVEMENTS, VISIBLE_GAME_ACHIEVEMENTS } = await vite.ssrLoadModule("/features/game/game-rewards.ts");
const { AchievementCard, GameAchievementsList, achievementPresentation, achievementSummary, loadGameAchievements } =
  await vite.ssrLoadModule("/features/game/game-achievements.tsx");
const { gameAchievementsSchema } = await vite.ssrLoadModule("/features/game/game-api.ts");
const { achievementRewardSummary } = await vite.ssrLoadModule("/features/game/achievement-reward-summary.ts");
const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

test("reward badges only use unclaimed confirmed rewards for the current account", () => {
  const row = { eligible: true, pearls: 20, claimedAt: null, blockedReason: null };
  const rewards = { ownerPublicId: "me", achievementRewards: [row, { ...row, eligible: false },
    { ...row, claimedAt: "2026-10-23T00:00:00Z" }, { ...row, blockedReason: "admin_grant" }, { ...row, pearls: 0 }] };
  assert.deepEqual(achievementRewardSummary(rewards, "me"), { count: 1, pearls: 20 });
  assert.deepEqual(achievementRewardSummary(rewards, "other"), { count: 0, pearls: 0 });
  assert.deepEqual(achievementRewardSummary(null, "me"), { count: 0, pearls: 0 });
});

test("claimable achievements come first in their section with the displayed pearl amount", () => {
  const rewards = { achievementRewards: [{ achievementId: "explorer", level: 1, pearls: 20, eligible: true, claimedAt: null, blockedReason: null }] };
  const html = renderToStaticMarkup(createElement(GameAchievementsList, { data: null, rewards, onClaim() {} }));
  assert.ok(html.indexOf('data-achievement-id="explorer"') < html.indexOf('data-achievement-id="first_path"'));
  assert.match(html, /data-ready="true"/);
  assert.match(html, /Получить 10 жемчужин/);
});
const owner = "7K3P-2Q9M-W8ZR", stranger = "7K3P-2Q9M-W8ZS";
const at = "2026-10-05T14:00:00Z";
const quest = id => GAME_ACHIEVEMENTS.find(item => item.id === id);
function state(id, progress = 0, earned = 0) {
  const targets = quest(id).tiers, floor = targets[earned - 1] ?? 0;
  const tiers = targets.map((target, index) => ({ level: index + 1, target,
    progress: index < earned ? target : Math.min(target, Math.max(progress, floor)), unlockedAt: index < earned ? at : null }));
  const current = tiers.find(tier => tier.unlockedAt === null) ?? tiers.at(-1);
  return { id, progress: current.progress, target: current.target, unlockedAt: tiers[0].unlockedAt, tiers };
}
function payload(changes = {}) {
  return { ownerPublicId: owner, serverTime: at, achievements: GAME_ACHIEVEMENTS.map(item => changes[item.id] ?? state(item.id)) };
}
const render = (component, props) => renderToStaticMarkup(createElement(component, props));

test("catalog6 keeps all stable IDs while rendering exactly eighteen cards and thirty-two visible tiers", () => {
  assert.equal(GAME_ACHIEVEMENTS.length, 19);
  assert.equal(VISIBLE_GAME_ACHIEVEMENTS.length, 18);
  assert.deepEqual(GAME_ACHIEVEMENTS.slice(0, 7).map(item => item.id), ["seven_day_streak", "thousand_taps", "five_friends", "ten_thousand_series", "linked_email", "saved_recovery_code", "full_collection"]);
  assert.equal(gameAchievementsSchema.safeParse(payload()).success, true, "UI metadata thresholds agree with the server contract");
  const html = render(GameAchievementsList, { data: payload() });
  assert.equal([...html.matchAll(/data-achievement-id=/g)].length, 18);
  assert.doesNotMatch(html, /data-achievement-id="full_collection"/);
  for (const item of VISIBLE_GAME_ACHIEVEMENTS) assert.equal(html.split(`data-achievement-id="${item.id}"`).length - 1, 1);
  assert.match(html, /Мир и хозяйство/); assert.match(html, /Ритм и связи/);
  assert.deepEqual(achievementSummary(payload()), { earned: 0, tiers: 0, total: 18, totalTiers: 32 });
});

test("a partially earned achievement is one colored card with progress toward the next tier", () => {
  const current = state("explorer", 35, 1), view = achievementPresentation(quest("explorer"), current);
  assert.equal(view.unlocked, true); assert.equal(view.complete, false);
  assert.equal(view.earned, 1); assert.equal(view.next.level, 2); assert.equal(view.target, 50);
  const html = render(AchievementCard, { quest: quest("explorer"), state: current });
  assert.equal([...html.matchAll(/<article/g)].length, 1);
  assert.match(html, /data-unlocked="true"/);
  assert.doesNotMatch(html, /data-complete=/);
  assert.match(html, /35 \/ 50/); assert.match(html, /Далее · ступень II/);
  assert.match(html, /Получено ступеней: 1 из 3/);
  assert.equal([...html.matchAll(/aria-current="step"/g)].length, 1);
  assert.match(html, /<progress(?=[^>]*max="50")(?=[^>]*value="35")/);
});

test("only server award dates unlock a medal; filled progress alone is insufficient", () => {
  const pending = state("explorer", 200, 0), view = achievementPresentation(quest("explorer"), pending);
  assert.equal(view.progress, 10); assert.equal(view.target, 10);
  assert.equal(view.unlocked, false); assert.equal(view.earned, 0); assert.equal(view.complete, false);
  const html = render(AchievementCard, { quest: quest("explorer"), state: pending });
  assert.doesNotMatch(html, /data-unlocked=/);
  assert.match(html, /В процессе/);
});

test("an admin grant can complete all tiers without producing activity counters", () => {
  const awarded = state("home_builder", 0, 4);
  const html = render(AchievementCard, { quest: quest("home_builder"), state: awarded });
  assert.match(html, /data-complete="true"/); assert.match(html, /Все ступени получены/);
  assert.match(html, /5 \/ 5/);
  assert.equal([...html.matchAll(/data-earned="true"/g)].length, 4);
  assert.doesNotMatch(html, /aria-current="step"/);
  assert.deepEqual(achievementSummary(payload({ home_builder: awarded })), { earned: 1, tiers: 4, total: 18, totalTiers: 32 });
});

test("retired collection awards are preserved in legacy responses and excluded from player counts", () => {
  const achievements = GAME_ACHIEVEMENTS.slice(0, 7).map(item => ({ id: item.id, progress: item.id === "full_collection" ? 12 : item.id === "linked_email" ? 1 : 0,
    target: item.target, unlockedAt: ["full_collection", "linked_email"].includes(item.id) ? at : null }));
  const legacy = { ownerPublicId: owner, serverTime: at, achievements };
  assert.equal(gameAchievementsSchema.safeParse(legacy).success, true);
  assert.deepEqual(achievementSummary(legacy), { earned: 1, tiers: 1, total: 18, totalTiers: 32 });
  const html = render(GameAchievementsList, { data: legacy });
  assert.doesNotMatch(html, /Хранитель находок/);
  const missing = render(AchievementCard, { quest: quest("master_recipes") });
  assert.match(missing, /Нет данных/); assert.doesNotMatch(missing, /<progress|0 \/ 5/);
});

test("all cards expose keyboard-native conditions and named progress, with no client claims", () => {
  const html = render(GameAchievementsList, { data: payload(), loading: true });
  assert.match(html, /aria-busy="true"/);
  assert.equal([...html.matchAll(/<details/g)].length, 18);
  assert.equal([...html.matchAll(/<summary>Как получить<\/summary>/g)].length, 18);
  assert.equal([...html.matchAll(/<progress[^>]+aria-label="Прогресс достижения/g)].length, 18);
  assert.doesNotMatch(html, /Получить награду|claim_achievement|NaN|Infinity|undefined/);
});

test("achievement reads request catalog6 without caching and reject account switches", async () => {
  let request;
  globalThis.fetch = async (url, options) => { request = { url, options }; return Response.json(payload()); };
  const data = await loadGameAchievements(owner, new AbortController().signal);
  assert.equal(data.ownerPublicId, owner); assert.equal(request.url, "/api/v1/game/achievements?catalog=6");
  assert.equal(request.options.credentials, "same-origin"); assert.equal(request.options.cache, "no-store");
  assert.equal(request.options.method, "GET"); assert.ok(request.options.signal instanceof AbortSignal);
  globalThis.fetch = async () => Response.json({ ...payload(), ownerPublicId: stranger });
  await assert.rejects(loadGameAchievements(owner, new AbortController().signal), error => error.status === 401);
});

test("unauthorized, invalid and cancelled reads cannot become accepted achievement data", async () => {
  globalThis.fetch = async () => Response.json({ code: "UNAUTHORIZED", message: "Сеанс истёк" }, { status: 401 });
  await assert.rejects(loadGameAchievements(owner, new AbortController().signal), error => error.status === 401);
  const invalid = payload(); invalid.achievements[8] = invalid.achievements[7];
  globalThis.fetch = async () => Response.json(invalid);
  await assert.rejects(loadGameAchievements(owner, new AbortController().signal), error => error.status === 502);
  const controller = new AbortController(); controller.abort();
  globalThis.fetch = async (_url, options) => { assert.equal(options.signal.aborted, true); throw new DOMException("Cancelled", "AbortError"); };
  await assert.rejects(loadGameAchievements(owner, controller.signal), error => error.name === "AbortError");
});
