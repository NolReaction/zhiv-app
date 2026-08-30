import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({
  appType: "custom",
  configFile: false,
  root,
  resolve: { alias: { "@": root } },
  server: { middlewareMode: true, hmr: false },
});

const presentation = await vite.ssrLoadModule("/lib/check-in-presentation.ts");
const clicker = await vite.ssrLoadModule("/lib/clicker-story.ts");
const tapInput = await vite.ssrLoadModule("/lib/tap-input.ts");
const dailyStreak = await vite.ssrLoadModule("/lib/daily-streak.ts");
const devApiOrigin = await vite.ssrLoadModule("/lib/dev-api-origin.ts");
const groupInput = await vite.ssrLoadModule("/lib/group-input.ts");

after(async () => {
  await vite.close();
});

test("normalizes a human name without making it an identifier", () => {
  assert.equal(presentation.normalizeDisplayName("  Анна   Мария  "), "Анна Мария");
  assert.equal(presentation.normalizeDisplayName("Анна\u00a0Мария"), "Анна Мария");
  assert.equal(presentation.isValidDisplayName("Я"), true);
  assert.equal(presentation.isValidDisplayName(" "), false);
  assert.equal(presentation.isValidDisplayName("Дима\nАдмин"), false);
  assert.equal(presentation.isValidDisplayName("🙂".repeat(50)), true);
  assert.equal(presentation.isValidDisplayName("🙂".repeat(51)), false);
  assert.equal(presentation.limitDisplayNameInput("🙂".repeat(51)), "🙂".repeat(50));
});

test("formats an exact public ID without accepting trailing symbols", () => {
  assert.equal(presentation.normalizePublicId("7k3p 2q9m w8zr"), "7K3P-2Q9M-W8ZR");
  assert.equal(presentation.isValidPublicId("7K3P-2Q9M-W8ZR"), true);
  assert.equal(presentation.isValidPublicId("7K3P-2Q9M-W8ZRO"), false);
  assert.equal(
    presentation.isValidPublicId(presentation.normalizePublicId("7K3P-2Q9M-W8ZR-X")),
    false,
  );
});

test("makes public ID separators optional without hiding input mistakes", () => {
  assert.equal(presentation.formatPublicIdInput("4htd-"), "4HTD-");
  assert.equal(presentation.formatPublicIdInput("4htdx"), "4HTD-X");
  assert.equal(presentation.formatPublicIdInput("4HTD-XTP7-"), "4HTD-XTP7-");
  assert.equal(presentation.formatPublicIdInput("4HTD"), "4HTD");

  const overlong = presentation.formatPublicIdInput("7K3P2Q9MW8ZRX");
  assert.equal(overlong, "7K3P-2Q9M-W8ZR-X");
  assert.equal(presentation.isValidPublicId(overlong), false);
});

test("filters group invitees by a forgiving display-name search", () => {
  assert.equal(groupInput.matchesGroupPeopleSearch("Алёна Смирнова", "алена"), true);
  assert.equal(groupInput.matchesGroupPeopleSearch("Анна Мария", "  МАРИЯ   анна "), true);
  assert.equal(groupInput.matchesGroupPeopleSearch("Анна Мария", "марина"), false);
  assert.equal(groupInput.matchesGroupPeopleSearch("Любой человек", ""), true);
});

test("describes another person's check-in without leaking a hidden timestamp", () => {
  const now = Date.parse("2026-08-28T14:00:00.000Z");
  assert.equal(
    presentation.formatPersonCheckIn("2026-08-28T13:55:00.000Z", now, true),
    "5 мин назад",
  );
  assert.equal(
    presentation.formatPersonCheckIn("2026-08-28T13:55:00.000Z", now, false),
    "Отметки недоступны",
  );
  assert.equal(
    presentation.formatDirectPersonCheckIn(null, now, "WAITING_INITIAL"),
    "После добавления ещё не отмечался",
  );
  assert.equal(
    presentation.formatDirectPersonCheckIn(null, now, "WAITING_AFTER_REENABLE"),
    "Ждём новую отметку после включения доступа",
  );
  assert.equal(
    presentation.formatDirectPersonCheckIn(null, now, "HIDDEN"),
    "Отметки недоступны",
  );
  assert.equal(
    presentation.formatDirectPersonCheckIn(
      "2026-08-28T13:55:00.000Z",
      now,
      "AVAILABLE",
    ),
    "5 мин назад",
  );
});

