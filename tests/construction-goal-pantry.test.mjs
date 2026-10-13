import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { Children, isValidElement } from "react";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const hookModule = "virtual:construction-goal-pantry-hooks";
// Run the real pantry handlers across rerenders without mounting icons or the
// map. Only component hooks are adapted; reservation and pricing code are real.
const vite = await createServer({ appType: "custom", configFile: false, root,
  resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false },
  plugins: [{ name: "construction-goal-pantry-hooks", enforce: "pre",
    resolveId(id) { if (id === hookModule) return `\0${id}`; },
    load(id) { if (id === `\0${hookModule}`) return `
      let slots = [], cursor = 0;
      export function reset() { slots = []; cursor = 0; }
      export function render() { cursor = 0; }
      export function useState(initial) {
        const index = cursor++;
        if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial;
        return [slots[index], value => { slots[index] = typeof value === 'function' ? value(slots[index]) : value; }];
      }
      export function useRef(initial) {
        const index = cursor++;
        if (!(index in slots)) slots[index] = { current: initial };
        return slots[index];
      }
      export function useId() { return useState(() => 'pantry-test-' + cursor)[0]; }
      export function useEffect() {}
    `; },
    transform(source, id) {
      if (id.endsWith("/features/economy/ui/inventory/world-pantry-menu.tsx")) return source.replace('from "react";', `from "${hookModule}";`);
    },
  }],
});
after(() => vite.close());
const { PantrySale, WorldPantryMenu } = await vite.ssrLoadModule("/features/economy/ui/inventory/world-pantry-menu.tsx");
const { constructionGoalDetails } = await vite.ssrLoadModule("/features/economy/ui/construction/construction-goal.ts");
const { economyCatalog } = await vite.ssrLoadModule("/features/economy/domain/model.ts");
const { economyStorage } = await vite.ssrLoadModule("/features/economy/domain/rules.ts");
const hooks = await vite.ssrLoadModule(hookModule);
const now = Date.parse("2026-10-07T12:00:00Z");

function snapshot(inventory = { wood: 100, stone: 30, fiber: 20, berries: 3 }) {
  const state = { ownerPublicId: "goal-pantry-test", revision: 1, serverTime: new Date(now).toISOString(),
    wallet: { coins: 2000, pearls: 0 }, inventory, buildings: { home: 1, warehouse: 1, workshop: 1, garden: 1 },
    jobs: [], completedExplorations: 0, catalog: economyCatalog,
    migration: { version: 1, coinsGranted: 0, woodGranted: 0, stoneGranted: 0 } };
  return { ...state, storage: economyStorage(state) };
}
function nodes(tree) {
  const found = [];
  function visit(node) { if (!isValidElement(node)) return; found.push(node); Children.forEach(node.props.children, visit); }
  visit(tree); return found;
}
function text(node) {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(text).join("");
  return isValidElement(node) ? text(node.props.children) : "";
}
function harness(component = PantrySale, extra = {}) {
  hooks.reset();
  const calls = [];
  const economy = { snapshot: snapshot(), busy: false, uncertain: false, retryAt: 0, now,
    act(...args) { calls.push(args); return Promise.resolve(); }, retry() {} };
  let goal = { buildingId: "home", targetLevel: 2 };
  const render = () => {
    hooks.render();
    const details = constructionGoalDetails(economy.snapshot, goal);
    const constructionGoal = { goal: details?.goal ?? null, details, pin() { assert.fail("viewing the pantry cannot change the goal"); }, clear() { goal = null; } };
    return component({ economy, constructionGoal, itemId: "wood", onUpgrade() {}, onExplore() {}, ...extra });
  };
  const button = label => {
    const result = nodes(render()).find(node => node.type === "button" && text(node).startsWith(label));
    assert.ok(result, `Missing button: ${label}`); return result;
  };
  return { economy, calls, render, button, input: () => nodes(render()).find(node => node.type === "input"), clearGoal() { goal = null; } };
}

test("selling only excess keeps direct building materials and raw inputs, and sends the displayed quote", () => {
  const sale = harness(), before = structuredClone(sale.economy.snapshot.inventory);
  // Home 2 needs 3 wood plus 2 planks made from 1 wood each: retain 5 of 100.
  assert.equal(constructionGoalDetails(sale.economy.snapshot, { buildingId: "home", targetLevel: 2 }).keepItems.wood, 5);
  sale.button("Только излишек").props.onClick();
  assert.equal(sale.input().props.value, 95);
  assert.equal(sale.button("Только излишек").props["aria-pressed"], true);
  const sell = sale.button("Продать излишек");
  assert.equal(sell.props.disabled, false); assert.match(text(sell), /2\s?850/);
  assert.deepEqual(sale.calls, [], "choosing a quantity never sends a sale");
  sell.props.onClick();
  assert.deepEqual(sale.calls, [["sell", "wood", 95, 2850]], "the exact NPC quote keeps 5 wood for construction and recipes");
  assert.deepEqual(sale.economy.snapshot.inventory, before, "the UI waits for the server to change inventory");
});

