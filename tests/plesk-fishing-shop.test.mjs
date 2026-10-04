import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { Children, createElement, isValidElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false } });
const { PleskFishingShop, PleskFishTrade, PleskRodOffer, PleskBaitOffer, PleskFishingCollection, fishingTradeLimits } = await vite.ssrLoadModule("/features/economy/plesk-fishing-shop.tsx");
const { economyCatalog, economyFishingSchema, ECONOMY_MAX_BALANCE } = await vite.ssrLoadModule("/features/economy/model.ts");
const { economyStorage } = await vite.ssrLoadModule("/features/economy/rules.ts");
after(() => vite.close());
const now = Date.parse("2026-10-04T20:00:00Z");
function snapshot(overrides = {}) {
  const state = { ownerPublicId: "ME", revision: 3, serverTime: new Date(now).toISOString(), wallet: { coins: 1000, pearls: 0 }, inventory: { fish: 5, fish_silverfin: 2, worm_bait: 3 },
    buildings: { home: 1, warehouse: 1 }, jobs: [], completedExplorations: 0, fishing: economyFishingSchema.parse(undefined),
    migration: { version: 1, coinsGranted: 0, woodGranted: 0, stoneGranted: 0 }, catalog: structuredClone(economyCatalog), ...overrides };
  return { ...state, storage: overrides.storage ?? economyStorage(state) };
}
function controller(state, overrides = {}) {
  return { snapshot: state, busy: false, uncertain: false, error: null, notice: "", now, retryAt: 0,
    act() {}, retry() {}, ...overrides };
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

test("buying quotes the complete price and the same offer cannot dispatch twice", () => {
  const view = trade();
  const offer = view.state.catalog.fishing.fish.find(fish => fish.itemId === "fish_silverfin");
  view.control("Купить Серебринка: 1").props.onClick();
  view.control("Продать Серебринка: 1").props.onClick();
  assert.deepEqual(view.calls, [["buy_fishing_item", "fish_silverfin", 1, offer.buyPrice]]);
  assert.equal(view.state.wallet.coins, 1000);
  assert.deepEqual(view.state.fishing.catches, {});
});

test("in-flight, uncertain, cooling down, foreign and stale offers cannot buy or sell", () => {
  const original = snapshot();
  for (const flags of [{ busy: true }, { uncertain: true }, { retryAt: now + 5000 },
    { snapshot: { ...original, ownerPublicId: "OTHER" } }, { snapshot: { ...original, revision: 99 } }, { snapshot: null }]) {
    const view = trade({}, "fish_silverfin", flags);
    for (const label of ["Продать Серебринка: 1", "Купить Серебринка: 1"]) {
      const action = view.control(label); assert.equal(action.props.disabled, true); action.props.onClick();
    }
    assert.deepEqual(view.calls, []);
  }
});

test("trade limits respect purse overflow, inventory, storage and transaction batch", () => {
  const state = snapshot({ inventory: { fish_silverfin: 9999 } });
  state.storage.available = 7;
  assert.equal(fishingTradeLimits(state, "fish_silverfin").buy, 7);
  assert.equal(fishingTradeLimits(state, "fish_silverfin").sell, state.catalog.maxBatch);
  state.wallet.coins = ECONOMY_MAX_BALANCE - 12;
  assert.equal(fishingTradeLimits(state, "fish_silverfin").sell, 1);
  state.wallet.coins = ECONOMY_MAX_BALANCE;
  assert.equal(fishingTradeLimits(state, "fish_silverfin").sell, 0);
  state.wallet.coins = 0;
  assert.equal(fishingTradeLimits(state, "fish_silverfin").buy, 0);
  assert.deepEqual(fishingTradeLimits(state, "wood"), { buy: 0, sell: 0, buyPrice: 0, sellPrice: 0 });
});

test("empty stock, full storage and insufficient coins disable handlers as well as buttons", () => {
  let view = trade({ inventory: {} });
  view.control("Продать Серебринка: 1").props.onClick(); assert.deepEqual(view.calls, []);
  view = trade({ wallet: { coins: 0, pearls: 0 } });
  view.control("Купить Серебринка: 1").props.onClick(); assert.deepEqual(view.calls, []);
  assert.match(view.html, /Для покупки не хватает монет/);
  view = trade({ storage: { available: 0, capacity: 200, used: 200, reserved: 0, overflow: 0 } });
  view.control("Купить Серебринка: 1").props.onClick(); assert.deepEqual(view.calls, []);
  assert.match(view.html, /освободить место в кладовой/);
  assert.equal(view.control("Продать Серебринка: 1").props.disabled, false);
});

test("rod purchase and equipment selection are distinct confirmed commands", () => {
  const state = snapshot(), calls = [];
  const rod = state.catalog.fishing.rods.find(entry => entry.id === "river_rod");
  let view = inspect(PleskRodOffer, { state, economy: controller(state, { act(...args) { calls.push(args); } }), rod });
  view.control("Купить удочку").props.onClick(); view.control("Купить удочку").props.onClick();
  assert.deepEqual(calls, [["buy_fishing_item", "river_rod", 1, rod.price]]);
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
  assert.deepEqual(calls, [["buy_fishing_item", "worm_bait", 1, bait.price]]);
  calls.length = 0; view = inspect(PleskBaitOffer, props);
  view.control("Использовать").props.onClick();
  assert.deepEqual(calls, [["equip_fishing_bait", "worm_bait", 1, 0]]);
  state.inventory.worm_bait = 0; calls.length = 0;
  view = inspect(PleskBaitOffer, props); view.control("Использовать").props.onClick();
  assert.deepEqual(calls, []);
  state.fishing.equippedBaitId = "worm_bait";
  view = inspect(PleskBaitOffer, props);
  assert.match(view.html, /Наживка закончилась/);
});

test("collection counts confirmed catches independently of purchased, sold or ambient fish", () => {
  const state = snapshot({ inventory: { fish_mooncarp: 90 }, fishing: { ownedRods: ["reed_rod", "river_rod"], equippedRodId: "reed_rod", equippedBaitId: null, catches: { fish_silverfin: 8 } } });
  const html = renderToStaticMarkup(createElement(PleskFishingCollection, { state, catalog: state.catalog.fishing }));
  assert.match(html, /Виды рыб: 1 \/ 4/);
  assert.match(html, /Поймано: 8/);
  assert.doesNotMatch(html, /Поймано: 90/);
  assert.equal((html.match(/data-discovered="false"/g) ?? []).length, 3);
  assert.match(html, /Удочки · 2 \/ 3/);
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
  assert.doesNotMatch(view.html, /Обновление через|Ежедневные|Бесплатный улов/);
});
