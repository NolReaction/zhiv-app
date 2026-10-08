import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { Children, createElement, isValidElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false } });
const { WorldPantryMenu, PantrySale } = await vite.ssrLoadModule("/features/economy/ui/inventory/world-pantry-menu.tsx");
const { economyCatalog } = await vite.ssrLoadModule("/features/economy/domain/model.ts");
const { economyStorage } = await vite.ssrLoadModule("/features/economy/domain/rules.ts");
after(() => vite.close());

const now = Date.parse("2026-10-03T12:00:00Z");
function snapshot(overrides = {}) {
  const state = { ownerPublicId: "ME", revision: 7, serverTime: new Date(now).toISOString(), wallet: { coins: 482910, pearls: 9170 }, inventory: { wood: 20, berries: 6, stone: 0 },
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
  assert.doesNotMatch(html, /role="dialog"|<h[12]\b|Оборудование:|Запасы дома|Выданы тестовые материалы|482[\s\S]?910|9[\s\S]?170/);
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

test("refrigerator separates all fish from materials while sharing the exact warehouse capacity", () => {
  const inventory = { wood: 20, fish: 84, fish_silverfin: 1, fish_shark: 2, ancient_core: 1, smoked_fish: 3, worm_bait: 2 };
  const state = snapshot({ inventory });
  const before = structuredClone(state), economy = controller({ snapshot: state });
  const supplies = render(economy);
  assert.match(supplies, /aria-label="Древесина: 20"/);
  assert.match(supplies, /aria-label="Копчёная рыба: 3"/);
  assert.match(supplies, /aria-label="Лесной червячок: 2"/);
  assert.doesNotMatch(supplies, /aria-label="(?:Речная рыба|Серебринка|Теневая акула):/);
  const fridge = render(economy, { initialTab: "fridge" });
  assert.match(fridge, /aria-label="Рыба и еда в холодильнике"/);
  assert.match(fridge, /<small>87<\/small><span>Холодильник<\/span>/);
  for (const [name, quantity, id] of [["Речная рыба", 84, "fish"], ["Серебринка", 1, "fish_silverfin"], ["Теневая акула", 2, "fish_shark"]]) {
    assert.ok(fridge.includes(`aria-label="${name}: ${quantity}"`));
    assert.ok(fridge.includes(`data-item-icon="${id}"`));
  }
  assert.doesNotMatch(fridge, /data-hidden-fish|aria-label="(?:Древесина|Копчёная рыба|Лесной червячок):/);
  assert.match(fridge, /Места общие с кладовой/);
  for (const html of [supplies, fridge, render(economy, { initialTab: "relics" })]) {
    assert.ok(html.includes(`aria-label="Кладовая: занято ${state.storage.used} из ${state.storage.capacity} мест"`));
    assert.equal((html.match(/<progress /g) ?? []).length, 1);
  }
  assert.deepEqual(state, before, "switching storage views does not move or duplicate items");
});

test("three pantry tabs wrap keyboard navigation and focus the matching section", () => {
  let tree;
  function Probe() { tree = WorldPantryMenu({ economy: controller(), onUpgrade() {}, onExplore() {} }); return tree; }
  renderToStaticMarkup(createElement(Probe));
  const tabs = [];
  function walk(element) { if (!isValidElement(element)) return; if (element.props.role === "tab") tabs.push(element); Children.forEach(element.props.children, walk); }
  walk(tree);
  assert.equal(tabs.length, 3); assert.deepEqual(tabs.map(tab => tab.props.tabIndex), [0, -1, -1]);
  let focused = -1;
  tabs.forEach((tab, index) => tab.props.ref({ focus() { focused = index; } }));
  for (const [start, key, expected] of [[0, "ArrowRight", 1], [1, "ArrowRight", 2], [2, "ArrowRight", 0], [0, "ArrowLeft", 2], [1, "Home", 0], [0, "End", 2]]) {
    let prevented = false;
    tabs[start].props.onKeyDown({ key, preventDefault() { prevented = true; } });
    assert.equal(prevented, true); assert.equal(focused, expected);
  }
});

test("empty refrigerator invites a shoreline trip without suggesting a new storage purchase", () => {
  const html = render(controller(), { initialTab: "fridge" });
  assert.match(html, /Здесь будут рыба и готовые блюда/);
  assert.equal(disabled(button(html, "Выбрать вылазку")), false);
  assert.doesNotMatch(html, /Купить холодильник|Улучшить холодильник|Древесина: 20/);
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
    startedAt: new Date(now - 60_000).toISOString(), finishesAt: new Date(now + 45_000).toISOString(), rewards: {}, cost: { coins: 200, items: {} }, catalogVersion: 2 };
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

test("late pantry footer previews only the next capacity and its three relic counters", () => {
  const state = snapshot({ buildings: { home: 1, warehouse: 9 }, inventory: { ancient_core: 10, moon_crystal: 1, living_resin: 3 } });
  const before = structuredClone(state);
  const html = render(controller({ snapshot: state }));
  assert.match(html, /Ур\. 9 → 10 · 8\s?200 → 10\s?000 мест/);
  assert.match(html, /aria-label="Реликвии для следующего расширения"/);
  assert.match(html, /aria-label="Древнее ядро: есть 10, нужно 10"/);
  assert.match(html, /aria-label="Лунный кристалл: есть 1, нужно 3"/);
  assert.match(html, /aria-label="Живая смола: есть 3, нужно 3"/);
  assert.match(html, /data-relic="moon_crystal" data-missing="true"/);
  assert.doesNotMatch(html, /data-relic="(?:ancient_core|living_resin)" data-missing="true"/);
  assert.equal(disabled(button(html, "Расширить кладовую")), false, "the dialog must stay reachable to explain missing relics");
  assert.doesNotMatch(html, /Купить.*жемч|Список улучшений|ур\. 4|ур\. 5/);
  assert.deepEqual(state, before, "the preview must neither spend nor reserve relics");
});

test("the first ordinary pantry upgrade and paid expansion do not duplicate relic requirements", () => {
  assert.doesNotMatch(render(), /aria-label="Реликвии для следующего расширения"/);
  const nowJob = { id: "da818fb4-6c9e-4b42-9b78-60669b234f0a", kind: "construction", targetId: "warehouse", recipeId: null, targetLevel: 4,
    startedAt: new Date(now - 60_000).toISOString(), finishesAt: new Date(now + 60_000).toISOString(), rewards: {}, cost: { coins: 0, items: { ancient_core: 2, moon_crystal: 1, living_resin: 1 } }, catalogVersion: 3 };
  const html = render(controller({ snapshot: snapshot({ buildings: { home: 3, warehouse: 3 }, jobs: [nowJob] }) }));
  assert.match(html, /Кладовая расширяется/);
  assert.doesNotMatch(html, /aria-label="Реликвии для следующего расширения"/);
});

function inspectSale(state, props = {}, flags = {}) {
  const calls = [], economy = controller({ snapshot: state, act(...args) { calls.push(args); }, ...flags });
  let tree;
  function Probe() { tree = PantrySale({ economy, itemId: "wood", ...props }); return tree; }
  const html = renderToStaticMarkup(createElement(Probe)), elements = [];
  function walk(element) { if (!isValidElement(element)) return; elements.push(element); Children.forEach(element.props.children, walk); }
  walk(tree);
  const text = element => Children.toArray(element.props.children).map(child => typeof child === "string" || typeof child === "number" ? String(child) : isValidElement(child) ? text(child) : "").join("");
  const control = label => elements.find(element => element.type === "button" && text(element).includes(label));
  return { html, elements, control, calls };
}

test("quick sale shows catalog markdown and sends the displayed minimum quote without mutating stock", () => {
  const state = snapshot(); state.catalog.localBuyer = { payoutBps: 6000 };
  state.catalog.items.find(item => item.id === "wood").baseSellPrice = 30;
  const view = inspectSale(state);
  assert.match(view.html, /уценкой 40%/);
  assert.match(view.html, /Сумма за всё количество округляется вниз/);
  assert.match(button(view.html, "Продать торговцу").text, /· 10$/);
  view.control("Продать торговцу").props.onClick();
  assert.deepEqual(view.calls, [["sell", "wood", 1, 10]]);
  assert.equal(state.inventory.wood, 20);
});

test("penny stock starts at a payable batch, and wallet limits use the whole-stack rounded price", () => {
  const state = snapshot({ inventory: { crumb_bait: 10 }, wallet: { coins: 9_999_999_990, pearls: 0 } });
  state.catalog.localBuyer = { payoutBps: 6000 };
  const view = inspectSale(state, { itemId: "crumb_bait" });
  const input = view.elements.find(element => element.type === "input");
  assert.equal(input.props.min, 2); assert.equal(input.props.max, 3); assert.equal(input.props.value, "2");
  assert.match(button(view.html, "Продать торговцу").text, /· 10$/);
  view.control("Продать торговцу").props.onClick();
  assert.deepEqual(view.calls, [["sell", "crumb_bait", 2, 10]]);
  state.inventory.crumb_bait = 1;
  const empty = inspectSale(state, { itemId: "crumb_bait" });
  assert.equal(empty.control("Продать торговцу").props.disabled, true);
  empty.control("Продать торговцу").props.onClick(); assert.deepEqual(empty.calls, []);
  assert.match(empty.html, /нужно хотя бы 2 шт/);
});

test("fish points to Pleska's full price and an available navigation callback", () => {
  const state = snapshot({ inventory: { fish: 4 } }); state.catalog.localBuyer = { payoutBps: 6000 };
  let opened = 0;
  const view = inspectSale(state, { itemId: "fish", onOpenFishingShop() { opened++; } });
  assert.match(view.html, /Плёска купит дороже: 80 монет за штуку/);
  assert.match(button(view.html, "Продать торговцу").text, /· 40$/);
  view.control("К Плёске").props.onClick(); assert.equal(opened, 1); assert.deepEqual(view.calls, []);
  assert.doesNotMatch(inspectSale(state, { itemId: "fish" }).html, />К Плёске/);
});

test("old catalogs keep full sale prices and zero quote, while blocked handlers cannot dispatch", () => {
  const state = snapshot(); delete state.catalog.localBuyer;
  const item = state.catalog.items.find(item => item.id === "wood");
  const view = inspectSale(state);
  assert.doesNotMatch(view.html, /уценкой|округляется|Плёска купит дороже/);
  assert.ok(button(view.html, "Продать торговцу").text.endsWith(`· ${item.baseSellPrice}`));
  view.control("Продать торговцу").props.onClick(); assert.deepEqual(view.calls, [["sell", "wood", 1, 0]]);
  for (const flags of [{ busy: true }, { uncertain: true }, { retryAt: now + 5000 }]) {
    const blocked = inspectSale(state, {}, flags); assert.equal(blocked.control("Продать торговцу").props.disabled, true);
    blocked.control("Продать торговцу").props.onClick(); assert.deepEqual(blocked.calls, []);
  }
});

test("prepared meals share refrigerator capacity and cannot leak into the material section", () => {
  const inventory = { fish: 3, grilled_fish: 4, fish_soup: 2, wood: 5 };
  const state = snapshot({ inventory }), before = structuredClone(state), economy = controller({ snapshot: state });
  const fridge = render(economy, { initialTab: "fridge" });
  for (const [name, quantity] of [["Речная рыба", 3], ["Жареная рыба", 4], ["Рыбная уха", 2]]) assert.ok(fridge.includes(`aria-label="${name}: ${quantity}"`));
  assert.match(fridge, /<small>9<\/small><span>Холодильник<\/span>/);
  assert.doesNotMatch(fridge, /aria-label="Древесина:/);
  assert.doesNotMatch(render(economy), /aria-label="(?:Жареная рыба|Рыбная уха):/);
  assert.ok(fridge.includes(`aria-label="Кладовая: занято ${state.storage.used} из ${state.storage.capacity} мест"`));
  assert.deepEqual(state, before, "opening the refrigerator never moves food or creates a second capacity");
});

test("pantry meal action only opens food selection; raw fish and materials cannot be eaten there", () => {
  const state = snapshot({ inventory: { grilled_fish: 3, fish: 2, wood: 5 } });
  let opened = 0;
  const view = inspectSale(state, { itemId: "grilled_fish", onOpenFood() { opened++; } });
  assert.ok(view.control("Подать еду"));
  view.control("Подать еду").props.onClick();
  assert.equal(opened, 1); assert.deepEqual(view.calls, []); assert.equal(state.inventory.grilled_fish, 3);
  for (const itemId of ["fish", "wood"]) {
    const other = inspectSale(state, { itemId, onOpenFood() { assert.fail("non-meals cannot feed a resident"); } });
    assert.equal(other.control("Подать еду"), undefined);
  }
});
