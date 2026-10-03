import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false } });
const { WorldExpeditionsMenu } = await vite.ssrLoadModule("/features/economy/world-expeditions-menu.tsx");
const { economyCatalog } = await vite.ssrLoadModule("/features/economy/model.ts");
const { economyStorage } = await vite.ssrLoadModule("/features/economy/rules.ts");
after(() => vite.close());

const now = Date.parse("2026-10-03T12:00:00Z");
function snapshot(overrides = {}) {
  const state = { ownerPublicId: "ME", revision: 2, serverTime: new Date(now).toISOString(), wallet: { coins: 0, pearls: 0 }, inventory: {}, buildings: { home: 1, warehouse: 1 }, jobs: [], completedExplorations: 0,
    migration: { version: 1, coinsGranted: 0, woodGranted: 0, stoneGranted: 0 }, catalog: structuredClone(economyCatalog), ...overrides };
  return { ...state, storage: overrides.storage ?? economyStorage(state) };
}
function controller(overrides = {}) {
  return { snapshot: snapshot(), market: null, marketError: null, busy: false, uncertain: false, error: null, notice: "", now, retryAt: 0, act() {}, actMarket() {}, refresh() {}, refreshMarket() {}, retry() {}, ...overrides };
}
function job(overrides = {}) {
  return { id: "da818fb4-6c9e-4b42-9b78-60669b234f0a", kind: "exploration", targetId: "forest", recipeId: null, targetLevel: null, startedAt: new Date(now - 1_000).toISOString(), finishesAt: new Date(now + 29_000).toISOString(), rewards: { wood: 5, stone: 3, fiber: 4 }, cost: { coins: 0, items: {} }, catalogVersion: 2, ...overrides };
}
function render(economy = controller(), props = {}) {
  return renderToStaticMarkup(createElement(WorldExpeditionsMenu, { economy, onOpenPantry() {}, ...props }));
}
function route(html, id) {
  const found = html.match(new RegExp(`<details\\b[^>]*data-route="${id}"[^>]*>[\\s\\S]*?<\\/details>`));
  assert.ok(found, `Missing route: ${id}`);
  return found[0];
}
function button(html, label) {
  const found = [...html.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)].map(match => ({ attributes: match[1], text: match[2].replace(/<[^>]*>/g, "") })).find(entry => entry.attributes.includes(`aria-label="${label}"`) || entry.text.includes(label));
  assert.ok(found, `Missing button: ${label}`);
  return found;
}
const disabled = value => /\bdisabled=/.test(value.attributes);

test("expeditions keep every catalog route in collapsed rows, without another economy dashboard", () => {
  const html = render();
  for (const entry of economyCatalog.explorations) {
    const content = route(html, entry.id);
    assert.match(content, /<summary>/);
    assert.doesNotMatch(content, /<details[^>]*\bopen=/);
    for (const [itemId, count] of Object.entries(entry.rewards)) {
      assert.ok(content.includes(economyCatalog.items.find(item => item.id === itemId).name));
      assert.ok(content.includes(`×${count}`));
    }
  }
  assert.equal([...html.matchAll(/<details\b/g)].length, economyCatalog.explorations.length);
  assert.doesNotMatch(html, /role="dialog"|role="tablist"|Кошелёк|<h[123][^>]*>Обзор|Продать|Производство/);
  assert.equal(disabled(button(route(html, "forest"), "Отправиться")), false);
});

test("locked routes explain all missing buildings and offer navigation only when supplied", () => {
  const html = route(render(controller(), { onNavigateStation() {} }), "old_woodland");
  assert.match(html, /Условия открытия/);
  assert.match(html, /нужен ур\. 3/);
  assert.match(html, /нужен ур\. 2/);
  assert.equal(disabled(button(html, "Отправиться")), true);
  assert.equal(disabled(button(html, "нужен ур. 3")), false);
  const withoutNavigation = route(render(), "old_woodland");
  assert.match(withoutNavigation, /<span>[^<]+ · нужен ур\. 3<\/span>/);
});

test("deep routes use actual consumable amounts, and missing provisions block departure", () => {
  const state = snapshot({ buildings: { home: 3, warehouse: 1 }, inventory: { dried_berries: 1 } });
  let html = route(render(controller({ snapshot: state })), "deep_cave");
  assert.match(html, /Припасы для вылазки/);
  assert.match(html, /Не хватает припасов/);
  assert.equal(disabled(button(html, "Отправиться")), true);
  html = route(render(controller({ snapshot: snapshot({ ...state, inventory: { dried_berries: 1, smoked_fish: 1 } }) })), "deep_cave");
  assert.equal(disabled(button(html, "Отправиться")), false);
});

