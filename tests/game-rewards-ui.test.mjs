import assert from "node:assert/strict";
import test, { after, afterEach } from "node:test";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false } });
after(() => vite.close());
const { createDailyRewardEntryPrompt } = await vite.ssrLoadModule("/features/game/daily-reward-entry.ts");
const { createGameRewardsSession } = await vite.ssrLoadModule("/features/game/game-rewards-session.ts");
const api = await vite.ssrLoadModule("/features/game/game-rewards-api.ts");
const { DailyRewardsPanel, dailyRewardWait, RewardContents } = await vite.ssrLoadModule("/features/game/daily-rewards.tsx");
const { AchievementCard } = await vite.ssrLoadModule("/features/game/game-achievements.tsx");
const { GAME_ACHIEVEMENTS } = await vite.ssrLoadModule("/features/game/game-rewards.ts");
const { GAME_ACHIEVEMENT_TARGETS } = await vite.ssrLoadModule("/features/game/achievement-progress.ts");
const { economyCatalog } = await vite.ssrLoadModule("/features/economy/model.ts");
const { ApiError } = await vite.ssrLoadModule("/lib/check-in-api.ts");
const fetchOriginal = globalThis.fetch;
afterEach(() => { globalThis.fetch = fetchOriginal; });
const owner = "AAAA-0000-0001", other = "AAAA-0000-0002", at = "2026-10-05T12:00:00.000Z", clock = Date.parse(at);
const reward = { coins: 10, pearls: 0, items: {} };
function view(step = 1, claimable = true, ownerPublicId = owner) {
  return { ownerPublicId, serverTime: at, catalogVersion: 1,
    daily: { step, claimable, nextClaimAt: new Date(clock + (claimable ? 0 : 86_400_000)).toISOString(), lastClaimAt: null, lastClaimDate: null,
      reward, cycle: Array.from({ length: 7 }, (_, index) => ({ step: index + 1, reward: index === 6 ? { ...reward, pearls: 2 } : reward })) },
    achievementRewards: Object.entries(GAME_ACHIEVEMENT_TARGETS).flatMap(([achievementId, targets]) => targets.map((target, index) => ({
      achievementId, level: index + 1, target, pearls: achievementId === "full_collection" ? 0 : index + 1, earnedAt: achievementId === "explorer" ? at : null,
      claimedAt: null, eligible: achievementId === "explorer", blockedReason: achievementId === "full_collection" ? "no_reward" : achievementId === "explorer" ? null : "not_earned" }))) };
}
function economy(revision = 1, ownerPublicId = owner) {
  return { ownerPublicId, revision, serverTime: at, wallet: { coins: 10, pearls: 1 }, inventory: {}, buildings: { home: 1, garden: 1, warehouse: 1, kiln: 0 },
    storage: { capacity: 200, used: 0, reserved: 0, available: 200, overflow: 0 }, jobs: [],
    migration: { version: 1, coinsGranted: 0, woodGranted: 0, stoneGranted: 0 }, catalog: economyCatalog, completedExplorations: 0 };
}
function receipt(command, data = view(2, false), replayed = false) {
  return { requestId: command.requestId, rewards: data, economy: economy(1, data.ownerPublicId), acceptedRevision: 1, replayed,
    claim: command.kind === "daily" ? { kind: "daily", step: 1, reward, claimedAt: at }
      : { kind: "achievement", achievementId: command.achievementId, level: command.level, reward: { coins: 0, pearls: command.level, items: {} }, claimedAt: at }, message: "Награда получена" };
}
function cache() { const data = new Map(); return { data, getItem: key => data.get(key) ?? null, setItem: (key, value) => data.set(key, value), removeItem: key => data.delete(key) }; }
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
const transport = overrides => ({ get: async () => view(), send: async command => receipt(command), ...overrides });
const controller = (data = view(), patch = {}) => ({ data, loading: false, busy: false, uncertain: false, pending: null, error: "", result: null, retryAt: 0,
  now: clock, refresh() {}, claimDaily() {}, claimAchievement() {}, retry() {}, ...patch });
const render = (component, props) => renderToStaticMarkup(createElement(component, props));

