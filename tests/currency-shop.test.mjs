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
    transform(source, id) { if (id.endsWith("/features/economy/ui/market/currency-shop-panel.tsx")) return source.replace('from "react";', `from "${hookModule}";`); },
  }],
});
after(() => vite.close());
const { economyCatalog } = await vite.ssrLoadModule("/features/economy/domain/model.ts");
const shop = await vite.ssrLoadModule("/features/economy/domain/currency-shop.ts");
const { formatPearls } = await vite.ssrLoadModule("/features/economy/domain/money.ts");
const { CurrencyShopPanel } = await vite.ssrLoadModule("/features/economy/ui/market/currency-shop-panel.tsx");
const hooks = await vite.ssrLoadModule(hookModule);
const state = buildings => ({ catalog: economyCatalog, buildings, jobs: [] });
const firstQuote = buildings => shop.currencyShopGoldOffers(state(buildings))[0];

test("shop quotes use current currency units, ruble pearl packs and no gold volume discount", () => {
  assert.deepEqual(shop.PEARL_SHOP_PACKAGES.map(pack => [pack.pearls, pack.priceRub]), [[200, 99], [700, 299], [1600, 599]]);
  assert.deepEqual(shop.GOLD_SHOP_PACKAGES.map(pack => pack.pearls), [40, 100, 200]);
  for (const pack of [...shop.PEARL_SHOP_PACKAGES, ...shop.GOLD_SHOP_PACKAGES]) assert.equal(pack.pearls % 2, 0);
  const offers = shop.currencyShopGoldOffers(state({ home: 1 }));
  assert.deepEqual(offers.map(pack => [pack.baseCoins, pack.bonusCoins, pack.coins]), [[400, 0, 400], [1000, 0, 1000], [2000, 0, 2000]]);
  assert.deepEqual([1, 2, 3, 4, 5].map(home => firstQuote({ home }).coins), [400, 600, 900, 1200, 1600]);
});

test("completed house and catalog buildings contribute separate additive percentages", () => {
  const middle = state({ home: 3, workshop: 3, warehouse: 3, garden: 2, woodlot: 2 });
  assert.deepEqual(shop.currencyShopDevelopment(middle), { homeLevel: 3, completedLevels: 7, totalLevels: 30,
    homeBonusPercent: 125, buildingBonusPercent: 5, bonusPercent: 130 });
  assert.deepEqual(shop.currencyShopGoldOffers(middle).map(pack => pack.coins), [920, 2300, 4600]);
  assert.equal(firstQuote({ home: 1, garden: 1 }).coins, 400, "one of thirty productive levels stays below one percent");
  const full = state({ home: 5, workshop: 5, warehouse: 10, garden: 5, woodlot: 5, quarry: 5, dryer: 5, kiln: 5, bridge: 1, lighthouse: 1 });
  assert.equal(shop.currencyShopDevelopment(full).completedLevels, 30, "only the six production stations contribute completed levels");
  assert.equal(shop.currencyShopDevelopment(full).bonusPercent, 325);
  assert.deepEqual(shop.currencyShopGoldOffers(full).map(pack => pack.coins), [1700, 4250, 8500]);
});

