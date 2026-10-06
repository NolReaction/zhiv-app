import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { Children, createElement, isValidElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false } });
const { PleskFishingShop, PleskFishTrade, PleskRodOffer, PleskHookOffer, PleskBaitOffer, PleskFishOffer, PleskTackleCounter, PleskFishingCollection, PleskCatchOdds, PleskMerchantHeader, FishCounter, fishingTradeLimits } = await vite.ssrLoadModule("/features/economy/plesk-fishing-shop.tsx");
const { PleskFishingBookPage, fishingBookEntries, fishingBookPage, FISHING_BOOK_PAGE_SIZE } = await vite.ssrLoadModule("/features/economy/plesk-fishing-book.tsx");
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
    { kind: "bait", itemId: "worm_bait", unitPrice: catalog.baits.find(entry => entry.itemId === "worm_bait").price, remaining: 5 },
    { kind: "fish", itemId: "fish", unitPrice: 128, remaining: 3 }
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
  assert.match(html, /data-item-icon="fish_silverfin"/); assert.doesNotMatch(html, /data-hidden-fish/);
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

test("merchant rod purchase never equips or resells an owned rod", () => {
  const state = snapshot({ wallet: { coins: 100000, pearls: 0 } }), calls = [];
  const rod = state.catalog.fishing.rods.find(entry => entry.id === "river_rod");
  let view = inspect(PleskRodOffer, { state, economy: controller(state, { act(...args) { calls.push(args); } }), rod });
  view.control("Купить удочку").props.onClick(); view.control("Купить удочку").props.onClick();
  assert.deepEqual(calls, [["buy_fishing_item", "shop-one:river_rod", 1, rod.price]]);
  assert.deepEqual(state.fishing.ownedRods, ["reed_rod"]);
  state.fishing.ownedRods.push("river_rod"); calls.length = 0;
  view = inspect(PleskRodOffer, { state, economy: controller(state, { act(...args) { calls.push(args); } }), rod });
  assert.equal(view.control("Куплено").props.disabled, true); view.control("Куплено").props.onClick();
  assert.deepEqual(calls, []);
  assert.doesNotMatch(view.html, /Взять с собой|Выбрана/);
  assert.equal(state.fishing.equippedRodId, "reed_rod");
});

test("bait purchases quote stock and price without equipment controls", () => {
  const state = snapshot(), calls = [], bait = state.catalog.fishing.baits.find(entry => entry.itemId === "worm_bait");
  const props = { state, economy: controller(state, { act(...args) { calls.push(args); } }), bait };
  let view = inspect(PleskBaitOffer, props);
  view.control("Купить наживку: Лесной червячок").props.onClick();
  assert.deepEqual(calls, [["buy_fishing_item", "shop-one:worm_bait", 1, bait.price]]);
  assert.doesNotMatch(view.html, /Использовать|На следующую рыбалку|Выбрана/);
  assert.equal(state.fishing.equippedBaitId, null);
  state.inventory.worm_bait = 0;
  view = inspect(PleskBaitOffer, props);
  assert.match(view.html, /В запасе 0/);
});

test("collection counts confirmed catches independently of purchased, sold or ambient fish", () => {
  const state = snapshot({ inventory: { fish_mooncarp: 90 }, fishing: { ownedRods: ["reed_rod", "river_rod"], equippedRodId: "reed_rod", equippedBaitId: null, catches: { fish_silverfin: 8 } } });
  const html = renderToStaticMarkup(createElement(PleskFishingCollection, { state, catalog: state.catalog.fishing }));
  assert.ok(html.includes(`Виды рыб: 1 / ${state.catalog.fishing.fish.length}`));
  assert.match(html, /Поймано: 8/);
  assert.doesNotMatch(html, /Поймано: 90/);
  assert.equal((html.match(/data-discovered="false"/g) ?? []).length, FISHING_BOOK_PAGE_SIZE - 1);
  assert.match(html, /Удочки/); assert.match(html, /Снасти/); assert.match(html, /Наживки/);
  assert.match(html, /Проданная рыба остаётся в коллекции/);
});