test("opening, reading, and restoring a pending reward never issue money automatically", async () => {
  let writes = 0;
  const session = createGameRewardsSession(owner, transport({ send: async command => { writes++; return receipt(command); } }));
  const stop = session.activate(); await session.refresh(); await session.refresh();
  assert.equal(writes, 0); assert.equal(session.getSnapshot().data.daily.claimable, true); stop();
});
test("lost response remains the same exact receipt after remount and read; other claims stay blocked", async () => {
  const storage = cache(), sent = []; let data = view();
  const wire = transport({ get: async () => data, send: async command => {
    sent.push(structuredClone(command)); data = view(2, false);
    if (sent.length === 1) throw Error("Lost after commit");
    return receipt(command, data, true);
  } });
  const first = createGameRewardsSession(owner, wire, storage), close = first.activate(); await first.refresh(); await first.claimDaily();
  assert.equal(first.getSnapshot().uncertain, true); assert.equal(storage.data.size, 1);
  await first.claimAchievement("explorer", 1); assert.equal(sent.length, 1); close();
  const next = createGameRewardsSession(owner, wire, storage), stop = next.activate(); await next.refresh();
  assert.equal(next.getSnapshot().uncertain, true); assert.equal(sent.length, 1, "GET does not clear or replay the pending command");
  const result = await next.retry(); assert.equal(result.replayed, true); assert.deepEqual(sent[0], sent[1]);
  assert.equal(next.getSnapshot().pending, null); assert.equal(next.getSnapshot().uncertain, false); assert.equal(storage.data.size, 0); stop();
});
test("rapid daily and achievement clicks serialize to one manual claim", async () => {
  const wait = deferred(); let writes = 0, command;
  const session = createGameRewardsSession(owner, transport({ send: body => { writes++; command = body; return wait.promise; } }));
  const stop = session.activate(); await session.refresh();
  const first = session.claimDaily(); await session.claimDaily(); await session.claimAchievement("explorer", 1);
  assert.equal(writes, 1); assert.equal(session.getSnapshot().busy, true);
  wait.resolve(receipt(command)); await first; assert.equal(session.getSnapshot().busy, false); stop();
});
test("late reads cannot overwrite the state returned by a confirmed claim", async () => {
  const wait = deferred(); let reads = 0;
  const session = createGameRewardsSession(owner, transport({ get: () => ++reads === 1 ? Promise.resolve(view()) : wait.promise }));
  const stop = session.activate(); await session.refresh(); const staleRead = session.refresh(); await session.claimDaily();
  wait.resolve(view()); await staleRead; assert.equal(session.getSnapshot().data.daily.step, 2); stop();
});
test("an echo mismatch stays recoverable and never clears a reward receipt", async () => {
  const session = createGameRewardsSession(owner, transport({ send: async command => ({ ...receipt(command), requestId: crypto.randomUUID() }) }));
  const stop = session.activate(); await session.refresh(); await session.claimDaily();
  assert.equal(session.getSnapshot().uncertain, true); assert.ok(session.getSnapshot().pending); assert.equal(session.getSnapshot().result, null); stop();
});
test("terminal 409 refreshes the server state without silently claiming the next gift", async () => {
  let writes = 0, reads = 0;
  const session = createGameRewardsSession(owner, transport({ get: async () => ++reads === 1 ? view() : view(2, false), send: async () => { writes++; throw new ApiError("Уже получено", 409); } }));
  const stop = session.activate(); await session.refresh(); await session.claimDaily(); await session.retry();
  assert.equal(writes, 1); assert.equal(session.getSnapshot().uncertain, false); assert.equal(session.getSnapshot().pending, null);
  assert.equal(session.getSnapshot().data.daily.claimable, false); stop();
});
test("429 keeps the receipt and respects the retry delay", async () => {
  let writes = 0;
  const session = createGameRewardsSession(owner, transport({ send: async () => { writes++; throw new ApiError("Позже", 429, undefined, undefined, 60_000); } }));
  const stop = session.activate(); await session.refresh(); await session.claimDaily(); await session.retry();
  assert.equal(writes, 1); assert.equal(session.getSnapshot().uncertain, true); assert.ok(session.getSnapshot().retryAt > clock + 55_000); stop();
});
test("account changes suppress late replies and never restore another account receipt", async () => {
  const wait = deferred(), storage = cache(); let body;
  const first = createGameRewardsSession(owner, transport({ send: command => { body = command; return wait.promise; } }), storage);
  const close = first.activate(); await first.refresh(); const write = first.claimDaily(); close();
  const next = createGameRewardsSession(other, transport({ get: async () => view(1, true, other) }), storage), stop = next.activate(); await next.refresh();
  wait.resolve(receipt(body)); await write;
  assert.equal(first.getSnapshot().result, null); assert.ok(first.getSnapshot().pending); assert.equal(next.getSnapshot().pending, null);
  assert.equal(next.getSnapshot().data.ownerPublicId, other); stop();
});
test("foreign owner reads and unauthorized responses never become visible", async () => {
  let lost = 0;
  const session = createGameRewardsSession(owner, transport({ get: async () => view(1, true, other) }));
  session.onSessionLost(() => lost++); const stop = session.activate(); await session.refresh();
  assert.equal(lost, 1); assert.equal(session.getSnapshot().data, null); stop();
  const unauthorized = createGameRewardsSession(owner, transport({ get: async () => { throw new ApiError("Войдите", 401); } }));
  unauthorized.onSessionLost(() => lost++); const done = unauthorized.activate(); await unauthorized.refresh(); assert.equal(lost, 2); done();
});
test("closing one shared panel retains the other panel's identical auth callback", async () => {
  let lost = 0;
  const listener = () => lost++;
  const session = createGameRewardsSession(owner, transport({ get: async () => { throw new ApiError("Войдите", 401); } }));
  const unsubscribeFirst = session.onSessionLost(listener), unsubscribeSecond = session.onSessionLost(listener);
  unsubscribeFirst(); const stop = session.activate(); await session.refresh();
  assert.equal(lost, 1); unsubscribeSecond(); stop();
});
test("the daily panel contains seven steps, a real manual claim, and an explicit offline state", () => {
  const html = render(DailyRewardsPanel, { controller: controller(), isOnline: true });
  assert.equal([...html.matchAll(/class="[^\"]*day[^\"]*"/g)].length, 7);
  assert.match(html, /Забрать подарок/); assert.match(html, /Пропуск дня сохраняет ваш шаг/); assert.match(html, /20 часов/);
  assert.equal([...html.matchAll(/aria-current="step"/g)].length, 1);
  const offline = render(DailyRewardsPanel, { controller: controller(), isOnline: false });
  assert.match(offline, /Для получения нужен интернет/); assert.match(offline, /<button[^>]*disabled=""[^>]*>.*?Забрать подарок/);
});
test("client countdown cannot turn an unready server gift into an enabled claim", () => {
  const data = view(3, false); data.daily.nextClaimAt = at;
  const html = render(DailyRewardsPanel, { controller: controller(data, { now: clock + 60_000 }), isOnline: true });
  assert.doesNotMatch(html, /Забрать подарок/); assert.match(html, /Проверяем доступность/);
  assert.equal(dailyRewardWait("2026-10-05T13:30:00Z", clock), "Следующий подарок через 1 ч 30 мин");
});
test("uncertain daily UI offers recovery and blocks a new claim", () => {
  const pending = { requestId: crypto.randomUUID(), ownerPublicId: owner, kind: "daily" };
  const html = render(DailyRewardsPanel, { controller: controller(view(), { pending, uncertain: true }), isOnline: true });
  assert.match(html, /Проверить получение/); assert.match(html, /<button[^>]*disabled=""[^>]*>.*?Забрать подарок/);
});
test("closing the profile subscription leaves its mounted dialog claim and confirmation alive", async () => {
  const wait = deferred(); let command, aborted = false, confirmations = 0;
  const session = createGameRewardsSession(owner, transport({ send: (body, signal) => {
    command = body; signal.addEventListener("abort", () => { aborted = true; }); return wait.promise;
  } }));
  const closeDialog = session.activate(), closeProfile = session.activate(); await session.refresh();
  const claim = session.claimDaily().then(result => { if (result) confirmations++; });
  closeProfile(); assert.equal(aborted, false); assert.equal(session.getSnapshot().busy, true);
  wait.resolve(receipt(command)); await claim;
  assert.equal(confirmations, 1); assert.equal(session.getSnapshot().pending, null);
  assert.equal(session.getSnapshot().data.daily.step, 2); closeDialog();
});
test("historical earned stages expose one next claim without adding achievement cards", () => {
  const quest = GAME_ACHIEVEMENTS.find(row => row.id === "explorer"), rewardRows = view().achievementRewards.filter(row => row.achievementId === quest.id);
  const state = { id: quest.id, target: 200, progress: 200, unlockedAt: at,
    tiers: quest.tiers.map((target, index) => ({ level: index + 1, target, progress: target, unlockedAt: at })) };
  const html = render(AchievementCard, { quest, state, rewardRows, onClaim() {} });
  assert.equal([...html.matchAll(/<article/g)].length, 1); assert.equal([...html.matchAll(/<button/g)].length, 1);
  assert.match(html, /Забрать I/); assert.match(html, /data-item-icon="pearls"/);
  const admin = render(AchievementCard, { quest, state, rewardRows: rewardRows.map(row => ({ ...row, eligible: false, blockedReason: "admin_grant" })), onClaim() {} });
  assert.doesNotMatch(admin, /<button/); assert.match(admin, /после выполнения цели/);
});
test("reward schema rejects duplicate tiers, invalid eligibility, and client-supplied prices", () => {
  assert.equal(api.gameRewardsSchema.safeParse(view()).success, true);
  const duplicate = view(); duplicate.achievementRewards[1] = duplicate.achievementRewards[0];
  assert.equal(api.gameRewardsSchema.safeParse(duplicate).success, false);
  const notEarned = view(); notEarned.achievementRewards[0].eligible = true;
  assert.equal(api.gameRewardsSchema.safeParse(notEarned).success, false);
  assert.equal(api.gameRewardClaimSchema.safeParse({ requestId: crypto.randomUUID(), ownerPublicId: owner, kind: "daily", coins: 999 }).success, false);
});
test("client API uses private no-store reads and validates receipt echo payload", async () => {
  const calls = [], command = { requestId: crypto.randomUUID(), ownerPublicId: owner, kind: "daily" };
  globalThis.fetch = async (path, options) => { calls.push({ path, options }); return Response.json(options.method === "GET" ? view() : receipt(command)); };
  await api.getGameRewards(); const result = await api.claimGameReward(command);
  assert.equal(result.requestId, command.requestId); assert.equal(calls[0].path, "/api/v1/game/rewards");
  assert.equal(calls[0].options.credentials, "same-origin"); assert.equal(calls[0].options.cache, "no-store");
  assert.equal(calls[1].path, "/api/v1/game/rewards/claims"); assert.deepEqual(JSON.parse(calls[1].options.body), command);
});


