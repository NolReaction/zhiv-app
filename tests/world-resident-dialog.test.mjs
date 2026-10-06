import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false } });
const { PleskConversation } = await vite.ssrLoadModule("/features/world/world-resident-dialog.tsx");
const { FishCounter } = await vite.ssrLoadModule("/features/economy/plesk-fishing-shop.tsx");
const { economyCatalog, economyFishingSchema } = await vite.ssrLoadModule("/features/economy/model.ts");
const { economyStorage } = await vite.ssrLoadModule("/features/economy/rules.ts");
after(() => vite.close());

const now = Date.parse("2026-10-04T12:00:00Z");
function snapshot(overrides = {}) {
  const state = { ownerPublicId: "ME", revision: 2, serverTime: new Date(now).toISOString(), wallet: { coins: 0, pearls: 0 }, inventory: { fish: 5 }, fishing: economyFishingSchema.parse(undefined), fishingShop: { id: "shop-one", openedAt: new Date(now).toISOString(), refreshAt: new Date(now + 6 * 3600000).toISOString(), refreshPricePearls: 100, offers: [{ id: "shop-one:river_rod", kind: "rod", itemId: "river_rod", unitPrice: 18000, remaining: 1 }] }, buildings: { home: 1, warehouse: 1 }, jobs: [], completedExplorations: 0,
    migration: { version: 1, coinsGranted: 0, woodGranted: 0, stoneGranted: 0 }, catalog: structuredClone(economyCatalog), ...overrides };
  return { ...state, storage: economyStorage(state) };
}
function controller(overrides = {}) {
  return { snapshot: snapshot(), market: null, marketError: null, busy: false, uncertain: false, error: null, notice: "", now, retryAt: 0, act() {}, actMarket() {}, refresh() {}, refreshMarket() {}, retry() {}, ...overrides };
}
function render(economy = controller()) {
  return renderToStaticMarkup(createElement(PleskConversation, { economy, onFishing() {}, onOpenPantry() {} }));
}
function renderCatch(economy) {
  return renderToStaticMarkup(createElement(FishCounter, { economy, state: economy.snapshot, catalog: economy.snapshot.catalog.fishing }));
}
function button(html, label) {
  const found = [...html.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)].map(match => ({ attributes: match[1], text: match[2].replace(/<[^>]*>/g, "") })).find(entry => entry.text.includes(label));
  assert.ok(found, `Missing button: ${label}`);
  return found;
}
const disabled = value => /\bdisabled=/.test(value.attributes);

test("Pleska opens current merchant offers, while the catch tab sells the player's actual stock", () => {
  const state = snapshot({ wallet: { coins: 20000, pearls: 100 } });
  state.catalog.items.find(item => item.id === "fish").baseSellPrice = 17;
  const economy = controller({ snapshot: state }), html = render(economy);
  assert.match(html, /Предложения Плёски/);
  assert.match(html, /Новые товары через[\s\S]*6:00:00/);
  assert.match(html, /role="tab"[^>]*aria-selected="true"[^>]*>[\s\S]*?Лавка<\/button>/);
  assert.equal(disabled(button(html, "Купить удочку")), false);
  assert.match(html, /role="tablist" aria-label="Лавка Плёски"/);
  assert.match(html, /Книга/);
  assert.doesNotMatch(html, /Продажа: Речная рыба|Свернуть продажу|Забрать улов|Бесплатно/);
  const catchTab = renderCatch(economy);
  assert.match(catchTab, /Продажа: Речная рыба/);
  assert.match(catchTab, /В запасе <strong>5<\/strong>/);
  assert.match(catchTab, /За штуку[\s\S]+17/);
  assert.equal(disabled(button(catchTab, "Продать")), false);
  assert.match(catchTab, /min="1" max="5"/);
  assert.doesNotMatch(catchTab, /Купить/);
});

test("missing or empty inventory cannot sell the resident's ambient catch", () => {
  let html = render(controller({ snapshot: null }));
  assert.match(html, /Проверяем ваши запасы/);
  assert.doesNotMatch(html, /Продажа:|В запасе/);
  const economy = controller({ snapshot: snapshot({ inventory: { wood: 5, fish: 0 } }) });
  html = renderCatch(economy);
  assert.match(html, /Улов ещё впереди/);
  assert.doesNotMatch(html, /Продать|В запасе|Речная рыба|data-item-icon="fish"/);
  const conversation = render(economy);
  assert.equal(disabled(button(conversation, "На рыбалку")), false);
  assert.equal(disabled(button(conversation, "Другие запасы")), false);
});

test("trading respects in-flight, uncertain and cooldown locks with receipt recovery", () => {
  for (const change of [{ busy: true }, { uncertain: true }, { retryAt: now + 5_000 }]) {
    const economy = controller({ snapshot: snapshot({ wallet: { coins: 20000, pearls: 100 } }), ...change });
    assert.equal(disabled(button(render(economy), "Купить удочку")), true);
    assert.equal(disabled(button(renderCatch(economy), "Продать")), true);
  }
  const html = render(controller({ uncertain: true, retryAt: now + 5_000 }));
  assert.match(html, /role="alert"/);
  assert.match(html, /Дождитесь подтверждения/);
  assert.equal(disabled(button(html, "Повторить через 5 с")), true);
});

test("purchased stock is visible in the sell tab without becoming a personal catch", () => {
  const state = snapshot({ inventory: { fish_shark: 1 } }), economy = controller({ snapshot: state });
  const purchased = renderCatch(economy);
  assert.match(purchased, /data-item-icon="fish_shark"/);
  assert.doesNotMatch(purchased, /data-hidden-fish/);
  assert.equal(disabled(button(purchased, "Продать")), false);
  assert.deepEqual(state.fishing.catches, {});
  state.fishing.catches.fish_shark = 1;
  const caught = renderCatch(economy);
  assert.match(caught, /data-item-icon="fish_shark"/);
  assert.doesNotMatch(caught, /data-hidden-fish/);
});

test("a failed inventory fetch offers retry without inventing a sale", () => {
  const html = render(controller({ snapshot: null, error: "Нет связи" }));
  assert.match(html, /Нет связи/);
  assert.equal(disabled(button(html, "Попробовать ещё раз")), false);
  assert.doesNotMatch(html, /Продажа:|Купить удочку/);
});

test("a pre-fishing backend retains the previous sale without offering unsupported commands", () => {
  const state = snapshot(); delete state.catalog.fishing;
  const html = render(controller({ snapshot: state }));
  assert.match(html, /Продажа: Речная рыба/);
  assert.equal(disabled(button(html, "Продать торговцу")), false);
  assert.doesNotMatch(html, /role="tablist"|Купить удочку|Купить наживку/);
});