test("excess mode follows new inventory and finished materials instead of retaining an old quantity", () => {
  const sale = harness();
  sale.button("Только излишек").props.onClick(); assert.equal(sale.input().props.value, 95);
  sale.economy.snapshot = snapshot({ ...sale.economy.snapshot.inventory, wood: 90 });
  assert.equal(sale.input().props.value, 85, "ten wood already spent elsewhere are no longer offered");
  sale.economy.snapshot = snapshot({ ...sale.economy.snapshot.inventory, planks: 4 });
  assert.equal(sale.input().props.value, 87, "ready planks release the two reserved raw wood");
  sale.button("Продать излишек").props.onClick();
  assert.deepEqual(sale.calls, [["sell", "wood", 87, 2610]]);
  sale.economy.snapshot = snapshot({ wood: 3, planks: 2 });
  assert.equal(sale.input().props.value, 0);
  const emptySale = sale.button("Продать излишек");
  assert.equal(emptySale.props.disabled, true); emptySale.props.onClick();
  assert.equal(sale.calls.length, 1, "stock needed by the goal is never submitted as excess");
});

test("clearing the goal in excess mode disables selling rather than turning the remaining stock into excess", () => {
  const sale = harness();
  sale.button("Только излишек").props.onClick(); assert.equal(sale.input().props.value, 95);
  sale.clearGoal();
  assert.equal(sale.input().props.value, 0);
  assert.ok(!nodes(sale.render()).some(node => node.type === "button" && text(node).startsWith("Только излишек")));
  const sell = sale.button("Продать излишек");
  assert.equal(sell.props.disabled, true); sell.props.onClick(); assert.deepEqual(sale.calls, []);
  sale.button("Всё").props.onClick();
  assert.equal(sale.input().props.value, "100", "selling the full stock requires another explicit quantity choice");
  assert.equal(sale.button("Продать торговцу").props.disabled, false);
});

test("manual All warns about using goal materials but leaves the explicit sale available", () => {
  const sale = harness();
  sale.button("Только излишек").props.onClick(); sale.button("Всё").props.onClick();
  assert.equal(sale.input().props.value, "100");
  assert.equal(sale.button("Только излишек").props["aria-pressed"], false);
  const warning = nodes(sale.render()).find(node => node.props.role === "status");
  assert.match(text(warning), /В продажу попадут материалы для цели/);
  const sell = sale.button("Продать торговцу");
  assert.equal(sell.props.disabled, false); sell.props.onClick();
  assert.deepEqual(sale.calls, [["sell", "wood", 100, 3000]]);
});

test("pantry annotates needed ingredients and offers the gift return without selling", () => {
  let returned = 0;
  const pantry = harness(WorldPantryMenu, { onReturnToGift() { returned++; } });
  let wood = nodes(pantry.render()).find(node => node.props["aria-label"] === "Бревно: 100");
  assert.match(text(wood), /Для цели: 5/);
  const fiber = nodes(pantry.render()).find(node => node.props["aria-label"] === "Растительное волокно: 20");
  assert.doesNotMatch(text(fiber), /Для цели/, "home two no longer requires rope or fiber");
  const berries = nodes(pantry.render()).find(node => node.props["aria-label"] === "Малина: 3");
  assert.doesNotMatch(text(berries), /Для цели/);
  wood.props.onClick();
  const selectedSale = nodes(pantry.render()).find(node => node.type === PantrySale);
  assert.equal(selectedSale.props.itemId, "wood"); assert.equal(selectedSale.props.constructionGoal.details.keepItems.wood, 5);
  pantry.economy.snapshot = snapshot({ ...pantry.economy.snapshot.inventory, planks: 4 });
  wood = nodes(pantry.render()).find(node => node.props["aria-label"] === "Бревно: 100");
  assert.match(text(wood), /Для цели: 3/);
  pantry.button("Вернуться к подарку").props.onClick();
  assert.equal(returned, 1); assert.deepEqual(pantry.calls, []);
});