test("moves from neutral to green, amber and red over 24 hours", () => {
  assert.equal(presentation.getCheckInColor(null), "#4a4e45");
  assert.equal(presentation.getCheckInColor(0), "hsl(140.0 68% 34%)");
  assert.equal(
    presentation.getCheckInColor(12 * 60 * 60 * 1_000),
    "hsl(45.0 68% 34%)",
  );
  assert.equal(
    presentation.getCheckInColor(24 * 60 * 60 * 1_000),
    "hsl(0.0 68% 34%)",
  );
  assert.equal(
    presentation.getCheckInColor(48 * 60 * 60 * 1_000),
    "hsl(0.0 68% 34%)",
  );
});

test("never reports a negative age when client clock is ahead or behind", () => {
  const checkedAt = "2026-08-28T13:26:00.000Z";
  assert.equal(
    presentation.getCheckInAgeMs(checkedAt, 0, Date.parse(checkedAt) - 5_000),
    0,
  );
});

test("offers twenty-four complete stories on the exact series milestones", () => {
  assert.equal(clicker.CLICKER_STORIES.length, 24);
  const expectedMilestones = [1, 5, 10, 20, 50, 100, 500, 1_000, 10_000, 100_000];
  const titles = new Set();
  const ids = new Set();

  for (const story of clicker.CLICKER_STORIES) {
    titles.add(story.title);
    ids.add(story.id);
    assert.deepEqual(story.scenes.map((scene) => scene.at), expectedMilestones);
    assert.equal(new Set(story.scenes.map((scene) => scene.message)).size, story.scenes.length);
  }
  assert.equal(titles.size, clicker.CLICKER_STORIES.length);
  assert.equal(ids.size, clicker.CLICKER_STORIES.length);
});

test("keeps one linear story through 1, 5, 10, 20, 50, 100, 500 and beyond", () => {
  const initial = clicker.createClickerRun(0);
  const at100 = clicker.advanceClickerRun(initial, 1_000, 100).progress;
  const at499 = clicker.advanceClickerRun(at100, 1_100, 399).progress;
  const at500 = clicker.advanceClickerRun(at499, 1_200).progress;

  assert.equal(clicker.getClickerFrame(at100).storyId, "space");
  assert.equal(clicker.getClickerFrame(at100).nextMilestone, 500);
  assert.equal(clicker.getClickerFrame(at499).message, clicker.getClickerFrame(at100).message);
  assert.equal(clicker.getClickerFrame(at500).storyId, "space");
  assert.equal(clicker.getClickerFrame(at500).nextMilestone, 1_000);
  assert.equal(clicker.getClickerTransitionEffect(499, 500), "orbit");
});

test("shows an exact clamped idle budget and resets it on every tap", () => {
  let run = clicker.advanceClickerRun(clicker.createClickerRun(), 1_000, 12).progress;
  assert.deepEqual(
    clicker.getClickerSeriesTimer(clicker.createClickerRun(), 1_000),
    { remainingMs: 0, remainingRatio: 0 },
  );
  assert.deepEqual(
    clicker.getClickerSeriesTimer(run, 1_000),
    { remainingMs: 30_000, remainingRatio: 1 },
  );
  assert.deepEqual(
    clicker.getClickerSeriesTimer(run, 16_000),
    { remainingMs: 15_000, remainingRatio: 0.5 },
  );
  assert.equal(clicker.getClickerSeriesTimer(run, 30_999).remainingMs, 1);
  assert.deepEqual(
    clicker.getClickerSeriesTimer(run, 31_000),
    { remainingMs: 0, remainingRatio: 0 },
  );
  assert.equal(clicker.getClickerSeriesTimer(run, 0).remainingRatio, 1);

  run = clicker.advanceClickerRun(run, 16_000).progress;
  assert.deepEqual(
    clicker.getClickerSeriesTimer(run, 16_000),
    { remainingMs: 30_000, remainingRatio: 1 },
  );
});

