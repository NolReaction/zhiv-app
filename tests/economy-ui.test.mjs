import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false } });
const { EconomyPanel, EconomyBalances } = await vite.ssrLoadModule("/features/economy/economy-panel.tsx");
const { economyCatalog } = await vite.ssrLoadModule("/features/economy/model.ts");
after(() => vite.close());

const now = Date.parse("2026-09-30T21:00:00Z");
function snapshot(overrides = {}) {
  return { ownerPublicId: "ME", revision: 1, serverTime: new Date(now).toISOString(),
    wallet: { coins: 0, pearls: 0 }, inventory: {}, buildings: { home: 1, garden: 1 }, jobs: [],
    migration: { version: 1, coinsGranted: 0, woodGranted: 0, stoneGranted: 0 },
    catalog: structuredClone(economyCatalog), completedExplorations: 0, ...overrides };
}
function controller(overrides = {}) {
  return { snapshot: snapshot(), market: null, marketError: null, busy: false, uncertain: false, error: null, notice: "", now, retryAt: 0,
    act() {}, actMarket() {}, refresh() {}, refreshMarket() {}, retry() {}, ...overrides };
}
const render = (tab, economy = controller()) => renderToStaticMarkup(createElement(EconomyPanel, { initialTab: tab, economy }));
const buttons = html => [...html.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)].map(match => ({ attributes: match[1], text: match[2].replace(/<[^>]*>/g, "") }));
const button = (html, text) => {
  const found = buttons(html).find(entry => entry.text.includes(text));
  assert.ok(found, `Missing button: ${text}`); return found;
};
const disabled = entry => /\bdisabled=/.test(entry.attributes);
function job(overrides = {}) {
  return { id: "da818fb4-6c9e-4b42-9b78-60669b234f0a", kind: "production", targetId: "garden", recipeId: "grow_berries", targetLevel: null,
    startedAt: new Date(now - 100_000).toISOString(), finishesAt: new Date(now + 500_000).toISOString(),
    rewards: { berries: 6 }, cost: { coins: 0, items: {} }, catalogVersion: 1, ...overrides };
}

test("fresh players can grow and explore without coins; expensive buildings explain missing materials", () => {
  const production = render("production");
  assert.equal(disabled(button(production, "Начать · 10 мин")), false);
  assert.match(production, /Без затрат/);
  assert.equal(disabled(button(render("exploration"), "Отправиться: Лесная разведка")), false);
  const construction = render("buildings");
  assert.equal(disabled(button(construction, "Улучшить до ур. 2: Дом Мохлика")), true);
  assert.match(construction, /Не хватает монет или материалов/);
  assert.match(construction, /Древесина: 0 \/ 12/);
  assert.match(construction, /Камень: 0 \/ 8/);
  assert.match(construction, /30 мин/);
});

test("construction checks materials together with coins and only opens when the full cost is available", () => {
  const state = snapshot({ wallet: { coins: 100, pearls: 0 }, inventory: { wood: 12, stone: 7 } });
  assert.equal(disabled(button(render("buildings", controller({ snapshot: state })), "Улучшить до ур. 2: Дом Мохлика")), true);
  state.inventory.stone = 8;
  assert.equal(disabled(button(render("buildings", controller({ snapshot: state })), "Улучшить до ур. 2: Дом Мохлика")), false);
});

test("uncollected production owns its station and rewards are claimable only after the server deadline", () => {
  const state = snapshot({ jobs: [job()] });
  let html = render("production", controller({ snapshot: state }));
  assert.equal(disabled(button(html, "Начать · 10 мин")), true);
  assert.equal(disabled(button(html, "Забрать: Вырастить ягоды")), true);
  assert.match(html, /Здание занято текущим заказом/);
  state.jobs[0].finishesAt = new Date(now).toISOString();
  html = render("production", controller({ snapshot: state }));
  assert.equal(disabled(button(html, "Забрать: Вырастить ягоды")), false);
  assert.equal(disabled(button(html, "Начать · 10 мин")), true);
  assert.match(html, /Можно забрать/);
});

