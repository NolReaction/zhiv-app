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
const devApiOrigin = await vite.ssrLoadModule("/lib/dev-api-origin.ts");
const groupInput = await vite.ssrLoadModule("/lib/group-input.ts");

after(async () => {
  await vite.close();
});

test("normalizes a human name without making it an identifier", () => {
  assert.equal(presentation.normalizeDisplayName("  Анна   Мария  "), "Анна Мария");
  assert.equal(presentation.isValidDisplayName("Я"), true);
  assert.equal(presentation.isValidDisplayName(" "), false);
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

test("offers five complete clicker stories with the same sparse scene rhythm", () => {
  assert.equal(clicker.CLICKER_STORIES.length, 5);
  const expectedMilestones = [1, 5, 10, 20, 35, 50, 75, 100];
  const titles = new Set();

  for (const story of clicker.CLICKER_STORIES) {
    titles.add(story.title);
    assert.deepEqual(story.scenes.map((scene) => scene.at), expectedMilestones);
    assert.equal(new Set(story.scenes.map((scene) => scene.message)).size, story.scenes.length);
  }
  assert.equal(titles.size, clicker.CLICKER_STORIES.length);
});

test("keeps story copy stable between milestones and triggers effects only on a scene", () => {
  const run = clicker.createClickerRun(0);
  const at10 = clicker.getClickerFrame({ ...run, tapCount: 10 });
  const at19 = clicker.getClickerFrame({ ...run, tapCount: 19 });
  const at20 = clicker.getClickerFrame({ ...run, tapCount: 20 });
  const at21 = clicker.getClickerFrame({ ...run, tapCount: 21 });

  assert.equal(at10.message, "Двигатели запущены");
  assert.equal(at19.message, at10.message);
  assert.equal(at19.nextSceneAt, 20);
  assert.equal(at19.effect, null);
  assert.equal(at20.message, "Орбита достигнута");
  assert.equal(at20.effect, "rings");
  assert.equal(at21.message, at20.message);
  assert.equal(at21.effect, null);
});

test("keeps an active clicker run local even after server cooldown ends", () => {
  const idle = clicker.createClickerRun();
  assert.equal(clicker.planClickerTap(idle, false), "REQUEST_SERVER");
  assert.equal(clicker.planClickerTap(idle, true), "START_LOCAL");
  assert.equal(
    clicker.planClickerTap({ ...idle, tapCount: 42 }, false),
    "ADVANCE_LOCAL",
  );
});

test("opens the next story locally after the hundredth tap", () => {
  const finished = { storyIndex: 0, tapCount: 100, lastTapAtMs: 900 };
  const next = clicker.advanceClickerRun(finished, 1_000);
  const frame = clicker.getClickerFrame(next);

  assert.deepEqual(next, { storyIndex: 1, tapCount: 1, lastTapAtMs: 1_000 });
  assert.equal(frame.storyId, "lab");
  assert.equal(frame.message, "Опыт начался");
  assert.deepEqual(
    clicker.rotateClickerStory({ storyIndex: clicker.CLICKER_STORIES.length - 1, tapCount: 7 }),
    { storyIndex: 0, tapCount: 0, lastTapAtMs: null },
  );
});

test("expires a suspended iPhone clicker run on the next tap boundary", () => {
  const active = { storyIndex: 2, tapCount: 35, lastTapAtMs: 1_000 };
  assert.equal(
    clicker.resetExpiredClickerRun(active, 1_000 + clicker.CLICKER_IDLE_RESET_MS - 1),
    active,
  );
  assert.deepEqual(
    clicker.resetExpiredClickerRun(active, 1_000 + clicker.CLICKER_IDLE_RESET_MS),
    { storyIndex: 3, tapCount: 0, lastTapAtMs: null },
  );
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
