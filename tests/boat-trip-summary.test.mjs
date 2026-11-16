import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ root, configFile: false, appType: "custom", resolve: { alias: { "@": root } },
  server: { middlewareMode: true, hmr: false, ws: false } });
after(() => vite.close());
const { economyCatalog } = await vite.ssrLoadModule("/features/economy/domain/model.ts");
const { newEconomyState, economyStorage } = await vite.ssrLoadModule("/features/economy/domain/rules.ts");
const { createBoatTripReceipt } = await vite.ssrLoadModule("/features/economy/ui/boat/boat-trip-summary-data.ts");
const { BoatDeliveryNotice, BoatTripSummary } = await vite.ssrLoadModule("/features/economy/ui/boat/boat-trip-summary.tsx");
const { BoatVoyagePanel } = await vite.ssrLoadModule("/features/economy/ui/boat/boat-voyage-panel.tsx");
const instant = "2026-11-03T12:00:00.000Z";
const caught = (castIndex, fishId, weightGrams) => ({ castIndex, fishId, weightGrams, caughtAt: instant });
function fixture(catches = []) {
  const value = newEconomyState({ resources: { sparks: 0, wood: 0, stone: 0 }, houseLevel: 4, workshopLevel: 3 });
  const state = { ...value, catalog: economyCatalog, storage: economyStorage(value) };
  state.boat.level = 1;
  state.boat.voyage = { id: crypto.randomUUID(), routeId: "river_reach", departedAt: instant, arrivesAt: instant,
    fishingUntil: "2026-11-03T12:30:00.000Z", returnStartedAt: "2026-11-03T12:10:00.000Z", returnsAt: "2026-11-03T12:15:00.000Z",
    maxCasts: 4, maxCatches: 4, castsUsed: 3, catches,
    loadout: { rodId: "reed_rod", hookId: "bare_hook", baitId: null }, outboundSeconds: 300, inboundSeconds: 300 };
  Object.defineProperty(state.boat.voyage, "slots", { get() { assert.fail("The summary cannot inspect future private draws"); } });
  return state;
}

test("the receipt totals only confirmed catches and counts each new or record species once", () => {
  const state = fixture([caught(0, "fish_silverfin", 300), caught(1, "fish_silverfin", 450), caught(2, "fish_pike", 2000)]);
  state.fishing.catches.fish_silverfin = 5;
  state.boat.records.fish_silverfin = { weightGrams: 200, caughtAt: instant };
  state.inventory = { fish_common: 999 }; state.fishing.stock = { fish_common: 999 };
  const receipt = createBoatTripReceipt(state, state.boat.voyage);
  assert.equal(receipt.count, 3); assert.equal(receipt.totalWeightGrams, 2750);
  assert.equal(receipt.largest.fishId, "fish_pike"); assert.equal(receipt.largest.weightGrams, 2000);
  assert.equal(receipt.newSpeciesCount, 1); assert.equal(receipt.recordSpeciesCount, 1);
  assert.deepEqual(receipt.catches.map(row => row.previousBestGrams), [200, 300, 0]);
  assert.equal(receipt.castsUsed, 3);
  assert.ok(Object.isFrozen(receipt) && Object.isFrozen(receipt.catches) && receipt.catches.every(Object.isFrozen));
  assert.doesNotMatch(JSON.stringify(receipt), /slots|challengeSeed|inventory|sparks/);
});

test("a pre-claim receipt remains unchanged after acknowledged delivery changes history and removes the voyage", () => {
  const state = fixture([caught(0, "fish_silverfin", 300)]);
  const receipt = createBoatTripReceipt(state, state.boat.voyage), before = JSON.stringify(receipt);
  state.boat.voyage.catches[0].weightGrams = 999;
  state.boat.records.fish_silverfin = { weightGrams: 999, caughtAt: instant };
  state.fishing.catches.fish_silverfin = 10; delete state.boat.voyage;
  assert.equal(JSON.stringify(receipt), before);
  const delivered = renderToStaticMarkup(createElement(BoatDeliveryNotice, { receipt }));
  assert.match(delivered, /Улов доставлен/); assert.match(delivered, /role="status"/);
  assert.match(delivered, /300 г/); assert.doesNotMatch(delivered, /999 г|Разгрузка добавит/);
});

test("the dock offers the full catch at its weight-adjusted price even with a full pantry", () => {
  const state = fixture([caught(0, "fish_silverfin", 300), caught(1, "fish_silverfin", 450)]), now = Date.parse(state.boat.voyage.returnsAt);
  const economy = { snapshot: state, now, busy: false, uncertain: false };
  const report = () => renderToStaticMarkup(createElement(BoatVoyagePanel, { economy, disabled: false,
    send() { assert.fail("Rendering cannot issue a claim"); }, onOpenPantry() {} }));
  state.storage.available = 0;
  const before = JSON.stringify(state);
  const full = report();
  assert.match(full, /data-boat-trip-ready/); assert.match(full, /Улов прибыл домой/);
  assert.match(full, /Самая крупная/); assert.match(full, /Весь улов выхода/);
  assert.match(full, /data-trip-catch="0"[^]*300 г/); assert.match(full, /data-trip-catch="1"[^]*450 г/);
  assert.match(full, /Освободите мест в кладовой: 2/); assert.match(full, /В кладовую/);
  assert.doesNotMatch(full, /Принять улов|<details/); assert.equal(JSON.stringify(state), before);
  state.storage.available = 2;
  const ready = report();
  assert.match(ready, /Принять улов/); assert.doesNotMatch(ready, /В кладовую|<details/);
  for (const html of [ready, full]) {
    assert.match(html, /Выкуп у причала: 30 за весь улов \+ 1 за вес/);
    assert.match(html, /После разгрузки в холодильнике рыба продаётся поштучно по цене своей редкости/);
    assert.match(html, /Продать весь улов · 31\b/);
    assert.equal((html.match(/<button/g) || []).length, 2);
  }
  const oldCatalog = { ...state.catalog, boat: { ...state.catalog.boat, dockSaleBonusPercent: undefined } };
  state.catalog = oldCatalog;
  assert.doesNotMatch(report(), /Продать весь улов/);
});

test("an empty outing has no invented largest fish, achievement or reward and retains explicit completion", () => {
  const state = fixture(), receipt = createBoatTripReceipt(state, state.boat.voyage);
  assert.equal(receipt.count, 0); assert.equal(receipt.totalWeightGrams, 0); assert.equal(receipt.largest, null);
  assert.equal(receipt.newSpeciesCount, 0); assert.equal(receipt.recordSpeciesCount, 0);
  const html = renderToStaticMarkup(createElement(BoatTripSummary, { receipt }));
  assert.match(html, /Снова у причала/); assert.match(html, /На этот раз без улова/);
  assert.doesNotMatch(html, /data-largest-fish|data-trip-new-species|data-trip-records|Весь улов выхода|жемчуг|монет/);
  const panel = renderToStaticMarkup(createElement(BoatVoyagePanel, { economy: { snapshot: state, now: Date.parse(state.boat.voyage.returnsAt) }, disabled: false, send() { assert.fail("Render is read-only"); } }));
  assert.match(panel, /Завершить выход/); assert.doesNotMatch(panel, /Забрать улов/);
});
