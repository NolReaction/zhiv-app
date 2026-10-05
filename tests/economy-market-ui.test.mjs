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
    transform(source, id) { if (id.endsWith("/features/economy/economy-panel.tsx")) return source.replace('from "react";', `from "${hookModule}";`).replace("function OfferCard(", "export function OfferCard(").replace("function Market(", "export function Market("); },
  }],
});
after(() => vite.close());
const { OfferCard, Market } = await vite.ssrLoadModule("/features/economy/economy-panel.tsx");
const { economyCatalog } = await vite.ssrLoadModule("/features/economy/model.ts");
const hooks = await vite.ssrLoadModule(hookModule);
const now = Date.parse("2026-10-05T14:00:00Z");
function economy() {
  return { snapshot: { ownerPublicId: "ME", wallet: { coins: 1000, pearls: 0 }, inventory: { wood: 20 }, buildings: { home: 5, warehouse: 5 }, completedExplorations: 1,
    catalog: structuredClone(economyCatalog), storage: { capacity: 3000, used: 20, reserved: 12, available: 2968, overflow: 0 } },
    market: { listings: [offer("a"), offer("b")], mine: [offer("mine-a"), offer("mine-b")], showcase: { refreshAt: new Date(now + 1000).toISOString(), slots: 12, maxPerSeller: 2, refreshSeconds: 1800 } },
    busy: false, uncertain: false, now, retryAt: 0, refreshMarket() {}, actMarket() { assert.fail("navigation must not trade"); },
  };
}
function offer(id) { return { id, sellerName: "Сосед <лес>", itemId: "wood", quantity: 6, totalPrice: 42 }; }
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
  assert.match(view.html, /Древесина × 6/); assert.match(view.html, /Сосед &lt;лес&gt;/);
  assert.match(view.html, /42<span[^>]+> монет<\/span>/); assert.match(view.html, /за весь лот/); assert.match(view.html, /7 за шт\./);
  const button = view.nodes.find(node => node.type === "button");
  assert.equal(button.props["aria-label"], "Купить весь лот: Древесина × 6 за 42 монет");
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
    assert.deepEqual(calls, owned ? [["cancel_listing", "a"]] : [["buy_listing", "a", 6, 42]]);
  }
});

test("a stale quote or uncertain command cannot be spent from an already-open compact confirmation", () => {
  for (const invalid of [e => { e.uncertain = true; }, e => { e.now += 1000; }, e => { e.snapshot.wallet.coins = 41; }]) {
    const e = economy(), calls = []; e.actMarket = (...args) => calls.push(args);
    const h = harness(OfferCard, { economy: e, offer: offer("a"), navigate() {} });
    h.render().nodes.find(node => node.type === "button").props.onClick(); invalid(e);
    const confirm = h.render().nodes.find(node => node.type === "button" && node.props["aria-label"]?.startsWith("Подтвердить покупку"));
    assert.equal(confirm.props.disabled, true); confirm.props.onClick(); assert.deepEqual(calls, []);
  }
});
