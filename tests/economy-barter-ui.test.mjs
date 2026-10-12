import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { Children, isValidElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url)), hookModule = "virtual:barter-ui-hooks";
const vite = await createServer({ appType: "custom", configFile: false, root, resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false }, plugins: [{ name: "barter-ui-handlers", enforce: "pre",
  resolveId(id) { if (id === hookModule) return `\0${id}`; },
  load(id) { if (id === `\0${hookModule}`) return `
    let slots = [], cursor = 0, effects = [];
    export function reset() { slots = []; cursor = 0; effects = []; }
    export function render() { cursor = 0; effects = []; }
    export function flush() { effects.forEach(callback => callback()); }
    export function useState(initial) { const index = cursor++; if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial; return [slots[index], value => { slots[index] = typeof value === 'function' ? value(slots[index]) : value; }]; }
    export function useRef(initial) { const index = cursor++; if (!(index in slots)) slots[index] = { current: initial }; return slots[index]; }
    export function useEffect(callback) { effects.push(callback); }
    export function useId() { return 'barter-' + cursor++; }
  `; },
  transform(source, id) { if (id.endsWith("/features/economy/ui/market/barter-market.tsx")) return source.replace('from "react";', `from "${hookModule}";`); },
}] });
after(() => vite.close());
const { BarterOfferCard, BarterCreateForm, BarterMarket } = await vite.ssrLoadModule("/features/economy/ui/market/barter-market.tsx");
const { economyCatalog } = await vite.ssrLoadModule("/features/economy/domain/model.ts");
const hooks = await vite.ssrLoadModule(hookModule);
const now = Date.parse("2026-10-05T16:00:00Z"), owner = "AAAA-0000-0001", other = "AAAA-0000-0002";
function offer(owned = false) { return { id: "00000000-0000-4000-8000-000000000001", sellerPublicId: owned ? owner : other, sellerName: "Сосед <лес>", offeredItemId: "ancient_core", requestedItemId: "moon_crystal", owned,
  status: "active", createdAt: new Date(now - 10_000).toISOString(), closedAt: null }; }
function economy(owned = false) {
  return { snapshot: { ownerPublicId: owner, revision: 1, wallet: { coins: 99, pearls: 0 }, inventory: { moon_crystal: 1, ancient_core: 1, living_resin: 0 }, buildings: { home: 3 }, catalog: structuredClone(economyCatalog), storage: { available: 0 } },
    barter: { ownerPublicId: owner, offers: owned ? [] : [offer()], mine: owned ? [offer(true)] : [], showcase: { refreshAt: new Date(now + 1800_000).toISOString(), slots: 6, maxPerSeller: 1, refreshSeconds: 1800 } },
    now, busy: false, uncertain: false, retryAt: 0, notice: "", error: null, barterError: null, refreshBarter() {}, actBarter() { assert.fail("navigation cannot exchange items"); } };
}
function elements(tree) { const nodes = []; function visit(element) { if (!isValidElement(element)) return; nodes.push(element); Children.forEach(element.props.children, visit); } visit(tree); return nodes; }
function harness(component, props) {
  hooks.reset(); const focused = [];
  const render = () => { hooks.render(); const tree = component(props), nodes = elements(tree); for (const node of nodes) if (node.props.ref) node.props.ref.current = { focus() { focused.push(node.props.role === "group" ? "confirmation" : "trigger"); } }; hooks.flush(); return { tree, nodes, html: renderToStaticMarkup(tree) }; };
  return { render, focused };
}
const button = (view, text) => view.nodes.find(node => node.type === "button" && renderToStaticMarkup(node).includes(text));

test("exchange and cancel require confirmation, quote only one item each and preserve keyboard focus", () => {
  for (const owned of [false, true]) {
    const e = economy(owned), commands = []; e.actBarter = command => commands.push(command);
    const h = harness(BarterOfferCard, { economy: e, offer: offer(owned), owned });
    let view = h.render();
    assert.match(view.html, /Отдаёте 1/); assert.match(view.html, /Получаете 1/); assert.doesNotMatch(view.html, /монет|жемчуг|quantity|price/);
    button(view, owned ? "Вернуть материал" : "Обменять").props.onClick(); view = h.render();
    assert.deepEqual(commands, []); assert.deepEqual(h.focused, ["confirmation"]);
    button(view, "Назад").props.onClick(); view = h.render(); assert.deepEqual(h.focused, ["confirmation", "trigger"]);
    button(view, owned ? "Вернуть материал" : "Обменять").props.onClick(); view = h.render();
    button(view, owned ? "Подтвердить возврат" : "Подтвердить обмен").props.onClick();
    assert.deepEqual(commands, [{ action: owned ? "cancel_offer" : "accept_offer", offerId: offer().id }]);
  }
});

