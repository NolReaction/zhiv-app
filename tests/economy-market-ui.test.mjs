import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { Children, isValidElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const hookModule = "virtual:market-ui-hooks";
const vite = await createServer({ appType: "custom", configFile: false, root, resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false },
  plugins: [{ name: "market-ui-handlers", enforce: "pre",
    resolveId(id) { if (id === hookModule) return `\0${id}`; },
    load(id) { if (id === `\0${hookModule}`) return `
      let slots = [], cursor = 0, effects = [];
      export function reset() { slots = []; cursor = 0; effects = []; }
      export function render() { cursor = 0; effects = []; }
      export function flush() { effects.forEach(callback => callback()); }
      export function useState(initial) { const index = cursor++; if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial; return [slots[index], value => { slots[index] = typeof value === 'function' ? value(slots[index]) : value; }]; }
      export function useRef(initial) { const index = cursor++; if (!(index in slots)) slots[index] = { current: initial }; return slots[index]; }
      export function useEffect(callback) { effects.push(callback); }
      export function useId() { return 'market-' + cursor++; }
    `; },
    transform(source, id) { if (id.endsWith("/features/economy/ui/economy-panel.tsx")) return source.replace('from "react";', `from "${hookModule}";`).replace("function OfferCard(", "export function OfferCard(").replace("function Market(", "export function Market(").replace("function ListingForm(", "export function ListingForm(").replace("function ListingPriceForm(", "export function ListingPriceForm("); },
  }],
});
after(() => vite.close());
const { OfferCard, Market, ListingForm, ListingPriceForm } = await vite.ssrLoadModule("/features/economy/ui/economy-panel.tsx");
const { economyCatalog, economyFishingSchema } = await vite.ssrLoadModule("/features/economy/domain/model.ts");
const { marketMinimumPrice } = await vite.ssrLoadModule("/features/economy/domain/market-rules.ts");
const { fishDiscovered } = await vite.ssrLoadModule("/features/economy/ui/fishing/fish-discovery.tsx");
const hooks = await vite.ssrLoadModule(hookModule);
const now = Date.parse("2026-10-05T14:00:00Z");
function economy() {
  return { snapshot: { ownerPublicId: "ME", revision: 1, wallet: { coins: 10000, pearls: 0 }, inventory: { wood: 20 }, unlockedItems: ["wood"], buildings: { home: 5, warehouse: 5, bridge: 1 }, completedExplorations: 1,
    catalog: structuredClone(economyCatalog), storage: { capacity: 3000, used: 20, reserved: 12, available: 2968, overflow: 0 } },
    market: { listings: [offer("a"), offer("b")], mine: [offer("mine-a"), offer("mine-b")], showcase: { refreshAt: new Date(now + 1000).toISOString(), slots: 12, maxPerSeller: 2, refreshSeconds: 1800 } },
    busy: false, uncertain: false, now, retryAt: 0, refreshMarket() {}, actMarket() { assert.fail("navigation must not trade"); },
  };
}
function offer(id) { return { id, sellerName: "Сосед <лес>", itemId: "wood", quantity: 6, totalPrice: 300 }; }
function elements(tree) {
  const result = [];
  function visit(element) { if (!isValidElement(element)) return; result.push(element); Children.forEach(element.props.children, visit); }
  visit(tree); return result;
}
function harness(component, props) {
  hooks.reset(); const focused = [];
  const render = () => { hooks.render(); const tree = component(props), nodes = elements(tree); for (const node of nodes) if (node.props.ref) node.props.ref.current = { focus() { focused.push(node.props.role === "group" ? "confirmation" : "trigger"); } }; hooks.flush(); return { tree, nodes, html: renderToStaticMarkup(tree) }; };
  return { render, focused };
}

