import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { Children, isValidElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const hookModule = "virtual:currency-shop-hooks";
const vite = await createServer({ appType: "custom", configFile: false, root, resolve: { alias: { "@": root } },
  server: { middlewareMode: true, hmr: false, ws: false }, plugins: [{ name: "currency-shop-handlers", enforce: "pre",
    resolveId(id) { if (id === hookModule) return `\0${id}`; },
    load(id) { if (id === `\0${hookModule}`) return `
      let slots = [], cursor = 0;
      export function reset() { slots = []; cursor = 0; }
      export function render() { cursor = 0; }
      export function useState(initial) { const index = cursor++; if (!(index in slots)) slots[index] = initial; return [slots[index], value => { slots[index] = value; }]; }
      export function useRef(initial) { const index = cursor++; if (!(index in slots)) slots[index] = { current: initial }; return slots[index]; }
      export function useId() { return 'shop-' + cursor++; }
    `; },
    transform(source, id) { if (id.endsWith("/features/economy/currency-shop-panel.tsx")) return source.replace('from "react";', `from "${hookModule}";`); },
  }],
});
after(() => vite.close());
const { economyCatalog } = await vite.ssrLoadModule("/features/economy/model.ts");
const shop = await vite.ssrLoadModule("/features/economy/currency-shop.ts");
const { CurrencyShopPanel } = await vite.ssrLoadModule("/features/economy/currency-shop-panel.tsx");
const hooks = await vite.ssrLoadModule(hookModule);
const state = buildings => ({ catalog: economyCatalog, buildings, jobs: [] });
const firstQuote = buildings => shop.currencyShopGoldOffers(state(buildings))[0];

test("shop quotes use current currency units and fixed packages without volume discounts", () => {
  assert.deepEqual(shop.PEARL_SHOP_PACKAGES.map(pack => pack.pearls), [500, 1500, 4000, 10000]);
  assert.deepEqual(shop.GOLD_SHOP_PACKAGES.map(pack => pack.pearls), [100, 300, 750]);
  for (const pack of [...shop.PEARL_SHOP_PACKAGES, ...shop.GOLD_SHOP_PACKAGES]) assert.equal(pack.pearls % 50, 0);
  const offers = shop.currencyShopGoldOffers(state({ home: 1 }));
  assert.deepEqual(offers.map(pack => [pack.baseCoins, pack.bonusCoins, pack.coins]), [[10000, 0, 10000], [30000, 0, 30000], [75000, 0, 75000]]);
  assert.deepEqual([1, 2, 3, 4, 5].map(home => firstQuote({ home }).coins), [10000, 15000, 25000, 40000, 70000]);
});

test("completed house and catalog buildings contribute separate additive percentages", () => {
  const middle = state({ home: 3, workshop: 3, warehouse: 3, garden: 2, woodlot: 2 });
  assert.deepEqual(shop.currencyShopDevelopment(middle), { homeLevel: 3, completedLevels: 10, totalLevels: 35,
    homeBonusPercent: 150, buildingBonusPercent: 28, bonusPercent: 178 });
  assert.deepEqual(shop.currencyShopGoldOffers(middle).map(pack => pack.coins), [27800, 83400, 208500]);
  assert.equal(firstQuote({ home: 1, garden: 1 }).coins, 10200, "one of 35 completed levels floors the bonus to two percent");
  const full = state(Object.fromEntries(economyCatalog.buildings.map(building => [building.id, 5])));
  assert.equal(shop.currencyShopDevelopment(full).bonusPercent, 700);
  assert.deepEqual(shop.currencyShopGoldOffers(full).map(pack => pack.coins), [80000, 240000, 600000]);
});

test("development is monotonic, finite and bounded for every current completed level", () => {
  const buildings = { home: 1 };
  let previous = 10000;
  for (const building of economyCatalog.buildings) for (const entry of building.levels) {
    buildings[building.id] = entry.level;
    const offers = shop.currencyShopGoldOffers(state(buildings));
    assert.ok(offers[0].coins >= previous);
    for (const quote of offers) {
      assert.ok(Number.isSafeInteger(quote.coins));
      assert.ok(quote.coins <= quote.baseCoins * 8);
      assert.equal(quote.coins / quote.pearls, offers[0].coins / offers[0].pearls);
    }
    previous = offers[0].coins;
  }
  assert.equal(previous, 80000);
});

test("unknown, unfinished and future uncatalogued buildings cannot boost the quote or mutate state", () => {
  const initial = state({ home: 2, garden: 2, imaginary_building: 100 });
  initial.jobs.push({ kind: "construction", targetId: "home", targetLevel: 5, finishesAt: "2020-01-01T00:00:00Z" },
    { kind: "construction", targetId: "workshop", targetLevel: 5, finishesAt: "2020-01-01T00:00:00Z" });
  initial.catalog = structuredClone(economyCatalog);
  initial.catalog.buildings.push({ id: "future_bridge", levels: [] });
  initial.buildings.future_bridge = 5;
  const frozen = structuredClone(initial);
  assert.deepEqual(shop.currencyShopGoldOffers(initial), shop.currencyShopGoldOffers(state({ home: 2, garden: 2 })));
  assert.deepEqual(initial, frozen);
  assert.equal(shop.currencyShopDevelopment({ catalog: { buildings: [] }, buildings: { home: 100 } }).bonusPercent, 0);
  const impossible = Object.fromEntries(economyCatalog.buildings.map(building => [building.id, 100]));
  assert.equal(firstQuote(impossible).coins, 80000, "saved levels cannot exceed the catalog cap");
  for (const invalid of [NaN, Infinity, -1, 2.5]) assert.equal(firstQuote({ home: invalid, garden: invalid }).coins, 10000);
});

function harness(snapshot = state({ home: 3, garden: 2 })) {
  hooks.reset();
  const focused = [];
  const render = () => {
    hooks.render(); const tree = CurrencyShopPanel({ state: snapshot }), nodes = [];
    function visit(element) { if (!isValidElement(element)) return; nodes.push(element); Children.forEach(element.props.children, visit); }
    visit(tree);
    nodes.filter(node => node.props.role === "tab").forEach((node, index) => node.props.ref?.({ focus() { focused.push(index); } }));
    return { nodes, html: renderToStaticMarkup(tree) };
  };
  return { render, focused };
}
const tabs = view => view.nodes.filter(node => node.props.role === "tab");

test("preview tabs show compact distinct currencies and cannot spend or grant either balance", () => {
  const snapshot = state({ home: 3, garden: 2 });
  Object.defineProperty(snapshot, "wallet", { get() { throw new Error("Preview must not consult or modify balances"); } });
  const h = harness(snapshot);
  let view = h.render();
  assert.match(view.html, /Покупки и обмен пока недоступны/);
  assert.equal(view.nodes.filter(node => node.props["data-shop-offer"]).length, 4);
  assert.doesNotMatch(view.html, /₽|₸|€|\$/);
  for (const page of [0, 1]) {
    tabs(view)[page].props.onClick(); view = h.render();
    const actions = view.nodes.filter(node => node.type === "button" && node.props.role !== "tab");
    assert.equal(actions.length, page === 0 ? 4 : 3);
    for (const action of actions) {
      assert.equal(action.props.disabled, true);
      assert.equal(action.props.onClick, undefined);
      assert.equal(action.props.formAction, undefined);
    }
  }
  assert.match(view.html, /Золото за жемчуг/);
  assert.match(view.html, /Дом 3 ур\./);
  assert.match(view.html, /\+155%/);
  assert.match(view.html, /25[^\d]?500/);
});

test("shop tabs support arrows, Home and End with one focusable tab and connected panel", () => {
  const h = harness(); let view = h.render();
  for (const [key, expected] of [["End", 1], ["Home", 0], ["ArrowLeft", 1], ["ArrowRight", 0]]) {
    const selected = tabs(view).find(node => node.props["aria-selected"]);
    let prevented = false;
    selected.props.onKeyDown({ key, preventDefault() { prevented = true; } });
    view = h.render();
    assert.equal(prevented, true);
    assert.equal(tabs(view)[expected].props["aria-selected"], true);
    assert.equal(tabs(view).filter(node => node.props.tabIndex === 0).length, 1);
    assert.equal(h.focused.at(-1), expected);
    const panel = view.nodes.find(node => node.props.role === "tabpanel");
    assert.equal(panel.props["aria-labelledby"], tabs(view)[expected].props.id);
    assert.equal(panel.props.id, tabs(view)[expected].props["aria-controls"]);
  }
});

test("a missing economy snapshot never invents a gold quote", () => {
  const h = harness(null); let view = h.render();
  assert.equal(view.nodes.filter(node => node.props["data-shop-offer"]).length, 4);
  tabs(view)[1].props.onClick(); view = h.render();
  assert.match(view.html, /Загружаем полянку/);
  assert.equal(view.nodes.filter(node => node.props["data-shop-offer"]).length, 0);
});
