import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { Children, createElement, isValidElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, cacheDir: `/tmp/zhiv-order-card-contract-${process.pid}`,
  resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false } });
const { ResidentOrderCard } = await vite.ssrLoadModule("/features/economy/ui/orders/world-resident-order-board.tsx");
const { economyCatalog, ECONOMY_MAX_BALANCE } = await vite.ssrLoadModule("/features/economy/domain/model.ts");
const { residentOrderBoard, normalizedResidentOrders } = await vite.ssrLoadModule("/features/economy/domain/food.ts");
after(() => vite.close());
const now = Date.parse("2026-10-15T08:00:00Z");
function controller(flags = {}) {
  return { snapshot: { ownerPublicId: "order-owner", revision: 1, serverTime: new Date(now).toISOString(),
    wallet: { coins: 1000, pearls: 0 }, inventory: {}, buildings: { home: 3, dryer: 3, warehouse: 2 }, jobs: [],
    food: { heroMeal: null, builderMeal: null }, catalog: structuredClone(economyCatalog),
    storage: { capacity: 200, used: 5, reserved: 0, available: 195, overflow: 0 } },
    now, retryAt: 0, busy: false, uncertain: false, error: null, act() { return true; }, retry() {}, ...flags };
}
function buttons(tree) {
  const found = [];
  const visit = node => { if (isValidElement(node)) { if (node.type === "button") found.push(node); Children.forEach(node.props.children, visit); } };
  visit(tree); return found;
}
function currentOrder(economy) {
  economy.snapshot.residentOrders ??= normalizedResidentOrders(economy.snapshot, now);
  const terms = economy.snapshot.residentOrders.slots[0].terms;
  terms.items = { grilled_fish: 2 };
  const offer = residentOrderBoard(economy.snapshot, now).offers[0];
  economy.snapshot.inventory = { ...offer.items };
  return offer;
}
const submit = tree => buttons(tree).find(button => button.props["data-guide-order-submit"] !== undefined);

test("order shortage exposes its reward, exact amount and direct cooking source", () => {
  const economy = controller(), navigation = [], offer = currentOrder(economy);
  economy.snapshot.inventory = {};
  const props = { economy, offer, onNavigateStation: (...args) => navigation.push(args) };
  const html = renderToStaticMarkup(createElement(ResidentOrderCard, props));
  assert.ok(html.includes(`Награда: ${offer.coins.toLocaleString("ru-RU")} монет`));
  assert.match(html, /data-missing="true"|data-missing=""/); assert.match(html, /0 \/ 2/);
  const card = ResidentOrderCard(props);
  buttons(card).find(button => button.props["aria-label"] === "Где получить для заказа: Жареная рыба").props.onClick();
  assert.deepEqual(navigation, [["dryer", "cook_grilled_fish"]]); assert.equal(submit(card).props.disabled, true);
});

test("completion and free replacement send exact current order actions without consuming a meal", () => {
  for (const action of ["complete_resident_order", "replace_resident_order"]) {
    const calls = [], economy = controller({ act: (...args) => { calls.push(args); return true; } }), offer = currentOrder(economy);
    const food = structuredClone(economy.snapshot.food), inventory = structuredClone(economy.snapshot.inventory);
    const card = ResidentOrderCard({ economy, offer });
    const control = action === "complete_resident_order" ? submit(card) : buttons(card).find(button => button.props["aria-label"]?.startsWith("Заменить заказ:"));
    assert.ok(control); assert.equal(control.props.disabled, false); control.props.onClick();
    assert.deepEqual(calls, [[action, offer.id, 1, 0]]); assert.deepEqual(economy.snapshot.food, food);
    assert.deepEqual(economy.snapshot.inventory, inventory, "only a confirmed economy response may spend the delivery");
  }
});

test("legacy readyAt cannot postpone a current order while expired cards and a full wallet remain guarded", () => {
  const calls = [], economy = controller({ act: (...args) => { calls.push(args); return true; } });
  currentOrder(economy); economy.snapshot.residentOrders.slots[0].readyAt = new Date(now + 60_000).toISOString();
  const offer = currentOrder(economy), ready = submit(ResidentOrderCard({ economy, offer }));
  assert.equal(ready.props.disabled, false);
  const expired = submit(ResidentOrderCard({ economy, offer: { ...offer, id: "expired" } })); assert.equal(expired.props.disabled, true); expired.props.onClick();
  economy.snapshot.wallet.coins = ECONOMY_MAX_BALANCE;
  const full = submit(ResidentOrderCard({ economy, offer })); assert.equal(full.props.disabled, true); full.props.onClick();
  assert.deepEqual(calls, []);
});

test("busy, uncertain and retry delay guard every order debit handler", () => {
  for (const flags of [{ busy: true }, { uncertain: true }, { retryAt: now + 10_000 }]) {
    const calls = [], economy = controller({ ...flags, act: (...args) => { calls.push(args); return true; } }), offer = currentOrder(economy);
    const card = ResidentOrderCard({ economy, offer });
    for (const control of buttons(card)) { assert.equal(control.props.disabled, true); control.props.onClick(); }
    assert.deepEqual(calls, []);
  }
});