test("buy and own offers share the compact merchandise list without a second market heading", () => {
  const props = { economy: economy(), navigate() {} }, h = harness(Market, props);
  let view = h.render();
  assert.equal(view.nodes.some(node => node.type === "h2"), false);
  let list = view.nodes.find(node => node.props["aria-label"] === "Предложения игроков");
  assert.equal(list.props.role, "list"); assert.equal(list.props.children.length, 2);
  const browseGrid = list.props.className;
  view.nodes.find(node => node.type === "button" && renderToStaticMarkup(node).includes("Мои лоты")).props.onClick();
  view = h.render(); list = view.nodes.find(node => node.props["aria-label"] === "Ваши предложения");
  assert.equal(list.props.className, browseGrid); assert.equal(list.props.children.length, 2);
  assert.ok(list.props.children.every(node => node.props.owned));
});

test("compact offer preserves visible quantity, seller and distinct total and unit prices", () => {
  const h = harness(OfferCard, { economy: economy(), offer: offer("a"), navigate() {} });
  const view = h.render();
  assert.match(view.html, /Бревно × 6/); assert.match(view.html, /Сосед &lt;лес&gt;/);
  assert.match(view.html, /300<span[^>]+> монет<\/span>/); assert.match(view.html, /за весь лот/); assert.match(view.html, /50 за шт\./);
  const button = view.nodes.find(node => node.type === "button");
  assert.equal(button.props["aria-label"], "Купить весь лот: Бревно × 6 за 300 монет");
});

test("market fish previews show exact goods even before discovery or while all stock is in escrow", () => {
  for (const owned of [false, true]) {
    const e = economy(); e.snapshot.inventory = {}; e.snapshot.fishing = economyFishingSchema.parse({ catches: {} });
    e.snapshot.storage = { capacity: 3000, used: 0, reserved: owned ? 1 : 0, available: owned ? 2999 : 3000, overflow: 0 };
    const item = e.snapshot.catalog.items.find(entry => entry.id === "fish_shark");
    e.snapshot.unlockedItems.push("fish_legendary");
    const lot = { ...offer("shark"), itemId: item.id, quantity: 1, totalPrice: item.baseSellPrice, owned };
    const before = structuredClone(e.snapshot);
    const view = harness(OfferCard, { economy: e, offer: lot, owned, navigate() {} }).render();
    assert.match(view.html, /Теневая акула × 1/);
    assert.match(view.html, /data-item-icon="fish_shark"/);
    assert.doesNotMatch(view.html, /data-hidden-fish/);
    assert.equal(view.nodes.find(node => node.type === "button").props.disabled, false);
    assert.equal(fishDiscovered(e.snapshot, item.id), false);
    assert.deepEqual(e.snapshot, before, "viewing a market lot never invents inventory or personal catches");
  }
});

test("buy and return still require confirmation, preserve exact commands and restore keyboard focus on Back", () => {
  for (const owned of [false, true]) {
    const e = economy(), calls = []; e.actMarket = (...args) => calls.push(args);
    const h = harness(OfferCard, { economy: e, offer: offer("a"), owned, navigate() {} });
    let view = h.render(); view.nodes.find(node => node.type === "button").props.onClick();
    assert.deepEqual(calls, []); view = h.render();
    assert.deepEqual(h.focused, ["confirmation"]);
    assert.ok(view.nodes.some(node => node.props.role === "group" && node.props.tabIndex === -1));
    view.nodes.find(node => node.type === "button" && node.props.children === "Назад").props.onClick();
    view = h.render(); assert.deepEqual(h.focused, ["confirmation", "trigger"]); assert.deepEqual(calls, []);
    view.nodes.find(node => node.type === "button").props.onClick(); view = h.render();
    view.nodes.find(node => node.type === "button" && node.props["aria-label"]?.startsWith(owned ? "Снять с продажи" : "Подтвердить покупку")).props.onClick();
    assert.deepEqual(calls, owned ? [["cancel_listing", "a"]] : [["buy_listing", "a", 6, 300]]);
  }
});

test("a stale quote or uncertain command cannot be spent from an already-open compact confirmation", () => {
  for (const invalid of [e => { e.uncertain = true; }, e => { e.now += 1000; }, e => { e.snapshot.wallet.coins = 290; }]) {
    const e = economy(), calls = []; e.actMarket = (...args) => calls.push(args);
    const h = harness(OfferCard, { economy: e, offer: offer("a"), navigate() {} });
    h.render().nodes.find(node => node.type === "button").props.onClick(); invalid(e);
    const confirm = h.render().nodes.find(node => node.type === "button" && node.props["aria-label"]?.startsWith("Подтвердить покупку"));
    assert.equal(confirm.props.disabled, true); confirm.props.onClick(); assert.deepEqual(calls, []);
  }
});

