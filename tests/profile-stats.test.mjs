import assert from "node:assert/strict";
import test, { after } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root,
  resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false } });
after(() => vite.close());
const { ProfileView } = await vite.ssrLoadModule("/features/account/profile-view.tsx");
const { createDevIdentity } = await vite.ssrLoadModule("/lib/dev/api-store.ts");
const { getClickerLevel, getClickerLevelProgress } = await vite.ssrLoadModule("/features/game/clicker-story.ts");
const noop = () => {};
function profile(gameLoaded = true) {
  return renderToStaticMarkup(createElement(ProfileView, {
    me: createDevIdentity("Лесник", crypto.randomUUID()).me, simpleView: false, onSimpleViewChange: noop,
    notificationSettingsExit: { current: null }, nowMs: Date.now(), isOnline: false,
    clickerStats: { lifetimeTaps: 12345, bestSeries: 678, level: getClickerLevel(12345), levelProgress: getClickerLevelProgress(12345) },
    onUpdated: noop, onRecovered: noop, onSessionLost: noop, onOpenCalendar: noop, onOpenGame: noop,
    onRefreshGame: noop, gameNotice: "", gameLoaded, gamePendingTaps: 7, legacyGame: { lifetimeTaps: 0, bestSeries: 0 },
  }));
}

test("account level and confirmed tap records are visible before opening game progress", () => {
  const html = profile();
  const overview = html.slice(0, html.indexOf("Игровой прогресс"));
  assert.match(overview, /Все уровни. Сейчас уровень 12/);
  assert.match(overview, /Уровень 12/);
  assert.match(overview, /12.345/);
  assert.match(overview, /×678/);
  assert.match(overview, /всего тапов/);
  assert.match(overview, /сохраняем…/);
  assert.doesNotMatch(overview, /12.352|×685/, "queued taps never inflate confirmed totals or records");
});

test("account profile does not show stale tap totals while game progress is loading", () => {
  const html = profile(false);
  assert.match(html, /Уровень загружается…/);
  assert.doesNotMatch(html, /12.345|×678|Сейчас уровень 12/);
});
