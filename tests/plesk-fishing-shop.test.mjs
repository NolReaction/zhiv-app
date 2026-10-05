import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { Children, createElement, isValidElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false } });
const { PleskFishingShop, PleskFishTrade, PleskRodOffer, PleskHookOffer, PleskBaitOffer, PleskTackleCounter, PleskFishingCollection, PleskCatchOdds, fishingTradeLimits } = await vite.ssrLoadModule("/features/economy/plesk-fishing-shop.tsx");
const { economyCatalog, economyFishingSchema, ECONOMY_MAX_BALANCE } = await vite.ssrLoadModule("/features/economy/model.ts");
const { economyStorage } = await vite.ssrLoadModule("/features/economy/rules.ts");
const { fishingOdds, fishingState } = await vite.ssrLoadModule("/features/economy/fishing.ts");
after(() => vite.close());
const now = Date.parse("2026-10-04T20:00:00Z");
function snapshot(overrides = {}) {
  const state = { ownerPublicId: "ME", revision: 3, serverTime: new Date(now).toISOString(), wallet: { coins: 10000, pearls: 0 }, inventory: { fish: 5, fish_silverfin: 2, worm_bait: 3 },
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
  assert.equal(view.state.wallet.coins, 10000);
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
  state.wallet.coins = ECONOMY_MAX_BALANCE - state.catalog.items.find(item => item.id === "fish_silverfin").baseSellPrice;
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
  const state = snapshot({ wallet: { coins: 100000, pearls: 0 } }), calls = [];
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

test("tackle counter separates rods hooks and bait and renders just one selected offer", () => {
  const state = snapshot(), calls = [];
  const props = { state, catalog: state.catalog.fishing, economy: controller(state, { act(...args) { calls.push(args); } }) };
  const rods = inspect(PleskTackleCounter, props);
  assert.match(rods.html, /role="tablist" aria-label="Виды снастей"/);
  assert.equal((rods.html.match(/<article\b/g) ?? []).length, 1);
  assert.match(rods.html, /Выбрать удочку на прилавке/);
  assert.doesNotMatch(rods.html, /Купить штук|Купить наживку:/);
  rods.control("Речная").props.onClick(); assert.deepEqual(calls, [], "browsing a rod does not buy or equip it");
  const baits = inspect(PleskTackleCounter, { ...props, initialCategory: "baits" });
  assert.equal((baits.html.match(/<article\b/g) ?? []).length, 1);
  assert.match(baits.html, /Выбрать наживку на прилавке/);
  assert.doesNotMatch(baits.html, /Выбрать удочку на прилавке|Купить удочку/);
  assert.match(baits.html, /Купить наживку:/);
  baits.control("Без наживки").props.onClick(); assert.deepEqual(calls, [], "the tile only opens details; choosing equipment is a separate explicit action");
  const tabs = rods.elements.filter(element => element.props.role === "tab");
  assert.deepEqual(tabs.map(tab => tab.props.tabIndex), [0, -1, -1]);
  for (const key of ["ArrowLeft", "ArrowRight", "Home", "End"]) {
    let prevented = false; tabs[0].props.onKeyDown({ key, preventDefault() { prevented = true; } }); assert.equal(prevented, true);
  }
  const hooks = inspect(PleskTackleCounter, { ...props, initialCategory: "hooks" });
  assert.equal((hooks.html.match(/<article\b/g) ?? []).length, 1);
  assert.match(hooks.html, /Выбрать крючок на прилавке/);
  assert.doesNotMatch(hooks.html, /Выбрать удочку на прилавке|Выбрать наживку на прилавке|Купить штук/);
  hooks.control("Серебряный").props.onClick(); assert.deepEqual(calls, [], "browsing a hook never buys or equips it");
  assert.match(hooks.html, /не занимает место в кладовой/);
});

test("hook purchase equipment selection and confirmed ownership are separate guarded actions", () => {
  const state = snapshot({ wallet: { coins: 100000, pearls: 0 } }), calls = [];
  const hook = state.catalog.fishing.hooks.find(entry => entry.id === "silver_hook");
  const props = () => ({ state, economy: controller(state, { act(...args) { calls.push(args); } }), hook });
  let view = inspect(PleskHookOffer, props());
  view.control("Купить крючок").props.onClick(); view.control("Купить крючок").props.onClick();
  assert.deepEqual(calls, [["buy_fishing_item", hook.id, 1, hook.price]]);
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
  const state = snapshot({ wallet: { coins: 100000, pearls: 0 } }), hook = state.catalog.fishing.hooks.find(entry => entry.id === "barbed_hook");
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
  const override = { rodId: "willow_rod", hookId: "silver_hook", baitId: "worm_bait" };
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
  assert(betterShark > baseShark && betterShark < .002);
  assert.match(html, /Теневая акула/); assert.match(html, /data-fish-rarity="legendary"/);
  assert.deepEqual(state, before, "Previewing gear cannot buy, equip or rewrite current odds");
});

test("legacy tackle defaults to the owned plain hook and hook collection ignores inventory goods", () => {
  const state = snapshot({ fishing: { ownedRods: ["reed_rod"], equippedRodId: "reed_rod", equippedBaitId: null, catches: {} }, inventory: { silver_hook: 100, fish_shark: 2 } });
  assert.equal(fishingState(state).equippedHookId, "bare_hook");
  assert.deepEqual(fishingState(state).ownedHooks, ["bare_hook"]);
  const html = renderToStaticMarkup(createElement(PleskFishingCollection, { state, catalog: state.catalog.fishing }));
  assert.match(html, /Крючки · 1 \/ 3/); assert.match(html, /Виды рыб: 0 \/ 12/);
  assert.doesNotMatch(html, /Поймано: 2|Крючки · 2/);
  const shop = renderToStaticMarkup(createElement(PleskFishingShop, { economy: controller(state), onFishing() {}, onOpenPantry() {} }));
  assert.match(shop, /Простой крючок/);
});