test("optional warehouse expansions preserve every original gold quote and never add a gold bonus", () => {
  const originalCatalog = structuredClone(economyCatalog);
  originalCatalog.buildings.find(building => building.id === "warehouse").levels =
    originalCatalog.buildings.find(building => building.id === "warehouse").levels.filter(level => level.level <= 5);
  for (const home of [1, 2, 3, 4, 5]) for (const warehouse of [0, 1, 2, 3, 4, 5]) for (const other of [0, 2, 5]) {
    const buildings = Object.fromEntries(economyCatalog.buildings.map(building => [building.id,
      ["bridge", "lighthouse"].includes(building.id) ? Math.min(1, other) : other]));
    Object.assign(buildings, { home, warehouse });
    const original = { catalog: originalCatalog, buildings };
    assert.deepEqual(shop.currencyShopGoldOffers(state(buildings)), shop.currencyShopGoldOffers(original));
    assert.deepEqual(shop.currencyShopDevelopment(state(buildings)), shop.currencyShopDevelopment(original));
  }
  for (const home of [1, 2, 3, 4, 5]) {
    const buildings = { home, warehouse: 5, workshop: 3, kiln: 2, garden: 1 };
    const baseline = shop.currencyShopGoldOffers(state(buildings));
    const baselineDevelopment = shop.currencyShopDevelopment(state(buildings));
    for (const warehouse of [6, 7, 8, 9, 10]) {
      assert.deepEqual(shop.currencyShopGoldOffers(state({ ...buildings, warehouse })), baseline);
      assert.deepEqual(shop.currencyShopDevelopment(state({ ...buildings, warehouse })), baselineDevelopment);
    }
  }
  const baseline = state({ home: 3, garden: 2, workshop: 3 });
  for (const warehouse of [0, 1, 2, 5, 10]) for (const bridge of [0, 1]) for (const lighthouse of [0, 1]) {
    const comfort = state({ ...baseline.buildings, warehouse, bridge, lighthouse });
    assert.deepEqual(shop.currencyShopDevelopment(comfort), shop.currencyShopDevelopment(baseline));
    assert.deepEqual(shop.currencyShopGoldOffers(comfort), shop.currencyShopGoldOffers(baseline));
  }
});

test("development is monotonic, finite and bounded for every current completed level", () => {
  const buildings = { home: 1 };
  let previous = 400;
  for (const building of economyCatalog.buildings) for (const entry of building.levels) {
    buildings[building.id] = entry.level;
    const offers = shop.currencyShopGoldOffers(state(buildings));
    assert.ok(offers[0].coins >= previous);
    for (const quote of offers) {
      assert.ok(Number.isSafeInteger(quote.coins));
      assert.ok(quote.coins <= quote.baseCoins * 4.25);
      assert.equal(quote.coins / quote.pearls, offers[0].coins / offers[0].pearls);
    }
    previous = offers[0].coins;
  }
  assert.equal(previous, 1700);
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
  assert.equal(firstQuote(impossible).coins, 1700, "saved levels cannot exceed the catalog cap");
  for (const invalid of [NaN, Infinity, -1, 2.5]) assert.equal(firstQuote({ home: invalid, garden: invalid }).coins, 400);
});

function harness(snapshot = state({ home: 3, garden: 2 }), initialPage = "pearls") {
  hooks.reset();
  const focused = [];
  const render = () => {
    hooks.render(); const tree = CurrencyShopPanel({ state: snapshot, initialPage }), nodes = [];
    function visit(element) { if (!isValidElement(element)) return; nodes.push(element); Children.forEach(element.props.children, visit); }
    visit(tree);
    nodes.filter(node => node.props.role === "tab").forEach((node, index) => node.props.ref?.({ focus() { focused.push(index); } }));
    return { nodes, html: renderToStaticMarkup(tree) };
  };
  return { render, focused };
}
const tabs = view => view.nodes.filter(node => node.props.role === "tab");

test("wallet entry selects the requested currency page while preserving the preview and keyboard tabs", () => {
  for (const initialPage of ["gold", "pearls"]) {
    const h = harness(state({ home: 3 }), initialPage);
    let view = h.render();
    const selected = tabs(view).find(node => node.props["aria-selected"]);
    assert.equal(selected.props.id.endsWith(`-${initialPage}`), true);
    assert.equal(selected.props.tabIndex, 0);
    assert.equal(view.nodes.filter(node => node.props["data-shop-offer"]).length, 3);
    for (const action of view.nodes.filter(node => node.type === "button" && node.props.role !== "tab")) {
      assert.equal(action.props.disabled, true);
      assert.equal(action.props.onClick, undefined);
    }
    tabs(view).find(node => node.props.id.endsWith(initialPage === "gold" ? "-pearls" : "-gold")).props.onClick(); view = h.render();
    assert.equal(tabs(view).filter(node => node.props["aria-selected"]).length, 1);
    assert.equal(tabs(view).find(node => node.props["aria-selected"]).props.id.endsWith(`-${initialPage}`), false);
  }
});

