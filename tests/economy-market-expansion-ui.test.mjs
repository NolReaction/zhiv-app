import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { Children, isValidElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url)), hooksId = "virtual:market-expansion-hooks";
const vite = await createServer({ appType: "custom", configFile: false, root,
  resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false },
  plugins: [{ name: "market-expansion-hooks", enforce: "pre",
    resolveId(id) { if (id === hooksId) return `\0${id}`; },
    load(id) { if (id === `\0${hooksId}`) return `
      let slots = [], cursor = 0, layouts = [], effects = [];
      export function reset() { slots = []; cursor = 0; layouts = []; effects = []; }
      export function render() { cursor = 0; layouts = []; effects = []; }
      export function flush() { layouts.forEach(effect => effect()); effects.forEach(effect => effect()); }
      export function useRef(initial) { const i = cursor++; return slots[i] ??= { current: initial }; }
      export function useState(initial) { const ref = useRef(typeof initial === 'function' ? initial() : initial); return [ref.current, value => { ref.current = typeof value === 'function' ? value(ref.current) : value; }]; }
      export function useId() { const i = cursor++; return 'market-expansion-' + i; }
      function enqueue(effect, dependencies, queue) { const i = cursor++, prior = slots[i]; if (!prior || dependencies.some((value, index) => !Object.is(value, prior[index]))) { slots[i] = dependencies; queue.push(effect); } }
      export function useLayoutEffect(effect, dependencies) { enqueue(effect, dependencies, layouts); }
      export function useEffect(effect, dependencies) { enqueue(effect, dependencies, effects); }
    `; },
    transform(source, id) {
      if (id.endsWith("/features/economy/ui/market/world-market-slots.tsx"))
        return source.replace('from "react";', `from "${hooksId}";`);
    },
  }],
});
after(() => vite.close());
const { WorldMarketSlots, marketSlotQuoteReason } = await vite.ssrLoadModule("/features/economy/ui/market/world-market-slots.tsx");
const { economyCatalog } = await vite.ssrLoadModule("/features/economy/domain/model.ts");
const { marketSlotOffer } = await vite.ssrLoadModule("/features/economy/domain/market-rules.ts");
const hooks = await vite.ssrLoadModule(hooksId);
function controller() {
  return { snapshot: { ownerPublicId: "ME", revision: 4, marketSlots: 5,
    wallet: { coins: 1000, pearls: 2000 }, buildings: { home: 2, bridge: 1 }, completedExplorations: 1,
    catalog: structuredClone(economyCatalog) }, busy: false, uncertain: false, error: null,
    act() { assert.fail("inspection cannot purchase a place"); } };
}
function elements(tree) {
  const result = [];
  const visit = element => { if (isValidElement(element)) { result.push(element); Children.forEach(element.props.children, visit); } };
  visit(tree); return result;
}
function harness(economy, used = 0) {
  hooks.reset(); const focused = [];
  return { focused, render() {
    hooks.render(); const tree = WorldMarketSlots({ economy, used }), nodes = elements(tree);
    for (const node of nodes) if (node.props.ref) node.props.ref.current = { focus() { focused.push(node.type); } };
    hooks.flush(); return { tree, nodes, html: renderToStaticMarkup(tree) };
  } };
}
const button = (view, prefix) => view.nodes.find(node => node.type === "button" && node.props["aria-label"]?.startsWith(prefix));

