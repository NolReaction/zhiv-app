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
const { emptyPlayerProgression } = await vite.ssrLoadModule("/features/economy/domain/player-progression-model.ts");
const noop = () => {};
function profile(gameLoaded = true, progressionLoaded = true) {
  return renderToStaticMarkup(createElement(ProfileView, {
    me: createDevIdentity("Лесник", crypto.randomUUID()).me, simpleView: false, onSimpleViewChange: noop,
    notificationSettingsExit: { current: null }, nowMs: Date.now(), isOnline: false,
    clickerStats: { lifetimeTaps: 12345, bestSeries: 678 },
    progression: progressionLoaded ? { routes: {}, recipes: {}, collections: { finds: [], travelSeconds: 0, quarrySeconds: 0 },
      player: { ...emptyPlayerProgression(), xp: 7200 } } : undefined,
    onUpdated: noop, onRecovered: noop, onSessionLost: noop, onOpenCalendar: noop, onOpenGame: noop,
    onRefreshGame: noop, gameNotice: "", gameLoaded, gamePendingTaps: 7, legacyGame: { lifetimeTaps: 0, bestSeries: 0 },
  }));
}

test("account overview keeps achievements and confirmed records while XP and season appear once in game progress", () => {
  const html = profile();
  const overview = html.slice(0, html.indexOf("Игровой прогресс"));
  assert.match(overview, /aria-label="Достижения"/);
  assert.doesNotMatch(overview, /Все уровни|Уровень 16|всего XP|Сотрудничество с жителями в этом месяце/);
  assert.equal((html.match(/aria-label="Общий игровой опыт"/g) ?? []).length, 1);
  assert.equal((html.match(/aria-label="Сотрудничество с жителями в этом месяце"/g) ?? []).length, 1);
  assert.match(html.slice(html.indexOf("Игровой прогресс")), /Уровень 16/);
  assert.match(overview, /12.345/);
  assert.match(overview, /×678/);
  assert.match(overview, /всего тапов/);
  assert.match(overview, /сохраняем…/);
  assert.doesNotMatch(overview, /12.352|×685/, "queued taps never inflate confirmed totals or records");
});

test("account profile does not show stale tap totals while game progress is loading", () => {
  const html = profile(false);
  assert.match(html, /Игровой прогресс.*Уровень 16/);
  assert.doesNotMatch(html, /12.345|×678/);
});

test("game progress waits for economy XP without an extra loading badge in the overview", () => {
  const html = profile(true, false);
  assert.match(html, /Игровой прогресс.*Синхронизация с аккаунтом/);
  assert.doesNotMatch(html, /Уровень загружается|Общий игровой опыт|Сотрудничество с жителями в этом месяце/);
  assert.match(html, /12.345/);
  assert.doesNotMatch(html, /Сейчас уровень \d+/);
});