test("gives every milestone from fifty onward its own celebration", () => {
  const milestones = [50, 100, 500, 1_000, 10_000, 100_000];
  const effects = milestones.map((at) => clicker.getClickerTransitionEffect(at - 1, at));
  assert.deepEqual(effects, ["sparks", "finale", "orbit", "comet", "legend", "champion"]);
  assert.equal(new Set(effects).size, milestones.length);
  for (const at of [51, 99, 101, 499, 501, 999, 1_001]) {
    assert.equal(clicker.getClickerTransitionEffect(at - 1, at), null);
  }
});

test("counts every touch contact once without duplicating its compatibility click", () => {
  assert.equal(tapInput.shouldCountGamePointer("touch"), true);
  assert.equal(tapInput.shouldCountGamePointer("mouse"), false);
  assert.equal(tapInput.shouldCountGamePointer("pen"), false);
  assert.equal(tapInput.shouldCountGameClick(1, 1_500, 1_000), false);
  assert.equal(tapInput.shouldCountGameClick(1, 1_900, 1_000), true);
  assert.equal(tapInput.shouldCountGameClick(0, 1_001, 1_000), true);
});

test("keeps an active clicker run local even after server cooldown ends", () => {
  const idle = clicker.createClickerRun();
  assert.equal(clicker.planClickerTap(idle, false, 1_000), "REQUEST_SERVER");
  assert.equal(clicker.planClickerTap(idle, true, 1_000), "START_LOCAL");
  const active = clicker.advanceClickerRun(idle, 900).progress;
  assert.equal(clicker.planClickerTap(active, false, 1_000), "ADVANCE_LOCAL");
  assert.equal(clicker.planClickerTap(active, false, 1_000, true), "REQUEST_SERVER");
});

test("ends a series exactly after thirty idle seconds and starts the next at one", () => {
  const eventId = "4a272b65-8ada-4b0d-aad8-6a6ef845f41b";
  const started = clicker.advanceClickerRun(
    clicker.createClickerRun(0),
    1_000,
    12,
    eventId,
  ).progress;
  const beforeDeadline = clicker.expireClickerSeries(
    started,
    1_000 + clicker.CLICKER_IDLE_RESET_MS - 1,
  );
  assert.equal(beforeDeadline.progress, started);
  assert.equal(beforeDeadline.finishedSeries, null);

  const atDeadline = clicker.expireClickerSeries(
    started,
    1_000 + clicker.CLICKER_IDLE_RESET_MS,
  );
  assert.equal(atDeadline.progress.activeSeries, null);
  assert.equal(atDeadline.progress.bestSeries, 12);
  assert.equal(atDeadline.finishedSeries.tapCount, 12);
  assert.equal(atDeadline.finishedSeries.eventId, eventId);

  const restarted = clicker.advanceClickerRun(
    atDeadline.progress,
    1_000 + clicker.CLICKER_IDLE_RESET_MS + 1,
  ).progress;
  assert.equal(restarted.activeSeries.tapCount, 1);
  assert.notEqual(restarted.activeSeries.storyId, started.activeSeries.storyId);
});

test("keeps the best series across weaker and stronger attempts", () => {
  let progress = clicker.advanceClickerRun(clicker.createClickerRun(4), 1_000, 12).progress;
  progress = clicker.expireClickerSeries(progress, 31_000).progress;
  progress = clicker.advanceClickerRun(progress, 32_000, 8).progress;
  progress = clicker.expireClickerSeries(progress, 62_000).progress;
  assert.equal(progress.bestSeries, 12);
  progress = clicker.advanceClickerRun(progress, 63_000, 13).progress;
  assert.equal(progress.bestSeries, 13);
});

