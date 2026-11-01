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
const { economyCatalog } = await vite.ssrLoadModule("/features/economy/domain/model.ts");
const { ECONOMY_MAX_BALANCE, ECONOMY_MAX_PEARLS } = await vite.ssrLoadModule("/features/economy/domain/money.ts");
const now = Date.parse("2026-11-01T12:00:00Z");
const voyageId = "7a58066f-b814-4ff0-8536-e21cfa9de196";
const navigation = { onNavigateStation() {}, onNavigateExpeditions() {} };
function voyage(delivered = 0) {
  return { id: voyageId, number: 3, openedAt: new Date(now).toISOString(), rewardPearls: 8,
    orders: ["Запас досок", "Сухие припасы", "Груз для мастерской"].map((title, index) => ({
      id: `${voyageId}:${index}`, templateId: `template_${index}`, title,
      items: index === 0 ? { planks: 4, rope: 2 } : index === 1 ? { dried_berries: 3 } : { glass: 2 },
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
const text = tree => Children.toArray(tree).map(node => isValidElement(node) ? text(node.props.children) : node).join("");

test("port inspection is read-only and the received lighthouse gates orders", () => {
  const locked = render(WorldShipPort, { economy: controller({ buildings: { home: 5, lighthouse: 0 } }), ...navigation });
  assert.match(locked, /Зажгите маяк/);
  assert.doesNotMatch(locked, /Принять заказы|data-ship-order=/);
  const open = render(WorldShipPort, { economy: controller(), ...navigation });
  assert.match(open, /Принять заказы/);
  assert.match(open, /от 4 жемчужин/);
  assert.match(open, /Точная награда зависит от стоимости груза/);
  assert.match(open, /Выполнено поставок: 2/);
  assert.doesNotMatch(open, /4 часа|8 жемчуга|Отплыть/);
});

test("opening explicitly requests a manifest once, and all pending modes block that request", () => {
  const calls = [], economy = controller({}, { act(...args) { calls.push(args); return true; } });
  const accept = buttons(portTree(economy)).find(button => text(button.props.children).includes("Принять заказы"));
  assert.equal(accept.props.disabled, false);
  accept.props.onClick(); accept.props.onClick();
  assert.deepEqual(calls, [["open_ship_voyage", "port"]]);
  for (const flag of [{ busy: true }, { uncertain: true }, { directActionsAvailable: false }, { snapshotConfirmed: false }, { pendingProductionCount: 1 }, { retryAt: now + 1000 }]) {
    const blocked = buttons(portTree(controller({}, flag))).find(button => text(button.props.children).includes("Принять заказы"));
    assert.equal(blocked.props.disabled, true);
    blocked.props.onClick();
  }
});

test("cooldown uses the server clock and does not replace an active saved shipment", () => {
  const ship = { voyage: null, completedVoyages: 2, nextAvailableAt: new Date(now + 21600000).toISOString() };
  const waiting = render(WorldShipPort, { economy: controller({ ship }), ...navigation });
  assert.match(waiting, /6:00:00/);
  assert.match(waiting, /data-ship-waiting="true"/);
  assert.doesNotMatch(waiting, /Принять заказы/);
  const active = render(WorldShipPort, { economy: controller({ ship: { ...ship, voyage: voyage(1) } }, { now: now + 30 * 86400000 }), ...navigation });
  assert.equal((active.match(/data-ship-order=/g) ?? []).length, 3);
  assert.match(active, /1 из 3 грузов отгружено/);
  assert.match(active, /уже доступна после закрытия этой поставки/);
  assert.doesNotMatch(active, /Принять заказы|Забрать награду/);
});

test("missing cargo links to its exact recipe; fulfilled cargo is paid only through its order ID", () => {
  const state = controller().snapshot, calls = [], order = voyage().orders[0];
  const empty = ShipOrderCard({ state, order, index: 0, disabled: false, onDeliver: id => calls.push(["deliver", id]),
    ...navigation, onNavigateStation: (...args) => calls.push(args) });
  const sources = buttons(empty).filter(button => button.props["aria-label"]?.startsWith("Где получить:"));
  assert.equal(sources.length, 2);
  sources.forEach(button => button.props.onClick());
  assert.deepEqual(calls, [["workshop", "make_planks"], ["workshop", "make_rope"]]);
  const emptyDeliver = buttons(empty).find(button => button.props["aria-label"] === `Отгрузить: ${order.title}`);
  assert.equal(emptyDeliver.props.disabled, true);
  emptyDeliver.props.onClick();
  assert.equal(calls.length, 2);
  state.inventory = { ...order.items };
  const ready = ShipOrderCard({ state, order, index: 0, disabled: false, onDeliver: id => calls.push(["deliver", id]), ...navigation });
  buttons(ready).find(button => button.props["aria-label"] === `Отгрузить: ${order.title}`).props.onClick();
  assert.deepEqual(calls.at(-1), ["deliver", order.id]);
});

test("completed cards show paid cargo, without resubmission or current-stock shortfalls", () => {
  const order = voyage(1).orders[0], markup = render(ShipOrderCard, { state: controller().snapshot, order, index: 0, disabled: false, onDeliver() {}, ...navigation });
  assert.match(markup, /Груз принят и оплачен/);
  assert.match(markup, /Отгружено/);
  assert.doesNotMatch(markup, /Отгрузить|Не хватает|data-missing/);
});

test("only a full manifest exposes the one-time claim and currency caps retain rewards", () => {
  const ship = { voyage: voyage(3), completedVoyages: 2, nextAvailableAt: null }, calls = [];
  const economy = controller({ ship }, { act(...args) { calls.push(args); return true; } });
  const tree = portTree(economy), claim = buttons(tree).find(button => text(button.props.children).includes("Забрать награду"));
  assert.ok(claim);
  assert.equal(claim.props.disabled, false);
  assert.equal(buttons(tree).some(button => text(button.props.children).includes("Отказаться")), false);
  claim.props.onClick(); claim.props.onClick();
  assert.deepEqual(calls, [["claim_ship_voyage", voyageId]]);
  const fullWallet = controller({ ship, wallet: { coins: 0, pearls: ECONOMY_MAX_PEARLS } });
  const blockedClaim = buttons(portTree(fullWallet)).find(button => text(button.props.children).includes("Забрать награду"));
  assert.equal(blockedClaim.props.disabled, true);
  blockedClaim.props.onClick();
  const order = voyage().orders[0], state = controller({ wallet: { coins: ECONOMY_MAX_BALANCE, pearls: 0 }, inventory: order.items }).snapshot;
  const blockedDelivery = buttons(ShipOrderCard({ state, order, index: 0, disabled: false, onDeliver() { assert.fail("full wallet must retain cargo"); }, ...navigation })).find(button => button.props["aria-label"]?.startsWith("Отгрузить:"));
  assert.equal(blockedDelivery.props.disabled, true);
  blockedDelivery.props.onClick();
});

test("uncertain responses show recovery and keep manifest actions disabled", () => {
  const economy = controller({ ship: { voyage: voyage(1), completedVoyages: 2, nextAvailableAt: null } }, { uncertain: true, error: "response lost" });
  const markup = render(WorldShipPort, { economy, ...navigation });
  assert.match(markup, /Проверяем отгрузку/);
  assert.match(markup, /Проверить результат/);
  const tree = portTree(economy);
  assert.equal(elements(tree).filter(node => node.type === ShipOrderCard).every(node => node.props.disabled), true);
  assert.equal(buttons(tree).find(button => text(button.props.children).includes("Отказаться от оставшихся")).props.disabled, true);
});
