import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { Children, createElement, isValidElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const options = { appType: "custom", configFile: false, root, resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false } };
const vite = await createServer(options);
const { ResidentOrderBoard, ResidentOrderCard, ResidentOrderReplacement, residentOrderQuoteReason, residentOrderSaleValue } = await vite.ssrLoadModule("/features/economy/ui/food/world-resident-order-board.tsx");
const { economyCatalog } = await vite.ssrLoadModule("/features/economy/domain/model.ts");
const { residentOrderBoard, normalizedResidentOrders, advanceResidentOrder } = await vite.ssrLoadModule("/features/economy/domain/food.ts");
const { economyLocalSellPrice } = await vite.ssrLoadModule("/features/economy/domain/local-sale.ts");
after(() => vite.close());
const now = Date.parse("2026-10-07T14:00:00Z");
function controller(overrides = {}, flags = {}) {
  return { snapshot: { ownerPublicId: "ME", revision: 1, serverTime: new Date(now).toISOString(), wallet: { coins: 1000, pearls: 40 },
    inventory: {}, buildings: { home: 5, dryer: 5, workshop: 5, kiln: 5, warehouse: 5, woodlot: 5, garden: 5, quarry: 5 }, jobs: [],
    food: { heroMeal: null, builderMeal: null }, catalog: structuredClone(economyCatalog),
    storage: { capacity: 1000, used: 0, reserved: 0, available: 1000, overflow: 0 }, ...overrides },
    now, retryAt: 0, busy: false, uncertain: false, error: null, notice: "", act() {}, retry() {}, ...flags };
}
function paid(economy) {
  economy.snapshot.residentOrders = normalizedResidentOrders(economy.snapshot, economy.now);
  economy.snapshot.residentOrders.freeReplacementsUsed = economy.snapshot.catalog.food.orders.freeReplacements;
  return economy;
}
const render = (component, props) => renderToStaticMarkup(createElement(component, props));
function elements(tree) {
  const result = [];
  const visit = node => { if (isValidElement(node)) { result.push(node); Children.forEach(node.props.children, visit); } };
  visit(tree); return result;
}
const buttons = tree => elements(tree).filter(element => element.type === "button");

test("board offers three real portraits and an initial NPC filter without mixing meals into feeding", () => {
  const economy = controller({}, { act() { assert.fail("rendering cannot change an order"); } });
  const all = render(ResidentOrderBoard, { economy });
  assert.equal((all.match(/data-order-id=/g) ?? []).length, 3);
  assert.equal((all.match(/<canvas /g) ?? []).length, 3);
  assert.match(all, /Бесплатных замен: <strong>3 \/ 3/);
  assert.match(all, /затем 5 жемчужин/);
  assert.doesNotMatch(all, /Угостить Шишколапа|Съесть:|Доступен через|новый заказ ждёт/);
  const builder = render(ResidentOrderBoard, { economy, residentId: "builder" });
  assert.match(builder, /Материалы и инструменты/);
  assert.match(builder, /data-resident="builder"/);
  assert.doesNotMatch(builder, /data-resident="plesk"/);
});

test("missing raw fish opens the shore and missing crafted materials open the exact recipe", () => {
  const economy = controller(), calls = [];
  const offer = { ...residentOrderBoard(economy.snapshot, now).offers[0], items: { fish: 3, planks: 2 } };
  const card = ResidentOrderCard({ economy, offer, onNavigateStation: (...args) => calls.push(args), onNavigateExpeditions: sector => calls.push([sector]) });
  const sources = buttons(card).filter(button => button.props["aria-label"]?.startsWith("Где получить для заказа:"));
  assert.equal(sources.length, 2);
  sources.forEach(button => button.props.onClick());
  assert.deepEqual(calls, [["shore"], ["workshop", "make_planks"]]);
});

test("order premium compares real fish and rounded local sale proceeds, not the nominal catalogue base", () => {
  const economy = controller();
  const fish = economyCatalog.items.find(item => item.id === "fish");
  const planks = economyCatalog.items.find(item => item.id === "planks");
  const offer = { ...residentOrderBoard(economy.snapshot, now).offers[0], items: { fish: 3, planks: 2 }, coins: 3000 };
  const sale = 3 * fish.baseSellPrice + economyLocalSellPrice(planks.baseSellPrice, 2, economyCatalog.localBuyer);
  assert.equal(residentOrderSaleValue(economy, offer), sale);
  assert.match(render(ResidentOrderCard, { economy, offer }), new RegExp(`На ${(3000 - sale).toLocaleString("ru-RU")} монет больше продажи`));
  assert.equal(residentOrderSaleValue(economy, { ...offer, items: { unknown_item: 1 } }), null);
});

test("paid replacements display five pearls, exact remaining balance and block stale or raised quotes", () => {
  const economy = paid(controller()), offer = residentOrderBoard(economy.snapshot, now).offers[0];
  const quote = { owner: "ME", revision: 1, offerId: offer.id, price: 10 };
  const markup = render(ResidentOrderReplacement, { economy, quote, offer, onCancel() {}, onConfirm() {} });
  assert.match(markup, /Заменить за 5 жемчужин/);
  assert.match(markup, /Жемчужины: 20 → 15/);
  assert.equal(residentOrderQuoteReason(economy, quote), null);
  assert.match(residentOrderQuoteReason(economy, { ...quote, owner: "OTHER" }), /обновились/);
  assert.match(residentOrderQuoteReason(economy, { ...quote, revision: 0 }), /обновились/);
  assert.match(residentOrderQuoteReason(economy, { ...quote, offerId: "expired" }), /обновились/);
  assert.match(residentOrderQuoteReason(economy, { ...quote, price: 8 }), /Цена изменилась/);
  economy.snapshot.wallet.pearls = 8;
  assert.match(residentOrderQuoteReason(economy, quote), /Не хватает жемчужин: 1/);
  economy.uncertain = true;
  assert.match(residentOrderQuoteReason(economy, quote), /Проверяем/);
});

