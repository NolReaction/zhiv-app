import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { createElement } from "react";
import { Dialog } from "radix-ui";
import { renderToStaticMarkup } from "react-dom/server";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false } });
const { WorldUpgradeContent } = await vite.ssrLoadModule("/features/economy/world-upgrade-dialog.tsx");
const { economyCatalog } = await vite.ssrLoadModule("/features/economy/model.ts");
const { economyStorage } = await vite.ssrLoadModule("/features/economy/rules.ts");
after(() => vite.close());

const now = Date.parse("2026-10-03T12:00:00Z");
function state(overrides = {}) {
  const snapshot = { ownerPublicId: "ME", revision: 1, serverTime: new Date(now).toISOString(), wallet: { coins: 500, pearls: 0 }, inventory: { wood: 20 },
    buildings: { home: 1, warehouse: 1 }, jobs: [], completedExplorations: 0,
    migration: { version: 1, coinsGranted: 0, woodGranted: 0, stoneGranted: 0 }, catalog: structuredClone(economyCatalog), ...overrides };
  return { ...snapshot, storage: economyStorage(snapshot) };
}
function construction(overrides = {}) {
  return { id: "da818fb4-6c9e-4b42-9b78-60669b234f0a", kind: "construction", targetId: "home", recipeId: null, targetLevel: 2,
    startedAt: new Date(now - 100_000).toISOString(), finishesAt: new Date(now + 500_000).toISOString(), rewards: {},
    cost: { coins: 150, items: { wood: 20, stone: 15, planks: 6, rope: 2 } }, catalogVersion: 2, ...overrides };
}
function render(stationId = "home", overrides = {}) {
  const economy = { snapshot: state(), market: null, marketError: null, busy: false, uncertain: false, error: null, notice: "", now, retryAt: 0,
    act() {}, actMarket() {}, refresh() {}, refreshMarket() {}, retry() {}, ...overrides };
  return renderToStaticMarkup(createElement(Dialog.Root, { open: true }, createElement(WorldUpgradeContent, {
    stationId, economy, onClose() {}, onOpenPantry() {}, navigation: { canOpen: () => true, open() {}, explore() {} },
  })));
}
const text = html => html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ");
const buttons = html => [...html.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)].map(match => ({ attributes: match[1], text: text(match[2]) }));

test("compact upgrade shows current level, cost and unlocks without a pantry shortcut or stale global notice", () => {
  const html = render("home", { notice: "DEV: Дом Мохлика → 2" });
  assert.match(text(html), /Дом Мохлика.*Уровень 1.*Уровень 2/);
  assert.ok(html.indexOf('aria-label="Подготовка к улучшению"') < html.indexOf('aria-label="Что изменится"'));
  assert.match(html, /aria-label="Где получить: Камень, В путь"/);
  assert.match(html, /aria-label="Недостающие условия"/);
  assert.match(text(html), /Монеты 500 \/ 150/);
  assert.ok(!buttons(html).some(button => button.text.trim() === "Кладовая"));
  assert.doesNotMatch(html, /DEV: Дом Мохлика/);
});

test("paid construction stays above the unlocks with one timer and one claim; it cannot charge again", () => {
  const html = render("home", { snapshot: state({ jobs: [construction()] }) });
  assert.ok(html.indexOf('aria-label="Ход улучшения"') < html.indexOf('aria-label="Что изменится"'));
  assert.equal((html.match(/<progress /g) ?? []).length, 1);
  const claims = buttons(html).filter(button => /aria-label="Завершить:/.test(button.attributes));
  assert.equal(claims.length, 1);
  assert.match(claims[0].attributes, /disabled/);
  assert.match(text(html), /Осталось/);
  assert.doesNotMatch(html, /Подготовка к улучшению|Улучшить до ур\./);
});

test("a ready construction has one enabled completion action and reuses normal request locks", () => {
  const snapshot = state({ jobs: [construction({ finishesAt: new Date(now).toISOString() })] });
  const claim = overrides => buttons(render("home", { snapshot, ...overrides })).filter(button => /aria-label="Завершить:/.test(button.attributes));
  assert.equal(claim({}).length, 1);
  assert.doesNotMatch(claim({})[0].attributes, /disabled/);
  for (const lock of [{ busy: true }, { uncertain: true }, { retryAt: now + 30_000 }]) assert.match(claim(lock)[0].attributes, /disabled/);
});

test("a paid production order remains claimable before upgrading its station", () => {
  const job = construction({ kind: "production", targetId: "garden", recipeId: "grow_berries", targetLevel: null, rewards: { berries: 6 }, finishesAt: new Date(now).toISOString() });
  const html = render("garden", { snapshot: state({ buildings: { home: 2, warehouse: 1, garden: 1 }, jobs: [job] }) });
  assert.match(html, /Сначала заберите заказ/);
  const collect = buttons(html).find(button => /aria-label="Забрать:/.test(button.attributes));
  assert.ok(collect);
  assert.doesNotMatch(collect.attributes, /disabled/);
  assert.match(buttons(html).find(button => /Улучшить до ур\./.test(button.text)).attributes, /disabled/);
});

test("a maximum-level pantry reports real capacity and does not offer another upgrade", () => {
  const html = render("warehouse", { snapshot: state({ buildings: { home: 5, warehouse: 5 } }) });
  assert.match(text(html), /Максимум.*Все улучшения получены/);
  assert.match(text(html), /Вместимость кладовой/);
  assert.ok(!buttons(html).some(button => /Улучшить|Начать обустройство/.test(button.text)));
});