test("keeps the newest in-memory tap when multi-touch shares one millisecond", () => {
  const stored = clicker.advanceClickerRun(clicker.createClickerRun(), 1_000, 50).progress;
  const current = clicker.advanceClickerRun(stored, 1_000).progress;
  const merged = clicker.mergeClickerProgress(stored, current);

  assert.equal(stored.updatedAtMs, current.updatedAtMs);
  assert.equal(merged.activeSeries.tapCount, 51);
  assert.equal(merged.bestSeries, 51);
});

test("caps one uninterrupted series at one hundred thousand", () => {
  const before = clicker.advanceClickerRun(clicker.createClickerRun(), 1_000, 99_999).progress;
  const champion = clicker.advanceClickerRun(before, 1_100);
  const after = clicker.advanceClickerRun(champion.progress, 1_200);

  assert.equal(champion.progress.activeSeries.tapCount, 100_000);
  assert.equal(champion.progress.bestSeries, 100_000);
  assert.equal(champion.effect, "champion");
  assert.equal(after.progress.activeSeries.tapCount, 100_000);
  assert.equal(after.effect, null);
  assert.equal(clicker.getClickerFrame(after.progress).nextMilestone, null);

  const expired = clicker.expireClickerSeries(after.progress, 31_200).progress;
  const restored = clicker.parseClickerProgress(clicker.serializeClickerProgress(expired));
  const restarted = clicker.advanceClickerRun(restored, 31_201).progress;
  assert.equal(restored.activeSeries, null);
  assert.equal(restored.bestSeries, 100_000);
  assert.equal(restarted.activeSeries.tapCount, 1);
  assert.notEqual(restarted.activeSeries.storyId, after.progress.activeSeries.storyId);
});

test("derives ten durable levels from the honest personal best", () => {
  const boundaries = [
    [0, 1], [4, 1], [5, 2], [10, 3], [20, 4], [50, 5], [100, 6],
    [500, 7], [1_000, 8], [10_000, 9], [100_000, 10],
  ];
  for (const [best, level] of boundaries) {
    assert.equal(clicker.getClickerLevel(best).level, level);
  }
});

test("round-trips v2 progress and never fabricates a record from v1 lifetime taps", () => {
  const active = clicker.advanceClickerRun(
    clicker.createClickerRun(4),
    1_000,
    19,
    "f38c672e-1106-486c-887b-160d3aa13f8b",
  ).progress;
  const serialized = clicker.serializeClickerProgress(active);
  assert.deepEqual(clicker.parseClickerProgress(serialized), active);
  const migrated = clicker.parseClickerProgress(
    JSON.stringify({ version: 1, totalTaps: 651, storySeed: 6 }),
    4_242,
  );
  assert.equal(migrated.activeSeries, null);
  assert.equal(migrated.bestSeries, 0);
  assert.equal(migrated.storySeed, 4_242);
  assert.equal(clicker.parseClickerProgress("{}"), null);
});

test("gives each user a stable full story rotation without early repeats", () => {
  const seed = clicker.clickerSeedFromPublicId("7K3P-2Q9M-W8ZR");
  const firstPass = Array.from(
    { length: clicker.CLICKER_STORIES.length },
    (_, index) => clicker.getStoryForSeries(seed, index).id,
  );
  assert.equal(new Set(firstPass).size, clicker.CLICKER_STORIES.length);
  assert.deepEqual(
    firstPass,
    Array.from(
      { length: clicker.CLICKER_STORIES.length },
      (_, index) => clicker.getStoryForSeries(seed, index).id,
    ),
  );
});