test("book chapters expose actual gear ownership and bait stock without revealing missing items", () => {
  const state = snapshot({ fishing: { ...snapshot().fishing, ownedRods: ["reed_rod", "river_rod"], ownedHooks: ["bare_hook", "silver_hook"] }, inventory: { worm_bait: 3, silver_hook: 100, fish_shark: 7 } });
  const rods = fishingBookEntries(state, state.catalog.fishing, "rods"), hooks = fishingBookEntries(state, state.catalog.fishing, "hooks"), baits = fishingBookEntries(state, state.catalog.fishing, "baits");
  assert.equal(rods.filter(entry => entry.known).length, 2); assert.equal(hooks.filter(entry => entry.known).length, 2);
  assert.equal(baits.filter(entry => entry.known).length, 1); assert.equal(baits.find(entry => entry.id === "worm_bait").status, "В запасе: 3");
  const renderChapter = chapter => renderToStaticMarkup(createElement(PleskFishingBookPage, { state, catalog: state.catalog.fishing, chapter }));
  const rodHtml = renderChapter("rods"), hookHtml = renderChapter("hooks"), baitHtml = renderChapter("baits");
  assert.match(rodHtml, /Речная удочка/); assert.doesNotMatch(rodHtml, /Звёздная удочка|Купить|Продать|Взять с собой/);
  assert.match(hookHtml, /Серебряный крючок/); assert.doesNotMatch(hookHtml, /Крючок Левиафана/);
  assert.match(baitHtml, /Лесной червячок|В запасе: 3/); assert.doesNotMatch(baitHtml, /Искристая мушка/);
  state.inventory.worm_bait = 0;
  assert.equal(fishingBookEntries(state, state.catalog.fishing, "baits").filter(entry => entry.known).length, 0, "spent bait is current stock, not a fake lifetime collection");
  assert.match(renderChapter("baits"), /Нет в запасе/);
});

test("book paginates every fish once and clamps stale page indexes without leaking unowned gear", () => {
  const state = snapshot(), entries = fishingBookEntries(state, state.catalog.fishing, "fish"), pages = Math.ceil(entries.length / FISHING_BOOK_PAGE_SIZE);
  const visibleIds = [];
  for (let page = 0; page < pages; page++) {
    const slice = fishingBookPage(entries, page);
    assert.ok(slice.entries.length <= FISHING_BOOK_PAGE_SIZE);
    visibleIds.push(...slice.entries.map(entry => entry.id));
    const html = renderToStaticMarkup(createElement(PleskFishingBookPage, { state, catalog: state.catalog.fishing, chapter: "fish", page }));
    assert.equal((html.match(/data-book-entry=/g) ?? []).length, slice.entries.length);
    assert.doesNotMatch(html, /data-item-icon="fish_shark"|Теневая акула/);
  }
  assert.deepEqual(visibleIds, entries.map(entry => entry.id));
  assert.equal(fishingBookPage(entries, 999).page, pages - 1); assert.equal(fishingBookPage(entries, -2).page, 0);
  assert.deepEqual(fishingBookPage([], 99), { page: 0, pages: 1, entries: [] });
});

test("book chapter tabs have keyboard navigation and bounded accessible pagination", () => {
  const state = snapshot(), view = inspect(PleskFishingCollection, { state, catalog: state.catalog.fishing });
  const tabs = view.elements.filter(element => element.props.role === "tab");
  assert.equal(tabs.length, 4); assert.deepEqual(tabs.map(tab => tab.props.tabIndex), [0, -1, -1, -1]);
  for (const key of ["ArrowRight", "ArrowLeft", "Home", "End"]) {
    let prevented = false; tabs[0].props.onKeyDown({ key, preventDefault() { prevented = true; } }); assert.equal(prevented, true);
  }
  assert.equal(view.control("Предыдущая страница").props.disabled, true);
  assert.equal(view.control("Следующая страница").props.disabled, false);
  assert.match(view.html, /Страница 1 из 2/); assert.match(view.html, /aria-live="polite"/); assert.match(view.html, /<progress/);
});

