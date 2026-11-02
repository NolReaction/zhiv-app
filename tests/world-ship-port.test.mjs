import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { Children, createElement, isValidElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, cacheDir: `/tmp/zhiv-ship-port-${process.pid}`,
  resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false } });
after(() => vite.close());
const { WorldShipPort, ShipOrderCard } = await vite.ssrLoadModule("/features/economy/ui/ship/world-ship-port.tsx");
const { ShipPortStatus } = await vite.ssrLoadModule("/features/economy/ui/ship/ship-port-status.tsx");
const { economyCatalog } = await vite.ssrLoadModule("/features/economy/domain/model.ts");
const { ECONOMY_MAX_BALANCE, ECONOMY_MAX_PEARLS } = await vite.ssrLoadModule("/features/economy/domain/money.ts");
const now = Date.parse("2026-11-01T12:00:00Z");
const voyageId = "7a58066f-b814-4ff0-8536-e21cfa9de196";
const navigation = { onNavigateStation() {}, onNavigateExpeditions() {} };
function voyage(delivered = 0) {
  return { id: voyageId, number: 3, openedAt: new Date(now).toISOString(), rewardPearls: 20,
    orders: ["Запас досок", "Сухие припасы", "Груз для мастерской"].map((title, index) => ({
      id: `${voyageId}:${index}`, templateId: `template_${index}`, title,
      items: index === 0 ? { planks: 4, rope: 2 } : index === 1 ? { dried_berries: 3 } : { glass: 2 },
      loadedItems: {}, difficulty: ["easy", "medium", "hard"][index], rewardItems: index === 2 ? { rope: 1 } : {},
      rewardCoins: 1000 + index * 100, deliveredAt: index < delivered ? new Date(now).toISOString() : null,
    })) };
}
function controller(patch = {}, flags = {}) {
  return { snapshot: { ownerPublicId: "ship-owner", revision: 1, serverTime: new Date(now).toISOString(),
    wallet: { coins: 1000, pearls: 20 }, inventory: {}, buildings: { home: 5, lighthouse: 1, workshop: 5, kiln: 5, garden: 5, dryer: 5, woodlot: 5, quarry: 5 },
    catalog: structuredClone(economyCatalog), jobs: [], progression: { routes: {}, recipes: {}, collections: { finds: [] } },
    ship: { voyage: null, completedVoyages: 2, nextAvailableAt: null }, ...patch },
    now, retryAt: 0, busy: false, uncertain: false, error: null, notice: "", directActionsAvailable: true, snapshotConfirmed: true,
    act() { assert.fail("rendering the port cannot send a command"); }, retry() {}, ...flags };
}
const render = (component, props) => renderToStaticMarkup(createElement(component, props));
function elements(tree) {
  const result = [];
  const visit = node => { if (isValidElement(node)) { result.push(node); Children.forEach(node.props.children, visit); } };
  visit(tree); return result;
}
function portTree(economy) {
  let tree;
  function Probe() { tree = WorldShipPort({ economy, ...navigation }); return null; }
  render(Probe); return tree;
}
const buttons = tree => elements(tree).filter(node => node.type === "button");

test("arrival manifest shows deadline and free replacements without manual acceptance or reward claim", () => {
  const locked = render(WorldShipPort, { economy: controller({ buildings: { home: 5, lighthouse: 0 } }), ...navigation });
  assert.match(locked, /Зажгите маяк/);
  const arriving = render(WorldShipPort, { economy: controller(), ...navigation });
  assert.match(arriving, /Корабль прибывает/);
  const active = render(WorldShipPort, { economy: controller({ ship: { voyage: voyage(), completedVoyages: 2, nextAvailableAt: null } }), ...navigation });
  assert.equal((active.match(/data-ship-order=/g) ?? []).length, 3);
  assert.match(active, /Лёгкий/); assert.match(active, /Средний/); assert.match(active, /Сложный/);
  assert.match(active, /24:00:00/); assert.match(active, /Бесплатные замены:/); assert.match(active, /Отправить раньше/);
  assert.match(active, /За все три груза/); assert.match(active, /<strong>10<\/strong>/);
  for (const markup of [locked, arriving, active]) assert.doesNotMatch(markup, /Принять заказы|Отказаться|Забрать награду|Порт|Южная бухта/);
});

test("cooldown is shown only after departure and uses the server clock", () => {
  const ship = { voyage: null, completedVoyages: 3, nextAvailableAt: new Date(now + 21600000).toISOString() };
  const waiting = render(WorldShipPort, { economy: controller({ ship }), ...navigation });
  assert.match(waiting, /Корабль в пути/); assert.match(waiting, /6:00:00/);
  const active = render(WorldShipPort, { economy: controller({ ship: { ...ship, voyage: voyage(1) } }), ...navigation });
  assert.match(active, /1 \/ 3 грузов/);
  assert.doesNotMatch(active, /6:00:00|Вернётся через/);
});