test("listing prices use the catalog currency quantum and cannot submit an intermediate unit", () => {
  const e = economy(), calls = [];
  e.actMarket = (...args) => calls.push(args);
  const item = e.snapshot.catalog.items.find(entry => entry.id === "wood");
  const h = harness(ListingPriceForm, { economy: e, item });
  let view = h.render();
  let inputs = view.nodes.filter(node => node.type === "input");
  assert.equal(inputs[0].props.step, 1, "item quantities keep their unit");
  assert.equal(inputs[1].props.step, e.snapshot.catalog.currencyScale);
  const acceptedPrice = item.baseSellPrice * 2;
  inputs[1].props.onChange({ target: { value: String(acceptedPrice + 1) } });
  view = h.render();
  let submit = view.nodes.find(node => node.type === "button");
  assert.equal(submit.props.disabled, true);
  submit.props.onClick(); assert.deepEqual(calls, []);
  inputs = view.nodes.filter(node => node.type === "input");
  inputs[1].props.onChange({ target: { value: String(acceptedPrice) } });
  view = h.render(); submit = view.nodes.find(node => node.type === "button");
  assert.equal(submit.props.disabled, false);
  submit.props.onClick();
  assert.deepEqual(calls, [["create_listing", "wood", 1, acceptedPrice]]);
});

test("current NPC prices align the native market input with the allowed currency quantum for the whole lot", () => {
  for (const quantity of [1, 2, 3]) {
    const e = economy(), calls = [];
    e.snapshot.inventory.grilled_fish = 3;
    e.snapshot.unlockedItems.push("grilled_fish");
    e.snapshot.catalog.market.maxPriceMultiplier = 3;
    e.actMarket = (...args) => calls.push(args);
    const item = e.snapshot.catalog.items.find(entry => entry.id === "grilled_fish");
    const floor = marketMinimumPrice(item.id, quantity, e.snapshot.catalog);
    assert.equal(floor, item.baseSellPrice * quantity, "the economic floor keeps its exact NPC price");
    const h = harness(ListingPriceForm, { economy: e, item });
    let view = h.render();
    view.nodes.find(node => node.type === "input").props.onChange({ target: { value: String(quantity) } });
    view = h.render();
    let input = view.nodes.filter(node => node.type === "input")[1];
    const quantum = e.snapshot.catalog.currencyScale;
    const minimum = Math.ceil(floor / quantum) * quantum, maximum = Math.floor(item.baseSellPrice * quantity * 3 / quantum) * quantum;
    assert.equal(input.props.min, minimum);
    assert.equal(input.props.max, maximum);
    assert.equal(input.props.step, quantum);
    assert.equal((minimum - input.props.min) % input.props.step, 0, "the browser accepts the valid minimum");
    assert.equal((maximum - input.props.min) % input.props.step, 0, "the browser accepts the valid maximum");
    assert.match(view.html, new RegExp(`Допустимая цена: ${minimum}–${maximum} монет`));
    input.props.onChange({ target: { value: String(minimum - 1) } });
    view = h.render();
    const invalid = view.nodes.find(node => node.type === "button");
    assert.equal(invalid.props.disabled, true);
    invalid.props.onClick(); assert.deepEqual(calls, []);
    input = view.nodes.filter(node => node.type === "input")[1];
    input.props.onChange({ target: { value: String(minimum) } });
    view = h.render();
    const submit = view.nodes.find(node => node.type === "button");
    assert.equal(submit.props.disabled, false);
    submit.props.onClick();
    assert.deepEqual(calls, [["create_listing", "grilled_fish", quantity, minimum]]);
  }
});

