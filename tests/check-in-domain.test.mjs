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

test("retains neutral series milestones without narrative content", () => {
  assert.equal(clicker.CLICKER_STORIES.length, 1);
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

test("keeps clicker milestones and effects after removing stories", () => {
  const initial = clicker.createClickerRun(0);
  const at100 = clicker.advanceClickerRun(initial, 1_000, 100).progress;
  const at499 = clicker.advanceClickerRun(at100, 1_100, 399).progress;
  const at500 = clicker.advanceClickerRun(at499, 1_200).progress;

  assert.equal(clicker.getClickerFrame(at100).storyId, "clicker");
  assert.equal(clicker.getClickerFrame(at100).nextMilestone, 500);
  assert.equal(clicker.getClickerFrame(at499).message, clicker.getClickerFrame(at100).message);
  assert.equal(clicker.getClickerFrame(at500).storyId, "clicker");
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
  assert.equal(restarted.activeSeries.storyId, started.activeSeries.storyId);
});

test("keeps lifetime taps independent from the best series across attempts", () => {
  let progress = clicker.advanceClickerRun(clicker.createClickerRun(4), 1_000, 6).progress;
  assert.equal(progress.lifetimeTaps, 6);
  assert.equal(progress.bestSeries, 6);

  progress = clicker.expireClickerSeries(progress, 31_000).progress;
  progress = clicker.advanceClickerRun(progress, 32_000, 4).progress;
  progress = clicker.expireClickerSeries(progress, 62_000).progress;
  assert.equal(progress.lifetimeTaps, 10);
  assert.equal(progress.bestSeries, 6);
  assert.equal(clicker.getClickerLevel(progress.lifetimeTaps).level, 2);
  assert.equal(clicker.getClickerLevel(progress.bestSeries).level, 1);

  progress = clicker.advanceClickerRun(progress, 63_000, 13).progress;
  assert.equal(progress.lifetimeTaps, 23);
  assert.equal(progress.bestSeries, 13);
});

test("keeps the newest in-memory tap when multi-touch shares one millisecond", () => {
  const stored = clicker.advanceClickerRun(clicker.createClickerRun(), 1_000, 50).progress;
  const current = clicker.advanceClickerRun(stored, 1_000).progress;
  const merged = clicker.mergeClickerProgress(stored, current);

  assert.equal(stored.updatedAtMs, current.updatedAtMs);
  assert.equal(merged.activeSeries.tapCount, 51);
  assert.equal(merged.lifetimeTaps, 51);
  assert.equal(merged.bestSeries, 51);
});

test("caps one uninterrupted series at one hundred thousand", () => {
  const before = clicker.advanceClickerRun(clicker.createClickerRun(), 1_000, 99_999).progress;
  const champion = clicker.advanceClickerRun(before, 1_100);
  const after = clicker.advanceClickerRun(champion.progress, 1_200);

  assert.equal(champion.progress.activeSeries.tapCount, 100_000);
  assert.equal(champion.progress.lifetimeTaps, 100_000);
  assert.equal(champion.progress.bestSeries, 100_000);
  assert.equal(champion.effect, "champion");
  assert.equal(after.progress.activeSeries.tapCount, 100_000);
  assert.equal(after.progress.lifetimeTaps, 100_001);
  assert.equal(after.progress.bestSeries, 100_000);
  assert.equal(after.effect, null);
  assert.equal(clicker.getClickerFrame(after.progress).nextMilestone, null);

  const expired = clicker.expireClickerSeries(after.progress, 31_200).progress;
  const restored = clicker.parseClickerProgress(clicker.serializeClickerProgress(expired));
  const restarted = clicker.advanceClickerRun(restored, 31_201).progress;
  assert.equal(restored.activeSeries, null);
  assert.equal(restored.bestSeries, 100_000);
  assert.equal(restarted.activeSeries.tapCount, 1);
  assert.equal(restarted.activeSeries.storyId, after.progress.activeSeries.storyId);
});

test("derives ten durable levels from lifetime taps", () => {
  const levels = [
    [0, 1, "Новичок"],
    [10, 2, "Искра"],
    [25, 3, "Ритм"],
    [50, 4, "Импульс"],
    [100, 5, "Сотник"],
    [250, 6, "Разгон"],
    [500, 7, "Марафонец"],
    [1_000, 8, "Тысячник"],
    [2_500, 9, "Титан"],
    [5_000, 10, "Чемпион"],
  ];

  assert.deepEqual(
    clicker.CLICKER_LEVELS.map(({ minimumLifetimeTaps, level, title }) => [
      minimumLifetimeTaps,
      level,
      title,
    ]),
    levels,
  );
  for (let index = 0; index < levels.length; index += 1) {
    const [minimum, level, title] = levels[index];
    assert.equal(clicker.getClickerLevel(minimum).level, level);
    assert.equal(clicker.getClickerLevel(minimum).title, title);
    const nextMinimum = levels[index + 1]?.[0];
    if (nextMinimum !== undefined) {
      assert.equal(clicker.getClickerLevel(nextMinimum - 1).level, level);
    }
  }
});

test("calculates level progress inside the current lifetime segment", () => {
  assert.deepEqual(clicker.getClickerLevelProgress(0), {
    current: 0,
    minimum: 0,
    maximum: 10,
    ratio: 0,
    remaining: 10,
  });
  assert.deepEqual(clicker.getClickerLevelProgress(20), {
    current: 20,
    minimum: 10,
    maximum: 25,
    ratio: 2 / 3,
    remaining: 5,
  });
  assert.deepEqual(clicker.getClickerLevelProgress(25), {
    current: 25,
    minimum: 25,
    maximum: 50,
    ratio: 0,
    remaining: 25,
  });
  assert.deepEqual(clicker.getClickerLevelProgress(5_000), {
    current: 5_000,
    minimum: 5_000,
    maximum: 5_000,
    ratio: 1,
    remaining: 0,
  });
});

test("round-trips v3 and migrates v1 and v2 progress without inventing taps", () => {
  const active = clicker.advanceClickerRun(
    clicker.createClickerRun(4),
    1_000,
    19,
    "f38c672e-1106-486c-887b-160d3aa13f8b",
  ).progress;
  const serialized = clicker.serializeClickerProgress(active);
  const versionThree = JSON.parse(serialized);
  assert.equal(versionThree.version, 3);
  assert.equal(versionThree.lifetimeTaps, 19);
  assert.deepEqual(clicker.parseClickerProgress(serialized), active);

  const versionTwoPayload = { ...versionThree, version: 2 };
  delete versionTwoPayload.lifetimeTaps;
  const versionTwo = clicker.parseClickerProgress(
    JSON.stringify(versionTwoPayload),
    4_242,
  );
  assert.equal(versionTwo.lifetimeTaps, 19);
  assert.equal(versionTwo.bestSeries, 19);
  assert.deepEqual(versionTwo.activeSeries, active.activeSeries);
  assert.equal(versionTwo.storySeed, 4);

  const versionOne = clicker.parseClickerProgress(
    JSON.stringify({ version: 1, totalTaps: 651, storySeed: 6 }),
    4_242,
  );
  assert.equal(versionOne.lifetimeTaps, 651);
  assert.equal(versionOne.activeSeries, null);
  assert.equal(versionOne.bestSeries, 0);
  assert.equal(versionOne.storySeed, 4_242);

  const combined = clicker.combineLegacyClickerProgress(versionTwo, versionOne, 4_242);
  assert.equal(combined.lifetimeTaps, 670);
  assert.equal(combined.bestSeries, 19);
  assert.deepEqual(combined.activeSeries, active.activeSeries);
  assert.equal(combined.storySeed, 4);
  assert.equal(JSON.parse(clicker.serializeClickerProgress(combined)).version, 3);

  const saturated = clicker.combineLegacyClickerProgress(
    versionTwo,
    clicker.parseClickerProgress(JSON.stringify({
      version: 1,
      totalTaps: Number.MAX_SAFE_INTEGER,
      storySeed: 6,
    })),
  );
  assert.equal(saturated.lifetimeTaps, Number.MAX_SAFE_INTEGER);

  assert.equal(clicker.parseClickerProgress(JSON.stringify({
    ...versionThree,
    lifetimeTaps: versionThree.bestSeries - 1,
  })), null);
  assert.equal(clicker.parseClickerProgress("{}"), null);
});

test("ignores legacy story seeds while preserving neutral series", () => {
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

test("keeps a rolling streak active through the exact twenty-four-hour boundary", () => {
  const first = "2026-08-27T12:00:00.000Z";
  const exactDeadline = "2026-08-28T12:00:00.000Z";
  const afterDeadline = "2026-08-28T12:00:00.001Z";

  assert.deepEqual(dailyStreak.calculateRollingStreak(
    [first],
    new Date(exactDeadline),
  ), {
    currentDays: 1,
    longestDays: 1,
    isActive: true,
    renewBy: exactDeadline,
  });
  assert.deepEqual(dailyStreak.calculateRollingStreak(
    [first],
    new Date(afterDeadline),
  ), {
    currentDays: 0,
    longestDays: 1,
    isActive: false,
    renewBy: null,
  });

  const renewedExactly = dailyStreak.calculateRollingStreak(
    [first, exactDeadline],
    new Date(exactDeadline),
  );
  assert.equal(renewedExactly.currentDays, 2);
  assert.equal(renewedExactly.longestDays, 2);
  assert.equal(renewedExactly.renewBy, "2026-08-29T12:00:00.000Z");

  const restartedLate = dailyStreak.calculateRollingStreak(
    [first, afterDeadline],
    new Date(afterDeadline),
  );
  assert.equal(restartedLate.currentDays, 1);
  assert.equal(restartedLate.longestDays, 1);
});

test("same-day repeats extend the rolling deadline without inflating days", () => {
  const streak = dailyStreak.calculateRollingStreak([
    "2026-08-27T12:00:00.000Z",
    "2026-08-27T12:00:30.000Z",
    "2026-08-27T18:00:00.000Z",
    "2026-08-28T11:59:59.999Z",
    "2026-08-28T11:59:59.999Z",
  ], new Date("2026-08-28T11:59:59.999Z"));

  assert.deepEqual(streak, {
    currentDays: 1,
    longestDays: 1,
    isActive: true,
    renewBy: "2026-08-29T11:59:59.999Z",
  });
});

test("counts elapsed rolling days and preserves the longest expired run", () => {
  const checkIns = [
    "2026-08-27T12:00:00.000Z",
    "2026-08-28T12:00:00.000Z",
    "2026-08-29T12:00:00.000Z",
  ];
  assert.deepEqual(
    dailyStreak.calculateRollingStreak(checkIns, new Date("2026-08-30T12:00:00.000Z")),
    {
      currentDays: 3,
      longestDays: 3,
      isActive: true,
      renewBy: "2026-08-30T12:00:00.000Z",
    },
  );
  assert.deepEqual(
    dailyStreak.calculateRollingStreak(checkIns, new Date("2026-08-30T12:00:00.001Z")),
    {
      currentDays: 0,
      longestDays: 3,
      isActive: false,
      renewBy: null,
    },
  );

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

test("0.4.5 story identifiers preserve existing counters and active series without narrative text", () => {
  const current = clicker.advanceClickerRun(clicker.createClickerRun(6), 1000, 19,
    "f38c672e-1106-486c-887b-160d3aa13f8b").progress;
  for (const legacy of clicker.LEGACY_CLICKER_STORY_IDS) {
    for (const version of [2, 3]) {
      const payload = {
        ...JSON.parse(clicker.serializeClickerProgress(current)),
        version, lifetimeTaps: 651, bestSeries: 200, completedSeries: 4,
        lastStoryId: legacy, activeSeries: { ...current.activeSeries, storyId: legacy },
      };
      if (version === 2) delete payload.lifetimeTaps;
      const restored = clicker.parseClickerProgress(JSON.stringify(payload));
      assert.ok(restored, legacy);
      assert.equal(restored.lifetimeTaps, version === 3 ? 651 : 200);
      assert.equal(restored.bestSeries, 200);
      assert.equal(restored.completedSeries, 4);
      assert.equal(restored.activeSeries.tapCount, 19);
      assert.equal(clicker.getClickerFrame(restored).storyTitle, "Серия");
      const next = clicker.advanceClickerRun(restored, 2000, 1).progress;
      assert.equal(next.lifetimeTaps, restored.lifetimeTaps + 1);
      assert.equal(next.activeSeries.tapCount, 20);
      assert.equal(next.activeSeries.storyId, "clicker");
      assert.equal(clicker.parseClickerProgress(clicker.serializeClickerProgress(next)).bestSeries, 200);
    }
  }
});
