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

test("account level and confirmed tap records are visible before opening game progress", () => {
  const html = profile();
  const overview = html.slice(0, html.indexOf("Игровой прогресс"));
  assert.match(overview, /Все уровни. Сейчас уровень 13/);
  assert.match(overview, /Уровень 13/);
  assert.match(overview, /7.200.*всего XP/);
  assert.match(overview, /12.345/);
  assert.match(overview, /×678/);
  assert.match(overview, /всего тапов/);
  assert.match(overview, /сохраняем…/);
  assert.doesNotMatch(overview, /12.352|×685/, "queued taps never inflate confirmed totals or records");
});

test("account profile does not show stale tap totals while game progress is loading", () => {
  const html = profile(false);
  assert.match(html, /Сейчас уровень 13/);
  assert.doesNotMatch(html, /12.345|×678/);
});

test("account level waits for economy XP independently of loaded tap totals", () => {
  const html = profile(true, false);
  assert.match(html, /Уровень загружается…/);
  assert.match(html, /12.345/);
  assert.doesNotMatch(html, /Сейчас уровень 12|Сейчас уровень 13/);
});
