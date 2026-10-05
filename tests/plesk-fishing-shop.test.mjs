import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { Children, createElement, isValidElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false } });
const { PleskFishingShop, PleskFishTrade, PleskRodOffer, PleskHookOffer, PleskBaitOffer, PleskTackleCounter, PleskFishingCollection, PleskCatchOdds, PleskMerchantHeader, FishCounter, fishingTradeLimits } = await vite.ssrLoadModule("/features/economy/plesk-fishing-shop.tsx");
const { economyCatalog, economyFishingSchema, ECONOMY_MAX_BALANCE } = await vite.ssrLoadModule("/features/economy/model.ts");
const { economyStorage } = await vite.ssrLoadModule("/features/economy/rules.ts");
const { fishingOdds, fishingState } = await vite.ssrLoadModule("/features/economy/fishing.ts");
after(() => vite.close());
const now = Date.parse("2026-10-04T20:00:00Z");
function merchant() {
  const catalog = economyCatalog.fishing;
  return { id: "shop-one", openedAt: new Date(now).toISOString(), refreshAt: new Date(now + 6 * 3600000).toISOString(), refreshPricePearls: 100, offers: [
    { kind: "rod", itemId: "river_rod", unitPrice: catalog.rods.find(entry => entry.id === "river_rod").price, remaining: 1 },
    { kind: "hook", itemId: "silver_hook", unitPrice: catalog.hooks.find(entry => entry.id === "silver_hook").price, remaining: 1 },
    ...catalog.baits.slice(0, 2).map(entry => ({ kind: "bait", itemId: entry.itemId, unitPrice: entry.price, remaining: 5 }))
  ].map(entry => ({ ...entry, id: `shop-one:${entry.itemId}` })) };
}
function snapshot(overrides = {}) {
  const state = { ownerPublicId: "ME", revision: 3, serverTime: new Date(now).toISOString(), wallet: { coins: 10000, pearls: 0 }, inventory: { fish: 5, fish_silverfin: 2, worm_bait: 3 },
    fishingShop: merchant(), buildings: { home: 1, warehouse: 1 }, jobs: [], completedExplorations: 0, fishing: economyFishingSchema.parse(undefined),
    migration: { version: 1, coinsGranted: 0, woodGranted: 0, stoneGranted: 0 }, catalog: structuredClone(economyCatalog), ...overrides };
  return { ...state, storage: overrides.storage ?? economyStorage(state) };
}
function controller(state, overrides = {}) {
  return { snapshot: state, busy: false, uncertain: false, error: null, notice: "", now, retryAt: 0,
    act() {}, retry() {}, refresh() {}, ...overrides };
}
function inspect(Component, props) {
  let tree;
  function Probe() { tree = Component(props); return tree; }
  const html = renderToStaticMarkup(createElement(Probe));
  const elements = [];
  function walk(element) { if (!isValidElement(element)) return; elements.push(element); Children.forEach(element.props.children, walk); }
  walk(tree);
  const text = element => Children.toArray(element.props.children).map(child => typeof child === "string" ? child : isValidElement(child) ? text(child) : "").join("");
  const control = label => {
    const found = elements.find(element => element.type === "button" && (element.props["aria-label"] === label || text(element).includes(label)));
    assert.ok(found, `Missing button: ${label}`); return found;
  };
  return { html, elements, control };
}
function trade(overrides = {}, itemId = "fish_silverfin", flags = {}) {
  const state = snapshot(overrides), calls = [], economy = controller(state, { act(...args) { calls.push(args); }, ...flags });
  return { ...inspect(PleskFishTrade, { economy, state, itemId }), state, economy, calls };
}

test("selling a species uses its exact id, stock and catalog value, with no optimistic debit", () => {
  const view = trade();
  const sell = view.control("Продать Серебринка: 1");
  assert.equal(sell.props.disabled, false);
  sell.props.onClick(); sell.props.onClick();
  assert.deepEqual(view.calls, [["sell_fish", "fish_silverfin", 1, 0]]);
  assert.equal(view.state.inventory.fish_silverfin, 2);
  assert.match(view.html, /В запасе <strong>2<\/strong>/);
});