test("unclaimed daily gift prompts on each world entry after a fresh read, never on each poll", async () => {
  let data = view(), reads = 0, writes = 0;
  const session = createGameRewardsSession(owner, transport({ get: async () => { reads++; return data; }, send: async command => { writes++; return receipt(command); } }));
  const stop = session.activate();
  const firstVisit = createDailyRewardEntryPrompt(owner, session.getSnapshot().readVersion);
  assert.equal(firstVisit.shouldOpen(session.getSnapshot(), true), false);
  await session.refresh(); assert.equal(firstVisit.shouldOpen(session.getSnapshot(), true), true);
  await session.refresh(); assert.equal(firstVisit.shouldOpen(session.getSnapshot(), true), false, "dismissal lasts for this visit");
  const nextVisit = createDailyRewardEntryPrompt(owner, session.getSnapshot().readVersion);
  assert.equal(nextVisit.shouldOpen(session.getSnapshot(), true), false, "cached availability may belong to a previous visit");
  await session.refresh(); assert.equal(nextVisit.shouldOpen(session.getSnapshot(), true), true, "an unclaimed gift returns next visit");
  const paidVisit = createDailyRewardEntryPrompt(owner, session.getSnapshot().readVersion);
  data = view(2, false); await session.refresh(); assert.equal(paidVisit.shouldOpen(session.getSnapshot(), true), false);
  assert.equal(writes, 0); assert.equal(reads, 4); stop();
});