test("changed shelf, expiry, stock, foreign owner and uncertainty invalidate an open exchange", () => {
  for (const change of [e => { e.barter.offers = []; }, e => { e.now += 1800_000; }, e => { e.snapshot.inventory.moon_crystal = 0; }, e => { e.barter.ownerPublicId = other; },
    e => { e.barter.offers[0].requestedItemId = "living_resin"; }, e => { e.uncertain = true; }, e => { e.busy = true; }, e => { e.retryAt = now + 1000; }, e => { e.snapshot.buildings.home = 2; }]) {
    const e = economy(), commands = []; e.actBarter = command => commands.push(command);
    const h = harness(BarterOfferCard, { economy: e, offer: structuredClone(offer()) }); let view = h.render(); button(view, "Обменять").props.onClick();
    change(e); view = h.render(); const accept = button(view, "Подтвердить обмен");
    assert.equal(accept.props.disabled, true); accept.props.onClick(); assert.deepEqual(commands, []);
  }
});

test("creation offers only special materials, fixes its quote and requires a confirmed one-to-one intent", () => {
  const e = economy(), commands = []; e.actBarter = command => commands.push(command);
  e.snapshot.catalog.items.push({ id: "future_special", name: "Будущий рыночный товар", category: "special", tradable: true, baseSellPrice: 1 });
  const h = harness(BarterCreateForm, { economy: e }); let view = h.render();
  const selects = view.nodes.filter(node => node.type === "select");
  assert.equal(selects[0].props.children.length, 3); assert.equal(selects[1].props.children.length, 2);
  assert.doesNotMatch(view.html, /Древесина|Камень|Жемчуг|Монеты|type="number"/);
  view.nodes.find(node => node.type === "form").props.onSubmit({ preventDefault() {} }); view = h.render();
  assert.deepEqual(commands, []); button(view, "Подтвердить предложение").props.onClick();
  assert.deepEqual(commands, [{ action: "create_offer", offeredItemId: "ancient_core", requestedItemId: "moon_crystal" }]);
  e.snapshot.inventory.ancient_core = 0; view = h.render();
  const submit = button(view, "Подтвердить предложение"); assert.equal(submit.props.disabled, true); submit.props.onClick();
  assert.equal(commands.length, 1, "lost stock cannot silently substitute a different material into the open quote");
});

test("full own shelf and missing stock cannot create while own cancellation remains available after expiry", () => {
  const e = economy(); e.barter.mine = [offer(true), offer(true), offer(true)];
  let h = harness(BarterCreateForm, { economy: e }), view = h.render(); assert.equal(button(view, "Все три места заняты").props.disabled, true);
  e.barter.mine = []; e.snapshot.inventory = {};
  h = harness(BarterCreateForm, { economy: e }); view = h.render(); assert.equal(button(view, "Предложить обмен").props.disabled, true);
  const owned = economy(true); owned.now += 1800_001;
  h = harness(BarterOfferCard, { economy: owned, offer: offer(true), owned: true }); view = h.render();
  assert.equal(button(view, "Вернуть материал").props.disabled, false, "canceling does not need the public showcase or spare warehouse space");
});

test("home unlock and six-slot thirty-minute shelf explain exchange without coin trade controls", () => {
  const e = economy(); e.snapshot.buildings.home = 2; let reads = 0; e.refreshBarter = () => reads++;
  let h = harness(BarterMarket, { economy: e }), view = h.render(); assert.match(view.html, /домом 3 уровня/); assert.equal(reads, 0);
  e.snapshot.buildings.home = 3; h = harness(BarterMarket, { economy: e }); view = h.render();
  assert.equal(reads, 1); assert.match(view.html, /1 \/ 6/); assert.match(view.html, /30 минут/); assert.match(view.html, /Без монет и жемчуга/);
  assert.doesNotMatch(view.html, /Купить весь лот|Продать|type="number"/);
});

test("daily exchange quota disables spending but never traps the owner's escrow", () => {
  const e = economy(), calls = []; e.actBarter = command => calls.push(command);
  e.barter.dailyLimit = { used: 0, limit: 1, resetsAt: new Date(now + 86400000).toISOString() };
  const h = harness(BarterOfferCard, { economy: e, offer: offer() });
  button(h.render(), "Обменять").props.onClick(); e.barter.dailyLimit.used = 1;
  const accept = button(h.render(), "Подтвердить обмен"); assert.equal(accept.props.disabled, true); accept.props.onClick(); assert.deepEqual(calls, []);
  const owned = economy(true); owned.barter.dailyLimit = { ...e.barter.dailyLimit };
  const own = harness(BarterOfferCard, { economy: owned, offer: offer(true), owned: true });
  assert.equal(button(own.render(), "Вернуть материал").props.disabled, false);
});