test("the catch counter shows only positive pantry stock and has no fish purchase action", () => {
  const state = snapshot({ inventory: { fish_silverfin: 2, fish_shark: 0, wood: 10 } });
  const html = renderToStaticMarkup(createElement(FishCounter, { state, catalog: state.catalog.fishing, economy: controller(state) }));
  assert.match(html, /Серебринка/); assert.doesNotMatch(html, /Теневая акула|Купить|×0/);
  assert.equal((html.match(/aria-pressed=/g) ?? []).length, 1);
  const empty = snapshot({ inventory: {} });
  const emptyHtml = renderToStaticMarkup(createElement(FishCounter, { state: empty, catalog: empty.catalog.fishing, economy: controller(empty) }));
  assert.match(emptyHtml, /Улов ещё впереди/); assert.doesNotMatch(emptyHtml, /Количество|Продать|Теневая акула/);
});

test("in-flight, uncertain, cooling down, foreign and stale offers cannot buy or sell", () => {
  const original = snapshot();
  for (const flags of [{ busy: true }, { uncertain: true }, { retryAt: now + 5000 },
    { snapshot: { ...original, ownerPublicId: "OTHER" } }, { snapshot: { ...original, revision: 99 } }, { snapshot: null }]) {
    const view = trade({}, "fish_silverfin", flags);
    for (const label of ["Продать Серебринка: 1"]) {
      const action = view.control(label); assert.equal(action.props.disabled, true); action.props.onClick();
    }
    assert.deepEqual(view.calls, []);
  }
});

test("trade limits respect purse overflow, inventory, storage and transaction batch", () => {
  const state = snapshot({ inventory: { fish_silverfin: 9999 } });
  state.storage.available = 7;
  assert.equal(fishingTradeLimits(state, "fish_silverfin").buy, 0);
  assert.equal(fishingTradeLimits(state, "fish_silverfin").sell, state.catalog.maxBatch);
  state.wallet.coins = ECONOMY_MAX_BALANCE - state.catalog.items.find(item => item.id === "fish_silverfin").baseSellPrice;
  assert.equal(fishingTradeLimits(state, "fish_silverfin").sell, 1);
  state.wallet.coins = ECONOMY_MAX_BALANCE;
  assert.equal(fishingTradeLimits(state, "fish_silverfin").sell, 0);
  state.wallet.coins = 0;
  assert.equal(fishingTradeLimits(state, "fish_silverfin").buy, 0);
  assert.deepEqual(fishingTradeLimits(state, "wood"), { buy: 0, sell: 0, buyPrice: 0, sellPrice: 0 });
});

test("selling requires stock but remains possible with no coins and a full pantry", () => {
  let view = trade({ inventory: {} });
  view.control("Продать Серебринка: 1").props.onClick(); assert.deepEqual(view.calls, []);
  view = trade({ wallet: { coins: 0, pearls: 0 }, storage: { available: 0, capacity: 200, used: 200, reserved: 0, overflow: 0 } });
  assert.equal(view.control("Продать Серебринка: 1").props.disabled, false);
});

test("rod purchase and equipment selection are distinct confirmed commands", () => {
  const state = snapshot({ wallet: { coins: 100000, pearls: 0 } }), calls = [];
  const rod = state.catalog.fishing.rods.find(entry => entry.id === "river_rod");
  let view = inspect(PleskRodOffer, { state, economy: controller(state, { act(...args) { calls.push(args); } }), rod });
  view.control("Купить удочку").props.onClick(); view.control("Купить удочку").props.onClick();
  assert.deepEqual(calls, [["buy_fishing_item", "shop-one:river_rod", 1, rod.price]]);
  assert.deepEqual(state.fishing.ownedRods, ["reed_rod"]);
  state.fishing.ownedRods.push("river_rod"); calls.length = 0;
  view = inspect(PleskRodOffer, { state, economy: controller(state, { act(...args) { calls.push(args); } }), rod });
  view.control("Взять с собой").props.onClick();
  assert.deepEqual(calls, [["equip_fishing_rod", "river_rod", 1, 0]]);
  state.fishing.equippedRodId = "river_rod"; calls.length = 0;
  view = inspect(PleskRodOffer, { state, economy: controller(state, { act(...args) { calls.push(args); } }), rod });
  assert.equal(view.control("Выбрана").props.disabled, true); view.control("Выбрана").props.onClick();
  assert.deepEqual(calls, []);
});