test("departure compares reward size with total capacity; a full pantry can be cleared before return", () => {
  let state = snapshot({ storage: { capacity: 10, available: 10, used: 0, reserved: 0, overflow: 0 } });
  let html = route(render(controller({ snapshot: state })), "forest");
  assert.equal(disabled(button(html, "Отправиться")), true);
  assert.match(html, /Находки займут 12 мест, вместимость — 10/);
  assert.equal(disabled(button(html, "Расширить кладовую")), false);
  state = snapshot({ storage: { capacity: 200, available: 0, used: 170, reserved: 30, overflow: 0 } });
  html = route(render(controller({ snapshot: state })), "forest");
  assert.equal(disabled(button(html, "Отправиться")), false);
  assert.match(html, /свободно 0/);
});

test("ongoing exploration shows real progress and seconds, and exposes no second departure", () => {
  const html = render(controller({ snapshot: snapshot({ jobs: [job()] }) }));
  assert.match(html, /Текущая вылазка: Лесная разведка/);
  assert.match(html, /Ещё 29 с/);
  assert.match(html, /<progress[^>]*value="0\.033/);
  assert.equal(disabled(button(html, "Забрать находки: Лесная разведка")), true);
  assert.doesNotMatch(html, /aria-label="Отправиться:/);
  assert.ok(html.indexOf("Текущая вылазка") < html.indexOf("Маршруты вылазок"));
});

test("ready finds honor available space including market reservations and retain an accessible pantry action", () => {
  const ready = job({ finishesAt: new Date(now).toISOString() });
  let html = render(controller({ snapshot: snapshot({ jobs: [ready], storage: { capacity: 200, used: 180, reserved: 15, available: 5, overflow: 0 } }) }));
  assert.match(html, /Мохлик вернулся/);
  assert.match(html, /Нужно освободить 7 мест/);
  assert.equal(disabled(button(html, "Забрать находки: Лесная разведка")), true);
  assert.equal(disabled(button(html, "Открыть кладовую")), false);
  html = render(controller({ snapshot: snapshot({ jobs: [ready] }) }));
  assert.equal(disabled(button(html, "Забрать находки: Лесная разведка")), false);
});

test("construction and production do not hide exploration or occupy the explorer", () => {
  const html = render(controller({ snapshot: snapshot({ jobs: [job({ kind: "construction", targetId: "home", rewards: {}, targetLevel: 2 }), job({ kind: "production", targetId: "garden", recipeId: "grow_berries", rewards: { berries: 6 } })] }) }));
  assert.doesNotMatch(html, /Текущая вылазка|Мохлик занят|Мохлик в пути/);
  assert.equal(disabled(button(route(html, "forest"), "Отправиться")), false);
});

test("busy, uncertain and cooldown states prevent both spending and reward claims", () => {
  for (const flags of [{ busy: true }, { uncertain: true }, { retryAt: now + 5_000 }]) {
    assert.equal(disabled(button(route(render(controller(flags)), "forest"), "Отправиться")), true);
    const html = render(controller({ ...flags, snapshot: snapshot({ jobs: [job({ finishesAt: new Date(now).toISOString() })] }) }));
    assert.equal(disabled(button(html, "Забрать находки: Лесная разведка")), true);
  }
  assert.match(render(controller({ uncertain: true })), /Проверить результат/);
  assert.equal(disabled(button(render(controller({ retryAt: now + 5_000 })), "Повторить через 5 с")), true);
});

test("initial loading and failure have no fabricated routes; unrelated DEV notices stay out", () => {
  let html = render(controller({ snapshot: null }));
  assert.match(html, /Открываем маршруты/);
  assert.doesNotMatch(html, /data-route|Отправиться/);
  html = render(controller({ snapshot: null, error: "Связь потеряна" }));
  assert.match(html, /Связь потеряна/);
  assert.equal(disabled(button(html, "Попробовать ещё раз")), false);
  html = render(controller({ notice: "Выдано 10000 монет в DEV" }));
  assert.doesNotMatch(html, /Выдано 10000/);
});