test("entry prompt waits online for its owner and respects a manually opened gift", () => {
  const state = { data: view(), readVersion: 2, loading: false, busy: false, pending: null, uncertain: false };
  const prompt = createDailyRewardEntryPrompt(owner, 1);
  assert.equal(prompt.shouldOpen(state, false), false);
  assert.equal(prompt.shouldOpen({ ...state, data: view(1, true, other) }, true), false);
  assert.equal(prompt.shouldOpen({ ...state, loading: true }, true), false);
  assert.equal(prompt.shouldOpen({ ...state, busy: true }, true), false);
  prompt.dismiss(); assert.equal(prompt.shouldOpen(state, true), false);
  const pending = { requestId: crypto.randomUUID(), ownerPublicId: owner, kind: "daily" };
  const recovery = createDailyRewardEntryPrompt(owner, 1);
  assert.equal(recovery.shouldOpen({ ...state, data: view(2, false), pending, uncertain: true }, true), true, "a committed but unconfirmed daily gift opens recovery");
  const achievement = createDailyRewardEntryPrompt(owner, 1);
  assert.equal(achievement.shouldOpen({ ...state, pending: { ...pending, kind: "achievement" }, uncertain: true }, true), false, "daily prompt does not hijack an achievement receipt");
});

test("daily gifts and achievement claims display half pearl units without rounding odd balances", () => {
  const reward = { coins: 175, pearls: 51, items: { wood: 6 } };
  const html = render(RewardContents, { reward, names: { wood: "Древесина" } });
  assert.match(html, /<strong>175<\/strong><small>Монеты/);
  assert.match(html, /<strong>25,5<\/strong><small>Жемчуг/);
  assert.match(html, /<strong>6<\/strong><small>Древесина/);
  assert.equal(reward.pearls, 51);
  const quest = GAME_ACHIEVEMENTS.find(row => row.id === "explorer");
  const rewardRows = view().achievementRewards.filter(row => row.achievementId === quest.id).map(row => ({ ...row, pearls: 51 }));
  const card = render(AchievementCard, { quest, rewardRows, onClaim() {} });
  assert.match(card, /aria-label="Получить 25,5 жемчужин/);
  assert.match(card, /<strong>25,5<\/strong>/);
  assert.ok(rewardRows.every(row => row.pearls === 51));
});