test("bait purchases quote price, selection needs stock, and missing selected bait is explained", () => {
  const state = snapshot(), calls = [], bait = state.catalog.fishing.baits.find(entry => entry.itemId === "worm_bait");
  const props = { state, economy: controller(state, { act(...args) { calls.push(args); } }), bait };
  let view = inspect(PleskBaitOffer, props);
  view.control("Купить наживку: Лесной червячок").props.onClick();
  assert.deepEqual(calls, [["buy_fishing_item", "shop-one:worm_bait", 1, bait.price]]);
  calls.length = 0; view = inspect(PleskBaitOffer, props);
  view.control("Использовать").props.onClick();
  assert.deepEqual(calls, [["equip_fishing_bait", "worm_bait", 1, 0]]);
  state.inventory.worm_bait = 0; calls.length = 0;
  view = inspect(PleskBaitOffer, props); assert.doesNotMatch(view.html, /Использовать/);
  assert.deepEqual(calls, []);
  state.fishing.equippedBaitId = "worm_bait";
  view = inspect(PleskBaitOffer, props);
  assert.match(view.html, /Наживка закончилась/);
});

test("collection counts confirmed catches independently of purchased, sold or ambient fish", () => {
  const state = snapshot({ inventory: { fish_mooncarp: 90 }, fishing: { ownedRods: ["reed_rod", "river_rod"], equippedRodId: "reed_rod", equippedBaitId: null, catches: { fish_silverfin: 8 } } });
  const html = renderToStaticMarkup(createElement(PleskFishingCollection, { state, catalog: state.catalog.fishing }));
  assert.ok(html.includes(`Виды рыб: 1 / ${state.catalog.fishing.fish.length}`));
  assert.match(html, /Поймано: 8/);
  assert.doesNotMatch(html, /Поймано: 90/);
  assert.equal((html.match(/data-discovered="false"/g) ?? []).length, state.catalog.fishing.fish.length - 1);
  assert.match(html, /Удочки · 2 \/ 5/);
  assert.match(html, /Проданная рыба остаётся в коллекции/);
});

test("shop provides keyboard tab navigation and fishing/pantry navigation without account mutations", () => {
  const state = snapshot(), calls = [], nav = [];
  const view = inspect(PleskFishingShop, { economy: controller(state, { act(...args) { calls.push(args); } }), onFishing() { nav.push("fish"); }, onOpenPantry() { nav.push("pantry"); } });
  const buttons = view.elements.filter(element => element.props.role === "tab");
  assert.deepEqual(buttons.map(button => button.props.tabIndex), [0, -1, -1]);
  for (const key of ["ArrowRight", "ArrowLeft", "Home", "End"]) {
    let prevented = false; buttons[0].props.onKeyDown({ key, preventDefault() { prevented = true; } }); assert.equal(prevented, true);
  }
  view.control("На рыбалку").props.onClick(); view.control("Другие запасы").props.onClick();
  assert.deepEqual(nav, ["fish", "pantry"]); assert.deepEqual(calls, []);
  assert.match(view.html, /role="tabpanel"/);
  assert.match(view.html, /Новые товары через/);
  assert.doesNotMatch(view.html, /Ежедневные|Бесплатный улов/);
});

test("merchant displays four current offers and owned tackle without revealing the remaining catalog", () => {
  const state = snapshot(), calls = [];
  const props = { state, catalog: state.catalog.fishing, economy: controller(state, { act(...args) { calls.push(args); } }) };
  const view = inspect(PleskTackleCounter, props);
  assert.match(view.html, /Предложения Плёски/); assert.match(view.html, /Мои снасти/);
  assert.match(view.html, /Речная удочка/); assert.match(view.html, /Серебряный крючок/);
  assert.doesNotMatch(view.html, /Звёздная удочка|Крючок Левиафана|Искристая мушка/);
  const offers = view.elements.filter(element => element.type === "button" && element.props["data-gear-rarity"]);
  assert.equal(offers.length, 4);
  offers[1].props.onClick(); assert.deepEqual(calls, [], "looking at an offer never buys it");
  const tabs = view.elements.filter(element => element.props.role === "tab");
  assert.deepEqual(tabs.map(tab => tab.props.tabIndex), [0, -1, -1]);
  for (const key of ["ArrowLeft", "ArrowRight", "Home", "End"]) {
    let prevented = false; tabs[0].props.onKeyDown({ key, preventDefault() { prevented = true; } }); assert.equal(prevented, true);
  }
});

