import assert from "node:assert/strict";
import test, { after } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url)), cacheDir = await mkdtemp(join(tmpdir(), "zhiv-refresh-ui-"));
const vite = await createServer({ appType: "custom", configFile: false, root, cacheDir, resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false } });
after(async () => { await vite.close(); await rm(cacheDir, { recursive: true, force: true }); });
const { marketRefreshCountdown } = await vite.ssrLoadModule("/features/economy/ui/shared/market-refresh-time.ts");
const { MarketRefreshProgress } = await vite.ssrLoadModule("/features/economy/ui/shared/market-refresh-progress.tsx");
const { marketRefreshAvailable, watchMarketRefreshAvailability } = await vite.ssrLoadModule("/features/economy/ui/shared/market-refresh-availability.ts");
const { WorldLeaftailMarket } = await vite.ssrLoadModule("/features/economy/ui/market/world-leaftail-market.tsx");
const { economyCatalog, economyFishingSchema } = await vite.ssrLoadModule("/features/economy/domain/model.ts");
const end = Date.parse("2026-10-19T00:00:00Z");

test("a mounted/reopened shelf uses the server window end, with seconds and a genuinely draining bar", () => {
  const refreshAt = new Date(end).toISOString();
  const open = marketRefreshCountdown(refreshAt, 1800, end - 20 * 60_000 - 17_000);
  assert.equal(open.label, "20:17"); assert.equal(open.spoken, "20 мин 17 с");
  assert.equal(open.remainingFraction, 1217 / 1800);
  const reopened = marketRefreshCountdown(refreshAt, 1800, end - 20 * 60_000 - 5_000);
  assert.equal(reopened.label, "20:05"); assert.ok(reopened.remainingFraction < open.remainingFraction);
  const html = renderToStaticMarkup(createElement(MarketRefreshProgress, { refreshAt, refreshSeconds: 1800, now: end - 1217_000 }));
  assert.match(html, /role="timer"[^>]*aria-label="Новая витрина через 20 мин 17 с"/);
  assert.match(html, /<progress[^>]*value="0\.676/);
  assert.doesNotMatch(html, /Смена через 30|aria-live/);
});

test("expiry never loops the bar or pretends stock was fetched, including midnight and a long background pause", () => {
  assert.equal(marketRefreshCountdown(end, 86400, end - 100).label, "00:01");
  for (const now of [end, end + 1, end + 2 * 86400_000]) {
    const value = marketRefreshCountdown(end, 86400, now);
    assert.equal(value.expired, true); assert.equal(value.seconds, 0); assert.equal(value.remainingFraction, 0);
    const html = renderToStaticMarkup(createElement(MarketRefreshProgress, { refreshAt: end, refreshSeconds: 86400, now }));
    assert.match(html, /data-market-refresh="ready"/); assert.match(html, /Пора обновить витрину/); assert.match(html, /value="0"/);
  }
  assert.equal(marketRefreshCountdown(end, 86400, end - 86400_000).label, "24:00:00");
});

test("device wall clock changes cannot affect a supplied server clock, and malformed times never yield NaN", () => {
  const original = Date.now;
  try {
    const accepted = marketRefreshCountdown(end, 1800, end - 91_000);
    Date.now = () => 0; assert.deepEqual(marketRefreshCountdown(end, 1800, end - 91_000), accepted);
    Date.now = () => end + 365 * 86400_000; assert.deepEqual(marketRefreshCountdown(end, 1800, end - 91_000), accepted);
    assert.equal(marketRefreshCountdown(end, 1800, end - 1900_000).remainingFraction, 1);
  } finally { Date.now = original; }
  for (const [refreshAt, seconds, now] of [["broken", 1800, end], [Number.MAX_SAFE_INTEGER * 86400_000, 86400, end], [end, 0, end], [end, Infinity, end], [end, 1800, NaN]]) {
    assert.equal(marketRefreshCountdown(refreshAt, seconds, now), null);
    const html = renderToStaticMarkup(createElement(MarketRefreshProgress, { refreshAt, refreshSeconds: seconds, now }));
    assert.match(html, /data-market-refresh="unknown"/); assert.doesNotMatch(html, /NaN|Infinity/);
  }
});

test("visibility/online refresh watches the mounted panel only and never fetches hidden or offline", () => {
  const descriptors = Object.fromEntries(["document", "window", "navigator"].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const document = new EventTarget(), window = new EventTarget(), navigator = { onLine: true };
  document.hidden = false;
  for (const [key, value] of Object.entries({ document, window, navigator })) Object.defineProperty(globalThis, key, { configurable: true, value });
  let reads = 0;
  try {
    const cleanup = watchMarketRefreshAvailability(async () => { reads++; });
    assert.equal(reads, 0, "the existing parent effect owns its initial request");
    document.hidden = true; document.dispatchEvent(new Event("visibilitychange")); window.dispatchEvent(new Event("online")); assert.equal(reads, 0);
    document.hidden = false; navigator.onLine = false; document.dispatchEvent(new Event("visibilitychange")); assert.equal(reads, 0); assert.equal(marketRefreshAvailable(), false);
    navigator.onLine = true; window.dispatchEvent(new Event("online")); document.dispatchEvent(new Event("visibilitychange")); assert.equal(reads, 2);
    cleanup(); window.dispatchEvent(new Event("online")); document.dispatchEvent(new Event("visibilitychange")); assert.equal(reads, 2);
  } finally { for (const [key, descriptor] of Object.entries(descriptors)) if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key]; }
});

test("an expired Leaftail panel keeps the accepted delivery and waits for a real server snapshot", () => {
  const snapshot = { ownerPublicId: "ME", revision: 1, wallet: { coins: 1_000_000, pearls: 100 }, inventory: {}, buildings: { home: 5 },
    fishing: economyFishingSchema.parse({}), wardrobe: [], catalog: structuredClone(economyCatalog), serverTime: new Date(end - 1000).toISOString(),
    storage: { capacity: 3000, used: 0, reserved: 0, available: 3000, overflow: 0 } };
  const economy = { snapshot, snapshotConfirmed: true, now: end + 1000, retryAt: 0, busy: false, uncertain: false };
  const before = structuredClone(snapshot);
  const html = renderToStaticMarkup(createElement(WorldLeaftailMarket, { economy, introduced: true, isOnline: true }));
  assert.match(html, /data-market-refresh="ready"/);
  assert.match(html, /Проверяем новую поставку/);
  assert.match(html, /19 окт\., 03:00 МСК/);
  assert.doesNotMatch(html, /20 окт\./);
  assert.deepEqual(snapshot, before, "a display must never grant items or advance saved purchases");
});