test("discount fish is purchased through its live offer with server price and an honest preview", () => {
  const state = snapshot(), calls = [], fish = state.catalog.fishing.fish.find(entry => entry.itemId === "fish_silverfin");
  const offer = { id: "shop-one:fish_silverfin", kind: "fish", itemId: fish.itemId, unitPrice: 192, remaining: 3 };
  state.fishingShop.offers[3] = offer;
  const props = { state, fish, economy: controller(state, { act(...args) { calls.push(args); } }) };
  const view = inspect(PleskFishOffer, props);
  assert.match(view.html, /Обычная цена: 240 монет/); assert.match(view.html, /data-item-icon="fish_silverfin"/); assert.doesNotMatch(view.html, /data-hidden-fish/);
  view.control("Купить рыбу: Серебринка").props.onClick(); view.control("Купить рыбу: Серебринка").props.onClick();
  assert.deepEqual(calls, [["buy_fishing_item", offer.id, 1, 192]]); assert.deepEqual(state.fishing.catches, {});
});

test("fish offer rejects full storage, insufficient coins and guarded controller states", () => {
  for (const flags of [{ busy: true }, { uncertain: true }, { retryAt: now + 5000 }, { snapshot: null }]) {
    const state = snapshot(), calls = [], fish = state.catalog.fishing.fish.find(entry => entry.itemId === "fish");
    const view = inspect(PleskFishOffer, { state, fish, economy: controller(state, { ...flags, act(...args) { calls.push(args); } }) });
    const button = view.control("Купить рыбу: Речная рыба"); assert.equal(button.props.disabled, true); button.props.onClick(); assert.deepEqual(calls, []);
  }
  for (const patch of [{ storage: { available: 0 } }, { wallet: { coins: 127, pearls: 0 } }]) {
    const state = snapshot(patch), calls = [], fish = state.catalog.fishing.fish.find(entry => entry.itemId === "fish");
    const view = inspect(PleskFishOffer, { state, fish, economy: controller(state, { act(...args) { calls.push(args); } }) });
    const button = view.control("Купить рыбу: Речная рыба"); assert.equal(button.props.disabled, true); button.props.onClick(); assert.deepEqual(calls, []);
  }
});

test("merchant keeps one category per slot with legacy duplicate stock still available in a folded section", () => {
  const state = snapshot(); state.fishingShop.offers = [state.fishingShop.offers[0], { ...state.fishingShop.offers[0], id: "other-rod", itemId: "willow_rod" }];
  const html = renderToStaticMarkup(createElement(PleskTackleCounter, { state, catalog: state.catalog.fishing, economy: controller(state) }));
  assert.equal((html.match(/Ждём поставку/g) ?? []).length, 3);
  assert.match(html, /Речная удочка/); assert.match(html, /<summary>Остатки прежней поставки · 1<\/summary>/); assert.match(html, /Ивовая удочка/);
});