test("preview tabs show compact distinct currencies and cannot spend or grant either balance", () => {
  const snapshot = state({ home: 3, garden: 2 });
  Object.defineProperty(snapshot, "wallet", { get() { throw new Error("Preview must not consult or modify balances"); } });
  const h = harness(snapshot);
  let view = h.render();
  assert.match(view.html, /Покупки и обмен пока недоступны/);
  assert.equal(view.nodes.filter(node => node.props["data-shop-offer"]).length, 3);
  assert.match(view.html, /99 ₽/);
  for (const page of ["pearls", "gold"]) {
    tabs(view).find(node => node.props.id.endsWith(`-${page}`)).props.onClick(); view = h.render();
    const actions = view.nodes.filter(node => node.type === "button" && node.props.role !== "tab");
    assert.equal(actions.length, 3);
    for (const action of actions) {
      assert.equal(action.props.disabled, true);
      assert.equal(action.props.onClick, undefined);
      assert.equal(action.props.formAction, undefined);
    }
  }
  assert.match(view.html, /Золото за жемчуг/);
  assert.match(view.html, /Дом 3 ур\./);
  assert.match(view.html, /\+126%/);
  assert.match(view.html, /904/);
});

test("shop tabs support arrows, Home and End with one focusable tab and connected panel", () => {
  const h = harness(); let view = h.render();
  for (const [key, expected] of [["End", 3], ["Home", 0], ["ArrowLeft", 3], ["ArrowRight", 0]]) {
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
  assert.equal(view.nodes.filter(node => node.props["data-shop-offer"]).length, 3);
  tabs(view).find(node => node.props.id.endsWith("-gold")).props.onClick(); view = h.render();
  assert.match(view.html, /Загружаем полянку/);
  assert.equal(view.nodes.filter(node => node.props["data-shop-offer"]).length, 0);
});


test("recalculated package prices display stored units as whole visible pearls", () => {
  const h = harness(state({ home: 1 })); let view = h.render();
  const amounts = () => [...view.html.matchAll(/<strong[^>]*>[\s\S]*?<\/strong>/g)].map(match => match[0].replace(/<[^>]*>/g, "").replace(/\s/g, ""));
  assert.deepEqual(amounts().slice(-3), ["100", "350", "800"]);
  assert.deepEqual(amounts().slice(0, -3), ["150", "100", "20"]);
  for (const price of [99, 299, 599]) assert.ok(view.html.includes(`${price} ₽`));
  tabs(view).find(node => node.props.id.endsWith("-gold")).props.onClick(); view = h.render();
  assert.match(view.html, /<span>20<\/span>/);
  assert.match(view.html, /<span>50<\/span>/);
  assert.match(view.html, /<span>100<\/span>/);
  assert.deepEqual(shop.currencyShopGoldOffers(state({ home: 1 })).map(pack => [pack.pearls, pack.coins]), [[40, 400], [100, 1000], [200, 2000]]);
  assert.deepEqual(amounts().slice(1), ["400", "1000", "2000"]);
});


test("pearl spending examples use actual catalog prices and retain the visible/raw distinction", () => {
  const examples = shop.currencyShopPearlBenchmarks(economyCatalog);
  assert.equal(examples.find(item => item.id === "relic").pearls, 300);
  assert.equal(examples.find(item => item.id === "slot").pearls, 200);
  assert.equal(examples.find(item => item.id === "construction").pearls, 40);
  assert.equal(formatPearls(examples.find(item => item.id === "relic").pearls), "150");
  const changed = structuredClone(economyCatalog);
  changed.leaftailShop.pearlOffers[0].pricePearls = 400;
  assert.equal(shop.currencyShopPearlBenchmarks(changed).find(item => item.id === "relic").pearls, 400);
  delete changed.leaftailShop.pearlOffers;
  assert.equal(shop.currencyShopPearlBenchmarks(changed).some(item => item.id === "relic"), false);
});