test("calculates a daily streak from distinct local dates and breaks after a missed day", () => {
  const nextDayAt = "2026-08-30T21:00:00.000Z";
  assert.deepEqual(
    dailyStreak.calculateDailyStreak(
      ["2026-08-27", "2026-08-28", "2026-08-28", "2026-08-29"],
      "2026-08-29",
      nextDayAt,
    ),
    {
      currentDays: 3,
      longestDays: 3,
      checkedInToday: true,
      nextDayAt,
    },
  );
  assert.equal(
    dailyStreak.calculateDailyStreak(["2026-08-27"], "2026-08-29", nextDayAt).currentDays,
    0,
  );
});

test("keeps yesterday's streak alive until the current local day ends", () => {
  const streak = dailyStreak.calculateDailyStreak(
    ["2026-08-27", "2026-08-28"],
    "2026-08-29",
    "2026-08-29T21:00:00.000Z",
  );
  assert.equal(streak.currentDays, 2);
  assert.equal(streak.checkedInToday, false);
  assert.equal(dailyStreak.formatDayCount(1), "1 день");
  assert.equal(dailyStreak.formatDayCount(22), "22 дня");
  assert.equal(dailyStreak.formatDayCount(15), "15 дней");
});

test("shows durable milestone copy only at sparse server-confirmed counts", () => {
  assert.equal(presentation.getCheckInMilestone(9), null);
  assert.equal(presentation.getCheckInMilestone(10), "Первая десятка. Полёт нормальный.");
  assert.equal(presentation.getCheckInMilestone(20), "20 отметок. Уже входит в привычку.");
  assert.equal(presentation.getCheckInMilestone(50), "Полтинник. Стабильно живой.");
  assert.equal(presentation.getCheckInMilestone(100), "Сотая отметка. Это уже традиция.");
  assert.equal(presentation.getCheckInMilestone(200), "200 отметок. Бессмертие набирает стаж.");
  assert.equal(presentation.getCheckInMilestone(500), "500 отметок. Железно на связи.");
  assert.equal(
    presentation.getCheckInMilestone(1_000),
    "Тысячная. Бессмертие подтверждено документально.",
  );
  assert.equal(presentation.getCheckInMilestone(2_000), "2000 отметок. Легендарная стабильность.");
  assert.equal(presentation.getCheckInMilestone(2_001), null);
  assert.equal(presentation.getCheckInMilestone(-1), null);
});

test("trusts the browser-facing localhost origin when Next binds to 0.0.0.0", () => {
  const browserRequest = new Request("http://0.0.0.0:3000/api/v1/bootstrap", {
    method: "POST",
    headers: {
      Host: "localhost:3000",
      "X-Forwarded-Host": "0.0.0.0:3000",
      Origin: "http://localhost:3000",
      "Sec-Fetch-Site": "same-origin",
    },
  });
  const proxiedRequest = new Request("http://0.0.0.0:3000/api/v1/bootstrap", {
    method: "POST",
    headers: {
      Host: "localhost:3000",
      "X-Forwarded-Host": "0.0.0.0:3000",
      Origin: "http://localhost:3000",
    },
  });

  assert.equal(devApiOrigin.isTrustedDevRequest(browserRequest), true);
  assert.equal(devApiOrigin.isTrustedDevRequest(proxiedRequest), true);
});

test("still rejects cross-site and mismatched dev API writes", () => {
  const crossSite = new Request("http://0.0.0.0:3000/api/v1/bootstrap", {
    method: "POST",
    headers: {
      Host: "localhost:3000",
      Origin: "https://attacker.example",
      "Sec-Fetch-Site": "cross-site",
    },
  });
  const mismatched = new Request("http://0.0.0.0:3000/api/v1/bootstrap", {
    method: "POST",
    headers: {
      Host: "localhost:3000",
      Origin: "https://attacker.example",
      "Sec-Fetch-Site": "same-site",
    },
  });

  assert.equal(devApiOrigin.isTrustedDevRequest(crossSite), false);
  assert.equal(devApiOrigin.isTrustedDevRequest(mismatched), false);
});