test("loads available resources separately while showing already loaded progress", () => {
  const order = voyage().orders[0]; order.loadedItems = { planks: 1 };
  const state = controller({ inventory: { planks: 2, rope: 9 } }).snapshot, calls = [];
  const tree = ShipOrderCard({ state, order, index: 0, disabled: false, onLoad: (...args) => calls.push(args), ...navigation });
  const planks = buttons(tree).find(button => button.props["aria-label"] === "Загрузить 2: Доска");
  assert.ok(planks); planks.props.onClick();
  const rope = buttons(tree).find(button => button.props["aria-label"] === "Загрузить 2: Верёвка");
  assert.ok(rope); rope.props.onClick();
  assert.deepEqual(calls, [[order.id, "planks", 2], [order.id, "rope", 2]]);
  const markup = render(ShipOrderCard, { state, order, index: 0, disabled: false, onLoad() {}, ...navigation });
  assert.match(markup, /Загружено 1 из 4: Доска/);
  assert.match(markup, /Загружено 0 из 2: Верёвка/);
});

test("missing materials navigate to the correct recipe without a cargo command", () => {
  const state = controller().snapshot, calls = [], order = voyage().orders[0];
  const tree = ShipOrderCard({ state, order, index: 0, disabled: false, onLoad() { assert.fail("no stock"); }, ...navigation,
    onNavigateStation: (...args) => calls.push(args) });
  const sources = buttons(tree).filter(button => button.props["aria-label"]?.startsWith("Где получить:"));
  sources.forEach(button => button.props.onClick());
  assert.deepEqual(calls, [["workshop", "make_planks"], ["workshop", "make_rope"]]);
  assert.equal(buttons(tree).filter(button => button.props["aria-label"]?.startsWith("Загрузить")).length, 0);
});

test("parent sends a scoped cargo command once and prevents rapid double loading", () => {
  const calls = [], ship = { voyage: voyage(), completedVoyages: 2, nextAvailableAt: null };
  const tree = portTree(controller({ ship }, { act(...args) { calls.push(args); return true; } }));
  const card = elements(tree).find(node => node.type === ShipOrderCard);
  card.props.onLoad(ship.voyage.orders[0].id, "planks", 2);
  card.props.onLoad(ship.voyage.orders[0].id, "planks", 2);
  assert.deepEqual(calls, [["load_ship_cargo", ship.voyage.orders[0].id, 2, 0, undefined,
    { voyageId, orderId: ship.voyage.orders[0].id, itemId: "planks" }]]);
  for (const flags of [{ busy: true }, { uncertain: true }, { snapshotConfirmed: false }, { directActionsAvailable: false }, { pendingProductionCount: 1 }]) {
    const blocked = elements(portTree(controller({ ship }, flags))).find(node => node.type === ShipOrderCard);
    assert.equal(blocked.props.disabled, true);
    blocked.props.onLoad(ship.voyage.orders[0].id, "planks", 2);
  }
});

test("completed cargo remains paid and cannot be loaded again", () => {
  const order = voyage(1).orders[0];
  const markup = render(ShipOrderCard, { state: controller().snapshot, order, index: 0, disabled: false, onLoad() {}, ...navigation });
  assert.match(markup, /Получено/); assert.match(markup, /На борту/);
  assert.doesNotMatch(markup, /Загрузить|Где получить|Нужно ещё/);
  const bonusOrder = voyage().orders[2];
  const bonus = render(ShipOrderCard, { state: controller().snapshot, order: bonusOrder, index: 2, disabled: false, onLoad() {}, ...navigation });
  assert.match(bonus, /Верёвка: 1/);
});

test("wallet limits block only finishing a load, allowing cargo to be accumulated", () => {
  const order = voyage().orders[0], state = controller({ inventory: { planks: 2, rope: 2 }, wallet: { coins: ECONOMY_MAX_BALANCE, pearls: 0 } }).snapshot;
  let calls = 0;
  const first = ShipOrderCard({ state, order, index: 0, disabled: false, onLoad() { calls++; }, ...navigation });
  const partial = buttons(first).find(button => button.props["aria-label"] === "Загрузить 2: Доска");
  assert.equal(partial.props.disabled, false); partial.props.onClick(); assert.equal(calls, 1);
  order.loadedItems = { planks: 4 };
  const finishing = buttons(ShipOrderCard({ state, order, index: 0, disabled: false, onLoad() { assert.fail("full wallet"); }, ...navigation }))
    .find(button => button.props["aria-label"] === "Загрузить 2: Верёвка");
  assert.equal(finishing.props.disabled, true); finishing.props.onClick();
  const ship = { voyage: voyage(2), completedVoyages: 2, nextAvailableAt: null }, last = ship.voyage.orders[2];
  const pearlState = controller({ ship, inventory: { glass: 2 }, wallet: { coins: 0, pearls: ECONOMY_MAX_PEARLS - 15 } }).snapshot;
  const pearlButton = buttons(ShipOrderCard({ state: pearlState, order: last, index: 2, disabled: false, onLoad() { assert.fail("ten visible pearls must fit"); }, ...navigation }))
    .find(button => button.props["aria-label"]?.startsWith("Загрузить"));
  assert.equal(pearlButton.props.disabled, true); pearlButton.props.onClick();
});