test("five permanent market places are free and old extra listings remain visible while the next quote is sequential", () => {
  const economy = controller(), before = structuredClone(economy.snapshot);
  const view = harness(economy, 9).render();
  assert.match(view.html, /data-market-slots="5"/);
  assert.match(view.html, /Ваша лавка · 9 \/ 5/);
  assert.match(view.html, /5 мест бесплатно/); assert.match(view.html, /максимум 10/);
  assert.match(view.html, /Прежние лоты сохранены/);
  assert.equal(button(view, "Открыть место рынка").props["aria-label"], "Открыть место рынка 6 за 50 жемчужин");
  assert.deepEqual(economy.snapshot, before);
  for (const [slots, next, price] of [[6, 7, 80], [7, 8, 120], [8, 9, 180], [9, 10, 250]]) {
    economy.snapshot.marketSlots = slots;
    const current = harness(economy, slots).render();
    assert.equal(button(current, "Открыть место рынка").props["aria-label"], `Открыть место рынка ${next} за ${price} жемчужин`);
  }
  economy.snapshot.marketSlots = 10;
  assert.equal(button(harness(economy, 10).render(), "Открыть место рынка"), undefined);
});

test("opening a market-place quote requires deliberate confirmation, uses stored price and rejects a duplicate press", () => {
  const economy = controller(), calls = [], h = harness(economy);
  economy.act = (...args) => calls.push(args);
  button(h.render(), "Открыть место рынка").props.onClick(); assert.deepEqual(calls, []);
  let view = h.render();
  assert.match(view.html, /Жемчужины: 1\s?000 → 950/);
  assert.deepEqual(h.focused, ["h3"]);
  const confirm = button(view, "Подтвердить открытие места");
  assert.equal(confirm.props.disabled, false); confirm.props.onClick(); confirm.props.onClick();
  assert.deepEqual(calls, [["buy_market_slot", "market:6", 1, 100]]);
  view = h.render(); button(view, "Подтвердить открытие места").props.onClick();
  assert.equal(calls.length, 1, "a render without a new accepted revision does not duplicate the purchase");
  view.nodes.find(node => node.type === "button" && node.props.children === "Оставить как есть").props.onClick();
  h.render(); assert.deepEqual(h.focused, ["h3", "button"]);
});

test("captured expansion callbacks recheck owner, revision, next place, price, wallet and market requirements", () => {
  for (const invalidate of [
    economy => { economy.snapshot.ownerPublicId = "OTHER"; },
    economy => { economy.snapshot.revision++; },
    economy => { economy.snapshot.marketSlots = 6; },
    economy => { economy.snapshot.catalog.market.slotPricesPearls[0] += 2; },
    economy => { economy.snapshot.wallet.pearls = 98; },
    economy => { economy.snapshot.buildings.home = 1; },
    economy => { economy.snapshot.buildings.bridge = 0; },
    economy => { economy.busy = true; },
    economy => { economy.uncertain = true; },
  ]) {
    const economy = controller(), calls = [], h = harness(economy); economy.act = (...args) => calls.push(args);
    button(h.render(), "Открыть место рынка").props.onClick();
    const oldCallback = button(h.render(), "Подтвердить открытие места").props.onClick;
    invalidate(economy);
    const latest = button(h.render(), "Подтвердить открытие места");
    assert.equal(latest.props.disabled, true); oldCallback(); latest.props.onClick(); assert.deepEqual(calls, []);
  }
});

test("quote reasons distinguish stale data and price from insufficient pearls without mutating accepted state", () => {
  const economy = controller(), next = marketSlotOffer(economy.snapshot, economy.snapshot.catalog);
  const quote = { owner: "ME", revision: 4, slots: next.slots, price: next.pricePearls };
  const before = structuredClone(economy.snapshot);
  assert.equal(marketSlotQuoteReason(economy, quote), null);
  assert.match(marketSlotQuoteReason(economy, { ...quote, revision: 3 }), /Данные обновились/);
  assert.match(marketSlotQuoteReason(economy, { ...quote, price: quote.price - 2 }), /Цена изменилась/);
  assert.deepEqual(economy.snapshot, before);
  economy.snapshot.wallet.pearls = quote.price - 2;
  assert.match(marketSlotQuoteReason(economy, quote), /Не хватает жемчужин: 1/);
  assert.equal(button(harness(economy).render(), "Открыть место рынка").props.disabled, true);
});
