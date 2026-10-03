import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false } });
const { WorldPantryMenu } = await vite.ssrLoadModule("/features/economy/world-pantry-menu.tsx");
const { economyCatalog } = await vite.ssrLoadModule("/features/economy/model.ts");
const { economyStorage } = await vite.ssrLoadModule("/features/economy/rules.ts");
after(() => vite.close());

const now = Date.parse("2026-10-03T12:00:00Z");
function snapshot(overrides = {}) {
  const state = { ownerPublicId: "ME", revision: 7, serverTime: new Date(now).toISOString(), wallet: { coins: 48291, pearls: 917 }, inventory: { wood: 20, berries: 6, stone: 0 },
    buildings: { home: 1, garden: 1, warehouse: 1 }, jobs: [], completedExplorations: 0,
    migration: { version: 1, coinsGranted: 0, woodGranted: 0, stoneGranted: 0 }, catalog: structuredClone(economyCatalog), ...overrides };
  return { ...state, storage: overrides.storage ?? economyStorage(state) };
}
function controller(overrides = {}) {
  return { snapshot: snapshot(), market: null, marketError: null, busy: false, uncertain: false, error: null, notice: "Выданы тестовые материалы", now, retryAt: 0,
    act() {}, actMarket() {}, refresh() {}, refreshMarket() {}, retry() {}, ...overrides };
}
function render(economy = controller(), props = {}) {
  return renderToStaticMarkup(createElement(WorldPantryMenu, { economy, onUpgrade() {}, onExplore() {}, ...props }));
}
function button(html, label) {
  const entry = [...html.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)].map(match => ({ attributes: match[1], text: match[2].replace(/<[^>]*>/g, "") })).find(value => value.text.includes(label));
  assert.ok(entry, `Missing button: ${label}`);
  return entry;
}
const disabled = entry => /\bdisabled=/.test(entry.attributes);

test("pantry content contains compact stock without a second frame, house tabs or duplicated wallet", () => {
  const html = render();
  assert.match(html, /aria-label="Предметы в кладовой"/);
  assert.match(html, /aria-label="Древесина: 20"/);
  assert.match(html, /aria-label="Лесные ягоды: 6"/);
  assert.doesNotMatch(html, /aria-label="Камень: 0"/);
  assert.match(html, /width="20" height="20"/);
  assert.doesNotMatch(html, /role="dialog"|<h[12]\b|Оборудование:|Запасы дома|Выданы тестовые материалы|48[\s\S]?291|917/);
  assert.match(button(html, "Расширить кладовую").attributes, /aria-haspopup="dialog"/);
});

test("occupancy includes reserved market stock and full storage preserves item selection", () => {
  const html = render(controller({ snapshot: snapshot({ storage: { used: 180, reserved: 20, capacity: 200, available: 0, overflow: 0 } }) }));
  assert.match(html, /aria-label="Кладовая: занято 200 из 200 мест"/);
  assert.match(html, /data-full="true"/);
  assert.match(html, /На рынке 20/);
  assert.match(html, /Товары на рынке тоже занимают место до продажи/);
  assert.equal(disabled(button(html, "Древесина")), false);
});

test("overflow reports actual occupancy while the capacity meter stays bounded", () => {
  const html = render(controller({ snapshot: snapshot({ inventory: { wood: 240 }, storage: { used: 240, reserved: 10, capacity: 200, available: 0, overflow: 50 } }) }));
  assert.match(html, /aria-label="Кладовая: занято 250 из 200 мест"/);
  assert.match(html, /<progress value="200" max="200"/);
  assert.match(html, /Сверх вместимости: 50/);
  assert.match(html, /Запасы сохранены/);
  assert.equal(disabled(button(html, "Древесина")), false);
  assert.equal(disabled(button(html, "Расширить кладовую")), false);
});

test("loading and failed initial requests do not invent inventory or capacity", () => {
  let html = render(controller({ snapshot: null }));
  assert.match(html, /Открываем кладовую/);
  assert.doesNotMatch(html, /Предметы в кладовой|Занято мест|Расширить кладовую|Продать торговцу/);
  html = render(controller({ snapshot: null, error: "Нет связи", retryAt: now + 10_000 }));
  assert.match(html, /role="alert"/);
  assert.match(html, /Нет связи/);
  assert.equal(disabled(button(html, "Повторить через 10 с")), true);
});

test("uncertain result offers receipt recovery without hiding saved inventory", () => {
  let html = render(controller({ uncertain: true }));
  assert.match(html, /Продажа станет доступна после подтверждения/);
  assert.equal(disabled(button(html, "Проверить результат")), false);
  assert.match(html, /aria-label="Древесина: 20"/);
  html = render(controller({ uncertain: true, busy: true }));
  assert.equal(disabled(button(html, "Проверить результат")), true);
});

test("empty inventory invites exploration, but reserved goods remain explained as market stock", () => {
  let html = render(controller({ snapshot: snapshot({ inventory: {} }) }));
  assert.match(html, /Здесь будут урожай, материалы и находки/);
  assert.equal(disabled(button(html, "Отправиться за находками")), false);
  html = render(controller({ snapshot: snapshot({ inventory: {}, storage: { used: 0, reserved: 20, capacity: 200, available: 180, overflow: 0 } }) }));
  assert.match(html, /Все запасы сейчас на рынке/);
  assert.doesNotMatch(html, /Отправиться за находками/);
});

test("player market shortcut requires navigation and the actual catalog unlock conditions", () => {
  const props = { onOpenMarket() {} };
  assert.doesNotMatch(render(controller(), props), /Рынок игроков/);
  const state = snapshot({ buildings: { home: economyCatalog.market.requiredHomeLevel, warehouse: 1 }, completedExplorations: economyCatalog.market.requiredExplorations });
  assert.match(render(controller({ snapshot: state }), props), /Рынок игроков/);
  assert.doesNotMatch(render(controller({ snapshot: state })), /Рынок игроков/);
  state.completedExplorations = economyCatalog.market.requiredExplorations - 1;
  assert.doesNotMatch(render(controller({ snapshot: state }), props), /Рынок игроков/);
});

test("warehouse expansion shows its own server-clock progress and ready status", () => {
  const job = { id: "da818fb4-6c9e-4b42-9b78-60669b234f0a", kind: "construction", targetId: "warehouse", recipeId: null, targetLevel: 2,
    startedAt: new Date(now - 60_000).toISOString(), finishesAt: new Date(now + 45_000).toISOString(), rewards: {}, cost: { coins: 20, items: {} }, catalogVersion: 2 };
  const state = snapshot({ jobs: [job] });
  let html = render(controller({ snapshot: state }));
  assert.match(html, /Кладовая расширяется/);
  assert.match(html, /Ещё 45 с/);
  assert.doesNotMatch(html, /Расширить кладовую/);
  html = render(controller({ snapshot: state, now: now + 45_000 }));
  assert.match(html, /Расширение готово/);
  assert.match(html, /Можно получить уровень 2/);
  assert.equal(disabled(button(html, "Расширение готово")), false);
  job.targetId = "home";
  assert.doesNotMatch(render(controller({ snapshot: state })), /Кладовая расширяется|Расширение готово/);
});

test("maximum warehouse level has no further expansion action", () => {
  const maximum = Math.max(...economyCatalog.buildings.find(entry => entry.id === "warehouse").levels.map(entry => entry.level));
  const html = render(controller({ snapshot: snapshot({ buildings: { home: 5, warehouse: maximum } }) }));
  assert.match(html, /Максимальная вместимость/);
  assert.doesNotMatch(html, /Расширить кладовую/);
});