test("uncertain loading offers recovery and disables every cargo card", () => {
  const economy = controller({ ship: { voyage: voyage(1), completedVoyages: 2, nextAvailableAt: null } }, { uncertain: true, error: "response lost" });
  const markup = render(WorldShipPort, { economy, ...navigation });
  assert.match(markup, /Проверяем действие/); assert.match(markup, /Проверить результат/);
  assert.equal(elements(portTree(economy)).filter(node => node.type === ShipOrderCard).every(node => node.props.disabled), true);
});


test("a last partial load reserves room for its item gift without blocking earlier cargo", () => {
  const order = voyage().orders[0];
  order.loadedItems = { planks: 4, rope: 1 }; order.rewardItems = { planks: 2 };
  const state = controller({ inventory: { rope: 1, wood: 99 }, storage: { used: 100, reserved: 0, capacity: 100, available: 0, overflow: 0 } }).snapshot;
  const card = () => ShipOrderCard({ state, order, index: 0, disabled: false, onLoad() { assert.fail("no room for the gift"); }, ...navigation });
  let button = buttons(card()).find(button => button.props["aria-label"] === "Загрузить 1: Верёвка");
  assert.equal(button.props.disabled, true); assert.equal(button.props["aria-describedby"], "ship-gift-space-0"); button.props.onClick();
  assert.match(render(ShipOrderCard, { state, order, index: 0, disabled: false, onLoad() {}, ...navigation }), /Освободите место в кладовой для подарка капитана/);
  state.storage.used = 99;
  button = buttons(card()).find(button => button.props["aria-label"] === "Загрузить 1: Верёвка");
  assert.equal(button.props.disabled, false, "consumed cargo frees one slot and the gift uses two");
  state.storage.used = 98; state.storage.reserved = 2;
  button = buttons(card()).find(button => button.props["aria-label"] === "Загрузить 1: Верёвка");
  assert.equal(button.props.disabled, true, "escrow stock still occupies storage");
  order.loadedItems.planks = 3;
  button = buttons(card()).find(button => button.props["aria-label"] === "Загрузить 1: Верёвка");
  assert.equal(button.props.disabled, false, "incomplete loads do not receive the item gift yet");
});


test("lighthouse and port share expiry and next arrival clocks", () => {
  const state = controller({ ship: { voyage: voyage(), completedVoyages: 2, nextAvailableAt: null } }).snapshot;
  const status = at => render(ShipPortStatus, { state, now: at });
  assert.match(status(now), /Корабль у причала.*24:00:00/);
  assert.match(status(now + 86400000), /Новый корабль через.*6:00:00/);
  assert.match(status(now + 108000000), /Корабль прибывает с новыми заказами/);
  const expiredPort = render(WorldShipPort, { economy: controller({ ship: state.ship }, { now: now + 86400000 }), ...navigation });
  assert.match(expiredPort, /Корабль в пути/); assert.match(expiredPort, /6:00:00/);
  assert.doesNotMatch(expiredPort, /data-ship-order=|Отправить раньше/);
});

test("only untouched unpaid orders expose replacement and exhausted budget disables it", () => {
  const state = controller().snapshot, order = voyage().orders[0];
  const card = changed => render(ShipOrderCard, { state, order: { ...order, ...changed }, index: 0, disabled: false,
    onLoad() {}, onReplace() {}, replacementAvailable: true, ...navigation });
  assert.match(card({}), /Заменить бесплатно/);
  assert.doesNotMatch(card({ loadedItems: { planks: 1 } }), /Заменить бесплатно/);
  assert.doesNotMatch(card({ deliveredAt: new Date(now).toISOString() }), /Заменить бесплатно/);
  const exhausted = voyage(); exhausted.replacementsUsed = 3;
  const tree = portTree(controller({ ship: { voyage: exhausted, completedVoyages: 2, nextAvailableAt: null } }));
  const cards = elements(tree).filter(node => node.type === ShipOrderCard);
  assert.equal(cards.length, 3); assert.ok(cards.every(node => node.props.replacementAvailable === false));
  const noPearls = portTree(controller({ wallet: { coins: 100, pearls: 19 }, ship: { voyage: voyage(), completedVoyages: 0, nextAvailableAt: null } }));
  assert.equal(buttons(noPearls).at(-1).props.disabled, true);
});