test("hook purchase equipment selection and confirmed ownership are separate guarded actions", () => {
  const state = snapshot({ wallet: { coins: 100000, pearls: 0 } }), calls = [];
  const hook = state.catalog.fishing.hooks.find(entry => entry.id === "silver_hook");
  const props = () => ({ state, economy: controller(state, { act(...args) { calls.push(args); } }), hook });
  let view = inspect(PleskHookOffer, props());
  view.control("Купить крючок").props.onClick(); view.control("Купить крючок").props.onClick();
  assert.deepEqual(calls, [["buy_fishing_item", `shop-one:${hook.id}`, 1, hook.price]]);
  assert.deepEqual(state.fishing.ownedHooks, ["bare_hook"]);
  assert.equal(state.inventory[hook.id], undefined);
  state.fishing.ownedHooks.push(hook.id); calls.length = 0;
  view = inspect(PleskHookOffer, props()); view.control("Взять с собой").props.onClick();
  assert.deepEqual(calls, [["equip_fishing_hook", hook.id, 1, 0]]);
  state.fishing.equippedHookId = hook.id; calls.length = 0;
  view = inspect(PleskHookOffer, props());
  assert.equal(view.control("Выбран").props.disabled, true); view.control("Выбран").props.onClick();
  assert.deepEqual(calls, []);
});

test("unaffordable stale foreign busy uncertain and cooling-down hooks cannot dispatch from their handlers", () => {
  const state = snapshot({ wallet: { coins: 100000, pearls: 0 } }), hook = state.catalog.fishing.hooks.find(entry => entry.id === "silver_hook");
  for (const flags of [{ busy: true }, { uncertain: true }, { retryAt: now + 5000 }, { snapshot: null },
    { snapshot: { ...state, ownerPublicId: "OTHER" } }, { snapshot: { ...state, revision: 99 } }]) {
    const calls = [], view = inspect(PleskHookOffer, { state, hook, economy: controller(state, { ...flags, act(...args) { calls.push(args); } }) });
    assert.equal(view.control("Купить крючок").props.disabled, true); view.control("Купить крючок").props.onClick(); assert.deepEqual(calls, []);
  }
  const poor = snapshot({ wallet: { coins: hook.price - 1, pearls: 0 } }), calls = [];
  const view = inspect(PleskHookOffer, { state: poor, hook, economy: controller(poor, { act(...args) { calls.push(args); } }) });
  assert.equal(view.control("Купить крючок").props.disabled, true); view.control("Купить крючок").props.onClick(); assert.deepEqual(calls, []);
  assert.match(view.html, /Не хватает 1 монет/);
});

test("odds previews use authoritative loadout weights and explain the one-draw party instead of guaranteeing rarity", () => {
  const state = snapshot(), catalog = state.catalog.fishing, before = structuredClone(state);
  const override = { rodId: "starfall_rod", hookId: "leviathan_hook", baitId: "firefly_bait" };
  const expected = fishingOdds(state, catalog, override);
  const html = renderToStaticMarkup(createElement(PleskCatchOdds, { state, catalog, override, preview: true }));
  const percent = value => `${new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 4 }).format(value * 100)}%`;
  assert.match(html, /Шансы одного особого улова за вылазку/);
  assert.match(html, /Остальные рыбы в партии — обычная рыба/);
  assert.match(html, /после выбора снасти перед отправлением/);
  assert.equal((html.match(/data-fish-odds=/g) ?? []).length, 12);
  for (const odd of expected) assert.ok(html.includes(`<dd>${percent(odd.probability)}</dd>`));
  const baseShark = fishingOdds(state, catalog).find(odd => odd.itemId === "fish_shark").probability;
  const betterShark = expected.find(odd => odd.itemId === "fish_shark").probability;
  assert.equal(baseShark, 0); assert(betterShark > baseShark && betterShark < .01);
  assert.doesNotMatch(html, /Теневая акула/); assert.match(html, /data-fish-rarity="legendary"/);
  assert.deepEqual(state, before, "Previewing gear cannot buy, equip or rewrite current odds");
});

