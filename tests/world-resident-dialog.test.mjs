import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false } });
const { PleskConversation } = await vite.ssrLoadModule("/features/world/world-resident-dialog.tsx");
const { economyCatalog } = await vite.ssrLoadModule("/features/economy/model.ts");
const { economyStorage } = await vite.ssrLoadModule("/features/economy/rules.ts");
after(() => vite.close());

const now = Date.parse("2026-10-04T12:00:00Z");
function snapshot(overrides = {}) {
  const state = { ownerPublicId: "ME", revision: 2, serverTime: new Date(now).toISOString(), wallet: { coins: 0, pearls: 0 }, inventory: { fish: 5 }, buildings: { home: 1, warehouse: 1 }, jobs: [], completedExplorations: 0,
    migration: { version: 1, coinsGranted: 0, woodGranted: 0, stoneGranted: 0 }, catalog: structuredClone(economyCatalog), ...overrides };
  return { ...state, storage: economyStorage(state) };
}
function controller(overrides = {}) {
  return { snapshot: snapshot(), market: null, marketError: null, busy: false, uncertain: false, error: null, notice: "", now, retryAt: 0, act() {}, actMarket() {}, refresh() {}, refreshMarket() {}, retry() {}, ...overrides };
}
function render(economy = controller()) {
  return renderToStaticMarkup(createElement(PleskConversation, { economy, onFishing() {}, onOpenPantry() {} }));
}
function button(html, label) {
  const found = [...html.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)].map(match => ({ attributes: match[1], text: match[2].replace(/<[^>]*>/g, "") })).find(entry => entry.text.includes(label));
  assert.ok(found, `Missing button: ${label}`);
  return found;
}
const disabled = value => /\bdisabled=/.test(value.attributes);

test("Pleska opens a dedicated fish shop using the player's stock and current prices", () => {
  const state = snapshot();
  state.catalog.items.find(item => item.id === "fish").baseSellPrice = 17;
  const html = render(controller({ snapshot: state }));
  assert.match(html, /Торговля: Речная рыба/);
  assert.match(html, /В запасе <strong>5<\/strong>/);
  assert.match(html, /Плёска платит[\s\S]+17/);
  assert.equal(disabled(button(html, "Продать")), false);
  assert.match(html, /min="1" max="5"/);
  assert.match(html, /role="tablist" aria-label="Лавка Плёски"/);
  assert.match(html, /Коллекция/);
  assert.doesNotMatch(html, /Свернуть продажу|Забрать улов|Бесплатно/);
});

test("missing or empty inventory cannot sell the resident's ambient catch", () => {
  let html = render(controller({ snapshot: null }));
  assert.match(html, /Проверяем ваши запасы/);
  assert.doesNotMatch(html, /Торговля:|В запасе/);
  html = render(controller({ snapshot: snapshot({ inventory: { wood: 5 } }) }));
  assert.match(html, /В запасе <strong>0<\/strong>/);
  assert.equal(disabled(button(html, "Продать")), true);
  assert.equal(disabled(button(html, "На рыбалку")), false);
  assert.equal(disabled(button(html, "Другие запасы")), false);
});

test("trading respects in-flight, uncertain and cooldown locks with receipt recovery", () => {
  for (const change of [{ busy: true }, { uncertain: true }, { retryAt: now + 5_000 }]) {
    const html = render(controller(change));
    assert.equal(disabled(button(html, "Продать")), true);
  }
  const html = render(controller({ uncertain: true, retryAt: now + 5_000 }));
  assert.match(html, /role="alert"/);
  assert.match(html, /Дождитесь подтверждения/);
  assert.equal(disabled(button(html, "Повторить через 5 с")), true);
});

test("a failed inventory fetch offers retry without inventing a sale", () => {
  const html = render(controller({ snapshot: null, error: "Нет связи" }));
  assert.match(html, /Нет связи/);
  assert.equal(disabled(button(html, "Попробовать ещё раз")), false);
  assert.doesNotMatch(html, /Торговля:/);
});

test("a pre-fishing backend retains the previous sale without offering unsupported commands", () => {
  const state = snapshot(); delete state.catalog.fishing;
  const html = render(controller({ snapshot: state }));
  assert.match(html, /Продажа: Речная рыба/);
  assert.equal(disabled(button(html, "Продать торговцу")), false);
  assert.doesNotMatch(html, /role="tablist"|Купить удочку|Купить наживку/);
});