test("a permanently opened bait stays listable after its source becomes unavailable, while new gift stock stays locked", () => {
  const e = economy(), calls = [];
  e.snapshot.inventory.firefly_bait = 2;
  e.snapshot.unlockedItems.push("firefly_bait");
  e.actMarket = (...args) => calls.push(args);
  const item = e.snapshot.catalog.items.find(entry => entry.id === "firefly_bait");
  assert.ok(item);
  const h = harness(ListingPriceForm, { economy: e, item });
  assert.equal(h.render().nodes.find(node => node.type === "button").props.disabled, false);
  e.snapshot.buildings.home = 2;
  assert.equal(h.render().nodes.find(node => node.type === "button").props.disabled, false);
  e.snapshot.unlockedItems = ["wood"];
  const submit = h.render().nodes.find(node => node.type === "button");
  assert.equal(submit.props.disabled, true); submit.props.onClick(); assert.deepEqual(calls, []);
});

test("browse and seller selections use permanent known items rather than high home level or gifted stock", () => {
  const e = economy();
  const tools = e.snapshot.catalog.items.find(item => item.id === "tools");
  e.snapshot.inventory.tools = 2;
  e.market.listings.push({ ...offer("unknown-tools"), itemId: tools.id, quantity: 1, totalPrice: tools.baseSellPrice });
  const before = structuredClone(e.snapshot), market = harness(Market, { economy: e, navigate() {} });
  let list = market.render().nodes.find(node => node.props["aria-label"] === "Предложения игроков");
  assert.deepEqual(list.props.children.map(card => card.props.offer.id), ["a", "b"]);
  assert.equal(harness(OfferCard, { economy: e, offer: e.market.listings.at(-1), navigate() {} }).render().nodes.find(node => node.type === "button").props.disabled, true);
  let form = harness(ListingForm, { economy: e }).render();
  assert.deepEqual(form.nodes.filter(node => node.type === "option").map(node => node.props.value), ["wood"]);
  assert.deepEqual(e.snapshot, before, "displaying unknown gifted goods cannot create permanent access");
  e.snapshot.unlockedItems.push("tools");
  list = harness(Market, { economy: e, navigate() {} }).render().nodes.find(node => node.props["aria-label"] === "Предложения игроков");
  assert.deepEqual(list.props.children.map(card => card.props.offer.id), ["a", "b", "unknown-tools"]);
  form = harness(ListingForm, { economy: e }).render();
  assert.ok(form.nodes.filter(node => node.type === "option").some(node => node.props.value === "tools"));
  e.snapshot.buildings.home = 2;
  assert.equal(harness(ListingPriceForm, { economy: e, item: tools }).render().nodes.find(node => node.type === "button").props.disabled, false);
});

test("all ten legacy own offers remain visible and cancellable even above the five free slots", () => {
  const e = economy();
  e.market.mine = Array.from({ length: 10 }, (_, index) => ({ ...offer(`legacy-${index + 1}`), itemId: index < 5 ? "wood" : "tools" }));
  const h = harness(Market, { economy: e, navigate() {} });
  h.render().nodes.find(node => node.props["data-guide-market-tab"] === "mine").props.onClick();
  const list = h.render().nodes.find(node => node.props["aria-label"] === "Ваши предложения");
  assert.equal(list.props.children.length, 10);
  for (const card of list.props.children) {
    assert.equal(card.props.owned, true);
    assert.equal(harness(OfferCard, card.props).render().nodes.find(node => node.type === "button").props.disabled, false);
  }
});

test("daily buyer budget invalidates an open confirmation without blocking owned cancellation", () => {
  const e = economy(), calls = []; e.actMarket = (...args) => calls.push(args);
  e.market.tradeBudget = { buysUsed: 0, salesUsed: 0, limit: 2400, resetsAt: new Date(now + 86400000).toISOString(), feeBps: 500, homeBandMin: 2, homeBandMax: 3 };
  const h = harness(OfferCard, { economy: e, offer: offer("a"), navigate() {} });
  h.render().nodes.find(node => node.type === "button").props.onClick();
  e.market.tradeBudget.buysUsed = 2380;
  const accept = h.render().nodes.find(node => node.type === "button" && node.props["aria-label"]?.startsWith("Подтвердить покупку"));
  assert.equal(accept.props.disabled, true); accept.props.onClick(); assert.deepEqual(calls, []);
  const cancel = harness(OfferCard, { economy: e, offer: offer("a"), owned: true, navigate() {} });
  assert.equal(cancel.render().nodes.find(node => node.type === "button").props.disabled, false);
});