test("legacy tackle defaults to the owned plain hook and hook collection ignores inventory goods", () => {
  const state = snapshot({ fishing: { ownedRods: ["reed_rod"], equippedRodId: "reed_rod", equippedBaitId: null, catches: {} }, inventory: { silver_hook: 100, fish_shark: 2 } });
  assert.equal(fishingState(state).equippedHookId, "bare_hook");
  assert.deepEqual(fishingState(state).ownedHooks, ["bare_hook"]);
  const html = renderToStaticMarkup(createElement(PleskFishingCollection, { state, catalog: state.catalog.fishing }));
  assert.match(html, /Крючки · 1 \/ 5/); assert.match(html, /Виды рыб: 0 \/ 12/);
  assert.doesNotMatch(html, /Поймано: 2|Крючки · 2/);
  const shop = renderToStaticMarkup(createElement(PleskFishingShop, { economy: controller(state), onFishing() {}, onOpenPantry() {} }));
  assert.match(shop, /Простой крючок/);
});


test("expired, sold-out and missing offers cannot dispatch a catalog purchase", () => {
  const rodId = "river_rod";
  for (const change of [state => { state.fishingShop.refreshAt = new Date(now).toISOString(); }, state => { state.fishingShop.offers[0].remaining = 0; }, state => { state.fishingShop = null; }]) {
    const state = snapshot({ wallet: { coins: 100000, pearls: 500 } }); change(state);
    const calls = [], view = inspect(PleskRodOffer, { state, economy: controller(state, { act(...args) { calls.push(args); } }), rod: state.catalog.fishing.rods.find(rod => rod.id === rodId) });
    const buy = view.control("Нет на прилавке"); assert.equal(buy.props.disabled, true); buy.props.onClick(); assert.deepEqual(calls, []);
  }
});

test("refresh shows server price and timer, requires pearls, and opens confirmation before spending", () => {
  const state = snapshot({ wallet: { coins: 0, pearls: 100 } }), calls = [];
  const view = inspect(PleskMerchantHeader, { state, economy: controller(state, { act(...args) { calls.push(args); } }) });
  assert.match(view.html, /6:00:00/);
  const button = view.control("Обновить предложения за 100 жемчужин"); assert.equal(button.props.disabled, false);
  button.props.onClick(); assert.deepEqual(calls, [], "first click never spends pearls");
  state.wallet.pearls = 99;
  const poor = inspect(PleskMerchantHeader, { state, economy: controller(state) });
  assert.equal(poor.control("Обновить предложения за 100 жемчужин").props.disabled, true);
  state.fishingShop.refreshAt = new Date(now).toISOString();
  const expired = inspect(PleskMerchantHeader, { state, economy: controller(state) });
  assert.match(expired.html, /Открываем новые предложения/);
  assert.equal(expired.control("Обновить предложения за 100 жемчужин").props.disabled, true);
});

test("fish art is mounted only after a personal catch, never after a purchase", () => {
  const state = snapshot({ inventory: { fish_shark: 2 }, fishing: { ...snapshot().fishing, catches: { fish_silverfin: 1 } } });
  const html = renderToStaticMarkup(createElement(PleskFishingCollection, { state, catalog: state.catalog.fishing }));
  assert.equal((html.match(/data-hidden-fish=/g) ?? []).length, state.catalog.fishing.fish.length - 1);
  assert.match(html, /data-item-icon="fish_silverfin"/);
  assert.doesNotMatch(html, /data-item-icon="fish_shark"|Теневая акула/);
  state.fishing.catches.fish_shark = 1;
  const revealed = renderToStaticMarkup(createElement(PleskFishingCollection, { state, catalog: state.catalog.fishing }));
  assert.match(revealed, /data-item-icon="fish_shark"/); assert.match(revealed, /Теневая акула/);
});