test("an active house build keeps the current level and does not offer a second construction", () => {
  const state = snapshot({ wallet: { coins: 999, pearls: 0 }, inventory: { wood: 99, stone: 99 },
    jobs: [job({ kind: "construction", targetId: "home", recipeId: null, targetLevel: 2, rewards: {} })] });
  const html = render("buildings", controller({ snapshot: state }));
  assert.match(html, /Прежний уровень продолжает действовать/);
  assert.equal(disabled(button(html, "Завершить: Дом Мохлика · уровень 2")), true);
  assert.equal(disabled(button(html, "Построить: Лесной участок")), true);
  assert.doesNotMatch(html, /Улучшить до ур\. 3/);
});

test("uncertain commands and retry cooldown prevent duplicate actions while navigation remains usable", () => {
  const state = snapshot({ jobs: [job({ finishesAt: new Date(now - 1).toISOString() })] });
  let html = render("overview", controller({ snapshot: state, uncertain: true, error: "No response" }));
  assert.equal(disabled(button(html, "Забрать: Вырастить ягоды")), true);
  assert.equal(disabled(button(html, "Проверить результат")), false);
  assert.equal(disabled(button(html, "Производство")), false);
  html = render("production", controller({ snapshot: snapshot(), retryAt: now + 15_000, error: "Повторите позже" }));
  assert.equal(disabled(button(html, "Начать · 10 мин")), true);
  assert.equal(disabled(button(html, "Повторить через 15 с")), true);
});

test("loading and failed initial reads never display a spend action or a made-up balance", () => {
  let html = render("buildings", controller({ snapshot: null }));
  assert.match(html, /Открываем ваше хозяйство/);
  assert.doesNotMatch(html, /Построить|aria-label="Кошелёк"/);
  html = render("buildings", controller({ snapshot: null, error: "Нет связи" }));
  assert.match(html, /Нет связи/);
  assert.ok(button(html, "Попробовать ещё раз"));
});

test("market shows real full-lot quotes, escapes seller text and applies catalog access requirements", () => {
  const market = { listings: [{ id: "offer", sellerPublicId: "OTHER", sellerName: "<script>seller</script>", itemId: "wood", quantity: 6, totalPrice: 42,
    status: "active", createdAt: new Date(now).toISOString(), closedAt: null, owned: false }], mine: [], nextCursor: null, serverTime: new Date(now).toISOString() };
  const state = snapshot({ wallet: { coins: 42, pearls: 0 }, buildings: { home: 2, garden: 1 }, completedExplorations: 1 });
  let html = render("market", controller({ snapshot: state, market }));
  assert.match(html, /Древесина × 6/);
  assert.match(html, /за весь лот/);
  assert.match(html, /&lt;script&gt;seller&lt;\/script&gt;/);
  assert.doesNotMatch(html, /<script>/);
  assert.equal(disabled(button(html, "Купить весь лот")), false);
  state.wallet.coins = 41;
  assert.equal(disabled(button(render("market", controller({ snapshot: state, market })), "Не хватает монет")), true);
  state.catalog.market.requiredHomeLevel = 3;
  html = render("market", controller({ snapshot: state, market }));
  assert.equal(disabled(button(html, "Рынок пока закрыт")), true);
  assert.match(html, /Дом: 2 \/ 3 ур/);
});

test("an empty player market is honest and offers a next action without fictional merchants", () => {
  const html = render("market", controller({ snapshot: snapshot({ buildings: { home: 2, garden: 1 }, completedExplorations: 1 }),
    market: { listings: [], mine: [], nextCursor: null, serverTime: new Date(now).toISOString() } }));
  assert.match(html, /Прилавки пока свободны/);
  assert.ok(button(html, "Выставить товар"));
  assert.doesNotMatch(html, /Продавец:/);
});

test("conversion is disclosed once as history and premium balance never exposes a checkout", () => {
  const html = render("overview", controller({ snapshot: snapshot({ migration: { version: 1, coinsGranted: 126, woodGranted: 10, stoneGranted: 4 } }) }));
  assert.match(html, /Прежние запасы перенесены/);
  assert.match(html, /126 монет, 10 древесины и 4 камня/);
  assert.match(html, /покупка пока недоступна/i);
  assert.ok(buttons(html).every(entry => !/Купить жемчуг|Пополнить/.test(entry.text)));
  const wallet = renderToStaticMarkup(createElement(EconomyBalances, { wallet: { coins: 25, pearls: 0 } }));
  assert.match(wallet, /Монеты: 25/);
  assert.doesNotMatch(wallet, /Искры/);
});