test("seller sees the net fee and a quantity which fits the full daily limit", () => {
  const e = economy(); e.snapshot.buildings.home = 2; e.snapshot.inventory.wood = 100;
  const item = e.snapshot.catalog.items.find(entry => entry.id === "wood");
  const view = harness(ListingPriceForm, { economy: e, item }).render();
  assert.equal(view.nodes.find(node => node.type === "input").props.max,
    Math.min(e.snapshot.catalog.market.maxLotQuantity, 100, Math.floor(e.snapshot.catalog.market.dailyTradeValueByHome[1] / item.baseSellPrice)));
  const totalPrice = item.baseSellPrice * 2, received = totalPrice - Math.ceil(totalPrice * e.snapshot.catalog.market.feeBps / 10000);
  assert.match(view.html, new RegExp(`Получите ${received} монет после сбора ${e.snapshot.catalog.market.feeBps / 100}%`));
  const old = harness(OfferCard, { economy: e, offer: { ...offer("legacy"), feeBps: 0 }, owned: true, navigate() {} }).render();
  assert.match(old.html, /После продажи: 300 монет/); assert.match(old.html, /без сбора/);
});

test("limits and reset countdown are available in collapsed market rules", () => {
  const e = economy(); e.market.tradeBudget = { buysUsed: 900, salesUsed: 1200, limit: 2400, resetsAt: new Date(now + 3600000).toISOString(), feeBps: 500, homeBandMin: 2, homeBandMax: 3 };
  const view = harness(Market, { economy: e, navigate() {} }).render();
  const rules = view.nodes.find(node => node.type === "details" && renderToStaticMarkup(node).includes("Правила торговли"));
  assert.equal(rules.props.open, undefined);
  assert.match(renderToStaticMarkup(rules), /домами 2–3 и 4–5/);
  assert.match(renderToStaticMarkup(rules), /Покупки: 900/);
  assert.match(renderToStaticMarkup(rules), /Обновление через 1 ч/);
});

test("a restored bridge opens trade at home two without an exploration and closed bridges preserve own returns", () => {
  const e = economy(), destinations = [], calls = [];
  e.snapshot.buildings.home = 2;
  e.snapshot.completedExplorations = 0;
  e.actMarket = (...args) => calls.push(args);
  let view = harness(Market, { economy: e, navigate: (...args) => destinations.push(args) }).render();
  assert.ok(view.nodes.some(node => node.props["aria-label"] === "Предложения игроков"));
  e.snapshot.buildings.bridge = 0;
  const h = harness(Market, { economy: e, navigate: (...args) => destinations.push(args) });
  view = h.render();
  assert.match(view.html, /Восстановите мост/);
  assert.doesNotMatch(view.html, /data-market-offer=|Завершённые вылазки/);
  view.nodes.find(node => node.type === "button" && renderToStaticMarkup(node).includes("Продолжить обустройство")).props.onClick();
  assert.deepEqual(destinations, [["buildings", "bridge"]]);
  view.nodes.find(node => node.props["data-guide-market-tab"] === "mine").props.onClick();
  const own = h.render().nodes.find(node => node.props["aria-label"] === "Ваши предложения");
  assert.equal(own.props.children.length, 2);
  const card = harness(OfferCard, own.props.children[0].props);
  card.render().nodes.find(node => node.type === "button").props.onClick();
  card.render().nodes.find(node => node.props["aria-label"]?.startsWith("Снять с продажи")).props.onClick();
  assert.deepEqual(calls, [["cancel_listing", "mine-a"]]);
  const foreign = harness(OfferCard, { economy: e, offer: offer("a"), navigate() {} }).render();
  assert.equal(foreign.nodes.find(node => node.type === "button").props.disabled, true);
});