test("fish offers disclose their real art and name before payment, without opening a book entry", () => {
  const state = snapshot({ inventory: {}, fishing: economyFishingSchema.parse(undefined) });
  const offer = { id: "shop-one:fish_silverfin", kind: "fish", itemId: "fish_silverfin", unitPrice: 192, remaining: 3 };
  const fish = state.catalog.fishing.fish.find(entry => entry.itemId === offer.itemId);
  state.fishingShop.offers[3] = offer;
  state.fishingShop.offers.push({ ...offer, id: "old-fish:fish_mooncarp", itemId: "fish_mooncarp" });
  const before = structuredClone(state), calls = [], economy = controller(state, { act(...args) { calls.push(args); } });
  const counter = inspect(PleskTackleCounter, { state, catalog: state.catalog.fishing, economy });
  assert.match(counter.html, /Серебринка/); assert.match(counter.html, /data-item-icon="fish_silverfin"/);
  assert.match(counter.html, /Лунный карасик/); assert.doesNotMatch(counter.html, /Незнакомая рыба|data-hidden-fish/);
  const detail = inspect(PleskFishOffer, { state, fish, economy });
  assert.match(detail.html, /data-item-icon="fish_silverfin"/); assert.match(detail.html, /В книгу попадёт только ваш собственный улов/);
  detail.control("Купить рыбу: Серебринка").props.onClick();
  assert.deepEqual(calls, [["buy_fishing_item", offer.id, 1, offer.unitPrice]]);
  assert.deepEqual(state, before, "preview and purchase dispatch never create catches or alter stock");
  assert.equal(fishingBookEntries(state, state.catalog.fishing, "fish").filter(entry => entry.known).length, 0);
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

test("merchant displays four current offers without personal gear or the remaining catalog", () => {
  const state = snapshot(), calls = [];
  const props = { state, catalog: state.catalog.fishing, economy: controller(state, { act(...args) { calls.push(args); } }) };
  const view = inspect(PleskTackleCounter, props);
  assert.match(view.html, /Предложения Плёски/); assert.doesNotMatch(view.html, /Мои снасти|Ваши снасти|Взять с собой|Использовать/);
  assert.match(view.html, /Речная удочка/); assert.match(view.html, /Серебряный крючок/);
  assert.doesNotMatch(view.html, /Звёздная удочка|Крючок Левиафана|Искристая мушка/);
  const offers = view.elements.filter(element => element.type === "button" && element.props["data-gear-rarity"]);
  assert.equal(offers.length, 4);
  offers[1].props.onClick(); assert.deepEqual(calls, [], "looking at an offer never buys it");

});

test("merchant hook purchase is guarded and never equips owned gear", () => {
  const state = snapshot({ wallet: { coins: 100000, pearls: 0 } }), calls = [];
  const hook = state.catalog.fishing.hooks.find(entry => entry.id === "silver_hook");
  const props = () => ({ state, economy: controller(state, { act(...args) { calls.push(args); } }), hook });
  let view = inspect(PleskHookOffer, props());
  view.control("Купить крючок").props.onClick(); view.control("Купить крючок").props.onClick();
  assert.deepEqual(calls, [["buy_fishing_item", `shop-one:${hook.id}`, 1, hook.price]]);
  assert.deepEqual(state.fishing.ownedHooks, ["bare_hook"]);
  assert.equal(state.inventory[hook.id], undefined);
  state.fishing.ownedHooks.push(hook.id); calls.length = 0;
  view = inspect(PleskHookOffer, props());
  assert.equal(view.control("Куплено").props.disabled, true); view.control("Куплено").props.onClick();
  assert.deepEqual(calls, []);
  assert.equal(state.fishing.equippedHookId, "bare_hook");
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

test("odds previews use authoritative loadout weights and show every rarity target without a universal upgrade score", () => {
  const state = snapshot(), catalog = state.catalog.fishing, before = structuredClone(state);
  const override = { rodId: "starfall_rod", hookId: "leviathan_hook", baitId: "firefly_bait" };
  const expected = fishingOdds(state, catalog, override);
  const html = renderToStaticMarkup(createElement(PleskCatchOdds, { state, catalog, override, preview: true }));
  const percent = value => `${new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 4 }).format(value * 100)}%`;
  assert.match(html, /Каждый особый улов проверяется отдельно/);
  assert.match(html, /остальная партия — обычная рыба/);
  assert.match(html, /после выбора снасти перед отправлением/);
  assert.equal((html.match(/data-fish-odds=/g) ?? []).length, 12);
  for (const odd of expected) assert.ok(html.includes(`<dd>${percent(odd.probability)}</dd>`));
  const baseShark = fishingOdds(state, catalog).find(odd => odd.itemId === "fish_shark").probability;
  const betterShark = expected.find(odd => odd.itemId === "fish_shark").probability;
  assert.equal(baseShark, 0); assert(betterShark > baseShark && betterShark < .01);
  assert.doesNotMatch(html, /Теневая акула/); assert.match(html, /data-fish-rarity="legendary"/);
  assert.deepEqual(state, before, "Previewing gear cannot buy, equip or rewrite current odds");
});

test("legacy tackle defaults survive without adding gear or invented catches to the fish book", () => {
  const state = snapshot({ fishing: { ownedRods: ["reed_rod"], equippedRodId: "reed_rod", equippedBaitId: null, catches: {} }, inventory: { silver_hook: 100, fish_shark: 2 } });
  assert.equal(fishingState(state).equippedHookId, "bare_hook");
  assert.deepEqual(fishingState(state).ownedHooks, ["bare_hook"]);
  const html = renderToStaticMarkup(createElement(PleskFishingCollection, { state, catalog: state.catalog.fishing }));
  assert.match(html, /Виды рыб: 0 \/ 12/);
  assert.equal(fishingBookEntries(state, state.catalog.fishing, "hooks").filter(entry => entry.known).length, 1);
  assert.doesNotMatch(html, /Поймано: 2|Крючки · 2/);
  const shop = renderToStaticMarkup(createElement(PleskFishingShop, { economy: controller(state), onFishing() {}, onOpenPantry() {} }));
  assert.doesNotMatch(shop, /Простой крючок|Мои снасти/);
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
  const state = snapshot({ wallet: { coins: 0, pearls: 100 }, buildings: { home: 5, warehouse: 1 } }), calls = [];
  state.fishingShop.offers[0] = { ...state.fishingShop.offers[0], itemId: "tide_rod", id: "shop-one:tide_rod" };
  const view = inspect(PleskMerchantHeader, { state, economy: controller(state, { act(...args) { calls.push(args); } }) });
  assert.match(view.html, /6:00:00/);
  const button = view.control("Обновить предложения за 50 жемчужин"); assert.equal(button.props.disabled, false);
  button.props.onClick(); assert.deepEqual(calls, [], "first click never spends pearls");
  state.wallet.pearls = 99;
  const poor = inspect(PleskMerchantHeader, { state, economy: controller(state) });
  assert.equal(poor.control("Обновить предложения за 50 жемчужин").props.disabled, true);
  state.fishingShop.refreshAt = new Date(now).toISOString();
  const expired = inspect(PleskMerchantHeader, { state, economy: controller(state) });
  assert.match(expired.html, /Открываем новые предложения/);
  assert.equal(expired.control("Обновить предложения за 50 жемчужин").props.disabled, true);
});

test("the fish book opens art only after a personal catch, never after a purchase", () => {
  const state = snapshot({ inventory: { fish_shark: 2 }, fishing: { ...snapshot().fishing, catches: { fish_silverfin: 1 } } });
  const html = renderToStaticMarkup(createElement(PleskFishingCollection, { state, catalog: state.catalog.fishing }));
  assert.equal((html.match(/data-hidden-fish=/g) ?? []).length, FISHING_BOOK_PAGE_SIZE - 1);
  assert.match(html, /data-item-icon="fish_silverfin"/);
  assert.doesNotMatch(html, /data-item-icon="fish_shark"|Теневая акула/);
  state.fishing.catches.fish_shark = 1;
  const revealed = renderToStaticMarkup(createElement(PleskFishingBookPage, { state, catalog: state.catalog.fishing, chapter: "fish", page: 1 }));
  assert.match(revealed, /data-item-icon="fish_shark"/); assert.match(revealed, /Теневая акула/);
});


test("owned fish remain visible goods without falsely opening the catch book", async () => {
  const { PlayerItemIcon, fishDiscovered } = await vite.ssrLoadModule("/features/economy/fish-discovery.tsx");
  const state = snapshot({ inventory: { fish: 4, fish_shark: 2 }, fishing: economyFishingSchema.parse(undefined) });
  assert.match(renderToStaticMarkup(createElement(PlayerItemIcon, { state, itemId: "fish" })), /data-item-icon="fish"/);
  assert.match(renderToStaticMarkup(createElement(PlayerItemIcon, { state, itemId: "fish_shark" })), /data-item-icon="fish_shark"/);
  assert.match(renderToStaticMarkup(createElement(PlayerItemIcon, { state, itemId: "fish_mooncarp" })), /data-hidden-fish/);
  assert.equal(fishDiscovered(state, "fish"), false);
  assert.equal(fishDiscovered(state, "fish_shark"), false);
  const book = renderToStaticMarkup(createElement(PleskFishingCollection, { state, catalog: state.catalog.fishing }));
  assert.equal((book.match(/data-hidden-fish=/g) ?? []).length, FISHING_BOOK_PAGE_SIZE);
  assert.match(book, /Виды рыб: 0 \/ 12/);
});


test("merchant disables paid replacement when there are not enough different eligible goods", () => {
  const state = snapshot({ wallet: { coins: 0, pearls: 1000 } }), calls = [];
  state.fishing.ownedRods.push("brook_rod");
  state.fishing.ownedHooks.push("round_hook");
  const view = inspect(PleskMerchantHeader, { state, economy: controller(state, { act(...args) { calls.push(args); } }) });
  assert.match(view.html, /Пока не все товары можно заменить на другие/);
  assert.match(view.html, /6:00:00/);
  const button = view.control("Обновить предложения за 50 жемчужин");
  assert.equal(button.props.disabled, true);
  button.props.onClick();
  assert.deepEqual(calls, []);
});