test("free budget reset can lower the price without spending a previously quoted pearl amount", () => {
  const economy = paid(controller()), offer = residentOrderBoard(economy.snapshot, now).offers[0];
  const quote = { owner: "ME", revision: 1, offerId: offer.id, price: 10 };
  economy.snapshot.residentOrders.freeReplacementsUsed = 0;
  assert.equal(residentOrderQuoteReason(economy, quote), null);
  const markup = render(ResidentOrderReplacement, { economy, quote, offer, onCancel() {}, onConfirm() {} });
  assert.match(markup, /Заменить за 0 жемчужин/);
});

test("paid replacement needs deliberate confirmation, checks fresh state and rejects duplicate presses", async () => {
  const hooksId = "virtual:order-board-hooks";
  const runtime = await createServer({ ...options, plugins: [{ name: "order-board-hooks", enforce: "pre",
    resolveId(id) { if (id === hooksId) return `\0${id}`; },
    load(id) { if (id === `\0${hooksId}`) return `
      let slots = [], cursor = 0;
      export function reset() { slots = []; cursor = 0; }
      export function render() { cursor = 0; }
      export function useRef(initial) { const i = cursor++; return slots[i] ??= { current: initial }; }
      export function useState(initial) { const slot = useRef(typeof initial === 'function' ? initial() : initial); return [slot.current, value => { slot.current = typeof value === 'function' ? value(slot.current) : value; }]; }
      export function useId() { return useRef('order-board').current; }
      export function useEffect() {}
      export function useLayoutEffect(effect) { effect(); }
    `; },
    transform(source, id) { if (id.endsWith("/features/economy/ui/food/world-resident-order-board.tsx")) return source.replace('from "react";', `from "${hooksId}";`); },
  }] });
  try {
    const hooks = await runtime.ssrLoadModule(hooksId);
    const { ResidentOrderBoard: Board, ResidentOrderCard: Card } = await runtime.ssrLoadModule("/features/economy/ui/food/world-resident-order-board.tsx");
    const calls = [], economy = paid(controller({}, { act: (...args) => calls.push(args) }));
    const board = () => { hooks.render(); return Board({ economy }); };
    const cards = tree => elements(tree).filter(element => element.type === Card);
    hooks.reset();
    let tree = board(), first = cards(tree)[0], initialId = first.props.offer.id;
    const replace = buttons(Card(first.props)).find(button => button.props["aria-label"]?.startsWith("Заменить заказ:"));
    replace.props.onClick();
    assert.deepEqual(calls, [], "opening consent never sends a command");
    tree = board(); first = cards(tree)[0];
    assert.ok(first.props.confirmation);
    first.props.confirmation.props.onConfirm();
    first.props.confirmation.props.onConfirm();
    assert.deepEqual(calls, [["replace_resident_order", initialId, 1, 10]], "the one receipt uses stored units, never the displayed five");

    hooks.reset(); calls.length = 0;
    tree = board(); cards(tree)[0].props.onReplace(cards(tree)[0].props.offer);
    tree = board(); const oldConfirm = cards(tree)[0].props.confirmation.props.onConfirm;
    economy.snapshot = { ...economy.snapshot, revision: 2 };
    tree = board();
    oldConfirm();
    cards(tree)[0].props.confirmation.props.onConfirm();
    assert.deepEqual(calls, [], "neither captured nor latest callback may debit a different revision");

    hooks.reset(); economy.snapshot.revision = 3;
    economy.snapshot.residentOrders.freeReplacementsUsed = 0;
    tree = board(); first = cards(tree)[0]; initialId = first.props.offer.id;
    first.props.onComplete(first.props.offer);
    assert.deepEqual(calls, [], "missing goods cannot be turned into an order payment");
    economy.snapshot.inventory = { ...first.props.offer.items };
    tree = board(); cards(tree)[0].props.onComplete(cards(tree)[0].props.offer);
    assert.deepEqual(calls, [["complete_resident_order", initialId, 1, 0]]);
    assert.doesNotMatch(renderToStaticMarkup(board()), /Заказ выполнен ·/);
    economy.snapshot.residentOrders = advanceResidentOrder(economy.snapshot, first.props.offer.slot, now);
    economy.snapshot.residentOrders.completed += 1;
    economy.snapshot.revision += 1;
    economy.notice = "Заказ выполнен";
    tree = board();
    assert.ok(cards(tree).every(card => card.props.offer.id !== initialId));
    assert.match(renderToStaticMarkup(tree), /Заказ выполнен ·/);
    assert.equal(cards(tree).length, 3, "the confirmed replacement appears immediately without an empty slot");
    economy.uncertain = true;
    assert.doesNotMatch(renderToStaticMarkup(board()), /Заказ выполнен ·/);
  } finally { await runtime.close(); }
});
