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

test("keeps the agreed meme sequence", () => {
  assert.equal(presentation.getBurstMessage(1), "Отметка сохранена · только что");
  assert.equal(presentation.getBurstMessage(2), "Всё ещё жив 😄");
  assert.equal(presentation.getBurstMessage(3), "Очень жив");
  assert.equal(presentation.getBurstMessage(4), "Подозрительно жив");
  assert.equal(presentation.getBurstMessage(5), "Бессмертие подтверждено");
  assert.equal(presentation.getBurstMessage(99), "Бессмертие подтверждено");
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
