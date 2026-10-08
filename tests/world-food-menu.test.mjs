import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { Children, createElement, isValidElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false } });
const { WorldFoodMenu, FoodMealCard, ResidentOrderCard, mealBlockedReason } = await vite.ssrLoadModule("/features/economy/ui/food/world-food-menu.tsx");
const { economyCatalog } = await vite.ssrLoadModule("/features/economy/domain/model.ts");
const { residentOrderBoard, normalizedResidentOrders } = await vite.ssrLoadModule("/features/economy/domain/food.ts");
const { ECONOMY_MAX_BALANCE } = await vite.ssrLoadModule("/features/economy/domain/money.ts");
after(() => vite.close());
const now = Date.parse("2026-10-07T14:00:00Z");
const meal = economyCatalog.food.meals[0];
function controller(overrides = {}, flags = {}) {
  return { snapshot: { ownerPublicId: "ME", revision: 1, serverTime: new Date(now).toISOString(),
    wallet: { coins: 1000, pearls: 0 }, inventory: { grilled_fish: 5 }, buildings: { home: 3, dryer: 3, warehouse: 2 }, jobs: [],
    food: { heroMeal: null, builderMeal: null }, catalog: structuredClone(economyCatalog),
    storage: { capacity: 200, used: 5, reserved: 0, available: 195, overflow: 0 }, ...overrides },
    now, retryAt: 0, busy: false, uncertain: false, error: null, act() {}, retry() {}, ...flags };
}
function elements(tree) {
  const found = [];
  function visit(node) { if (isValidElement(node)) { found.push(node); Children.forEach(node.props.children, visit); } }
  visit(tree); return found;
}
function buttons(tree) { return elements(tree).filter(element => element.type === "button"); }
const render = (component, props) => renderToStaticMarkup(createElement(component, props));

test("food and coin orders are separate panels with no implicit meal debit", () => {
  const economy = controller({}, { act() { assert.fail("opening a panel cannot debit food"); } });
  const meals = render(WorldFoodMenu, { economy });
  assert.match(meals, /role="tab"[^>]*aria-selected="true"[^>]*>[\s\S]*?Еда/);
  assert.match(meals, /Мохлик|Шишколап/);
  assert.match(meals, /Съесть: Жареная рыба, 1 порция/);
  assert.doesNotMatch(meals, /data-order-id=|Отдать заказ/);
  const orders = render(WorldFoodMenu, { economy, initialTab: "orders" });
  assert.equal((orders.match(/data-order-id=/g) ?? []).length, 3);
  assert.match(orders, /Обновление через/);
  assert.match(orders, /Бесплатных замен: <strong>3 \/ 3/);
  assert.match(orders, /новый заказ появится сразу/);
  assert.doesNotMatch(orders, /data-meal=|Съесть:|Угостить Шишколапа:/);
});

test("one explicit meal goes to the chosen consumer with no order reward", () => {
  for (const consumer of ["hero", "builder"]) {
    const calls = [], economy = controller({}, { act(...args) { calls.push(args); } });
    const action = buttons(FoodMealCard({ economy, meal, consumer }))[0];
    assert.equal(action.props.disabled, false);
    assert.deepEqual(calls, []);
    action.props.onClick();
    assert.deepEqual(calls, [[consumer === "hero" ? "eat_food" : "feed_builder", meal.itemId, 1, 0]]);
  }
});

test("pending meals, occupied actors and fed or finished construction prevent another meal", () => {
  const construction = { kind: "construction", targetId: "home", finishesAt: new Date(now + 60_000).toISOString() };
  for (const [consumer, state] of [
    ["hero", { food: { heroMeal: meal.itemId, builderMeal: null } }],
    ["hero", { jobs: [{ kind: "exploration", finishesAt: new Date(now + 60_000).toISOString() }] }],
    ["hero", { jobs: [{ kind: "production", collection: { startedAt: new Date(now).toISOString() } }] }],
    ["builder", { food: { heroMeal: null, builderMeal: meal.itemId } }],
    ["builder", { jobs: [{ ...construction, meal: { itemId: meal.itemId, consumer: "builder", speedBps: 1000 } }] }],
    ["builder", { jobs: [{ ...construction, finishesAt: new Date(now).toISOString() }] }],
  ]) {
    const economy = controller(state, { act() { assert.fail("blocked food handler sent a command"); } });
    assert.ok(mealBlockedReason(economy, consumer));
    const action = buttons(FoodMealCard({ economy, meal, consumer }))[0];
    assert.equal(action.props.disabled, true); action.props.onClick();
  }
  assert.equal(mealBlockedReason(controller({ jobs: [construction] }), "builder"), null);
});

test("missing prepared meals navigate to the exact cooking recipe", () => {
  const navigation = [], economy = controller({ inventory: {} });
  const action = buttons(FoodMealCard({ economy, meal, consumer: "hero", onNavigateStation(...args) { navigation.push(args); } }))[0];
  action.props.onClick();
  assert.deepEqual(navigation, [["dryer", "cook_grilled_fish"]]);
});

test("orders show reward and red shortages and open the missing dish recipe", () => {
  const economy = controller({ inventory: {} }), navigation = [];
  const offer = { id: "preview", slot: 0, residentId: "builder", name: "Обед", items: { grilled_fish: 2 }, coins: 750, availableAt: new Date(now).toISOString() };
  const props = { economy, offer, onNavigateStation(...args) { navigation.push(args); } };
  const html = render(ResidentOrderCard, props);
  assert.match(html, /Награда: 750 монет/);
  assert.match(html, /data-missing="true"/);
  assert.match(html, /0 \/ 2/);
  const actions = buttons(ResidentOrderCard(props));
  actions.find(button => button.props["aria-label"] === "Где получить для заказа: Жареная рыба").props.onClick();
  assert.deepEqual(navigation, [["dryer", "cook_grilled_fish"]]);
  assert.equal(actions.find(button => button.props.children === "Отдать заказ").props.disabled, true);
});

test("complete and replace send the exact current offer and do not touch satiety", () => {
  for (const actionName of ["complete_resident_order", "replace_resident_order"]) {
    const calls = [], economy = controller({}, { act(...args) { calls.push(args); } });
    const offer = residentOrderBoard(economy.snapshot, now).offers[0];
    economy.snapshot.inventory = { ...offer.items };
    const actions = buttons(ResidentOrderCard({ economy, offer }));
    const button = actionName === "complete_resident_order" ? actions[0] : actions[1];
    assert.equal(button.props.disabled, false); button.props.onClick();
    assert.deepEqual(calls, [[actionName, offer.id, 1, 0]]);
    assert.deepEqual(economy.snapshot.food, { heroMeal: null, builderMeal: null });
  }
});

test("legacy cooldowns no longer block ready orders, while expired cards and a full wallet remain guarded", () => {
  const economy = controller({}, { act() { assert.fail("blocked order handler sent a command"); } });
  economy.snapshot.residentOrders = normalizedResidentOrders(economy.snapshot, now);
  economy.snapshot.residentOrders.slots[0].readyAt = new Date(now + 60_000).toISOString();
  const offer = residentOrderBoard(economy.snapshot, now).offers[0];
  economy.snapshot.inventory = { ...offer.items };
  const actions = buttons(ResidentOrderCard({ economy, offer }));
  for (const button of actions) assert.equal(button.props.disabled, false);
  const expired = { ...offer, id: "expired", availableAt: new Date(now).toISOString() };
  for (const button of buttons(ResidentOrderCard({ economy, offer: expired }))) button.props.onClick();
  economy.snapshot.residentOrders.slots[0].readyAt = new Date(now).toISOString();
  economy.snapshot.wallet.coins = ECONOMY_MAX_BALANCE;
  const current = residentOrderBoard(economy.snapshot, now).offers[0];
  const full = buttons(ResidentOrderCard({ economy, offer: current }))[0];
  assert.equal(full.props.disabled, true); full.props.onClick();
});

test("busy, uncertain and retry delay freeze all food and order debit handlers", () => {
  for (const flags of [{ busy: true }, { uncertain: true }, { retryAt: now + 10_000 }]) {
    const economy = controller({}, { ...flags, act() { assert.fail("locked handler sent a command"); } });
    const offer = residentOrderBoard(economy.snapshot, now).offers[0];
    economy.snapshot.inventory = { ...offer.items, [meal.itemId]: 20 };
    for (const tree of [FoodMealCard({ economy, meal, consumer: "hero" }), FoodMealCard({ economy, meal, consumer: "builder" }), ResidentOrderCard({ economy, offer })]) {
      for (const button of buttons(tree)) { assert.equal(button.props.disabled, true); button.props.onClick(); }
    }
  }
  assert.match(render(WorldFoodMenu, { economy: controller({}, { uncertain: true }) }), /Проверить результат/);
  assert.match(render(WorldFoodMenu, { economy: controller({}, { uncertain: true, retryAt: now + 10_000 }) }), /Повторить через 10 с/);
});

test("builder entry selects him and pending/active meal effects are visible", () => {
  const pending = controller({ food: { heroMeal: null, builderMeal: meal.itemId } });
  assert.match(render(WorldFoodMenu, { economy: pending, residentId: "builder" }), /бонус сохранён для следующей стройки/);
  const active = controller({ jobs: [{ kind: "construction", finishesAt: new Date(now + 60_000).toISOString(), meal: { itemId: meal.itemId, consumer: "builder", speedBps: 1000 } }] });
  assert.match(render(WorldFoodMenu, { economy: active, residentId: "builder" }), /скорость стройки \+10%/);
});

test("fish selection changes the visible cost and dispatched ingredient without automatically spending valuable stock", async () => {
  const hookModule = "virtual:food-menu-hooks";
  const runtime = await createServer({ appType: "custom", configFile: false, root,
    resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false },
    plugins: [{ name: "food-menu-hooks", enforce: "pre",
      resolveId(id) { if (id === hookModule) return `\0${id}`; },
      load(id) { if (id === `\0${hookModule}`) return `
        let slots = [], cursor = 0;
        export function reset() { slots = []; cursor = 0; }
        export function render() { cursor = 0; }
        export function useRef(initial) { const index = cursor++; return slots[index] ??= { current: initial }; }
        export function useId() { return useRef('food-control').current; }
        export function useState(initial) { const slot = useRef(typeof initial === 'function' ? initial() : initial); return [slot.current, value => { slot.current = typeof value === 'function' ? value(slot.current) : value; }]; }
        export function useEffect() {}
      `; },
      transform(source, id) { if (/\/features\/economy\/ui\/(?:stations|food)\/world-(object|food)-menu\.tsx$/.test(id)) return source.replace('from "react";', `from "${hookModule}";`); },
    }],
  });
  try {
    const hooks = await runtime.ssrLoadModule(hookModule);
    const { WorldRecipeDetail } = await runtime.ssrLoadModule("/features/economy/ui/stations/world-object-menu.tsx");
    const { WorldFoodMenu: Menu } = await runtime.ssrLoadModule("/features/economy/ui/food/world-food-menu.tsx");
    const calls = [], economy = controller({ inventory: { wood: 20, fish_silverfin: 5, fish_shark: 1 } }, { act(...args) { calls.push(args); } });
    const recipe = economy.snapshot.catalog.recipes.find(recipe => recipe.id === "cook_grilled_fish");
    const prepare = () => { hooks.render(); return WorldRecipeDetail({ economy, recipe, onCollapse() {} }); };
    hooks.reset();
    let tree = prepare();
    const start = tree => buttons(tree).find(button => Array.isArray(button.props.children) && button.props.children[0] === "Начать · ");
    assert.equal(elements(tree).find(element => element.type === "select").props.value, "fish", "empty default stock must not select another species automatically");
    assert.equal(start(tree).props.disabled, true);
    assert.doesNotMatch(renderToStaticMarkup(tree), /option[^>]*value="fish_shark"/, "rare fish are not a fallback for an ordinary recipe");
    elements(tree).find(element => element.type === "select").props.onChange({ target: { value: "fish_silverfin" } });
    tree = prepare();
    assert.equal(start(tree).props.disabled, false);
    assert.match(renderToStaticMarkup(tree), /Серебринка/);
    const ingredientCost = elements(tree).find(element => typeof element.type === "function" && element.type.name === "Cost").props.cost;
    assert.equal(ingredientCost.items.fish, undefined);
    assert.equal(ingredientCost.items.fish_silverfin, recipe.cost.items.fish);
    start(tree).props.onClick();
    assert.deepEqual(calls, [["start_production", "cook_grilled_fish@fish_silverfin", 1]]);
    economy.uncertain = true;
    tree = prepare();
    const select = elements(tree).find(element => element.type === "select");
    assert.equal(select.props.disabled, true);
    select.props.onChange({ target: { value: "fish" } });
    assert.equal(elements(prepare()).find(element => element.type === "select").props.value, "fish_silverfin");

    hooks.reset(); economy.uncertain = false;
    const menu = () => { hooks.render(); return Menu({ economy }); };
    let menuTree = menu();
    const tabs = buttons(menuTree).filter(button => button.props.role === "tab");
    let prevented = false;
    tabs[0].props.onKeyDown({ key: "End", preventDefault() { prevented = true; } });
    menuTree = menu();
    assert.equal(prevented, true);
    assert.equal(buttons(menuTree).filter(button => button.props.role === "tab")[1].props["aria-selected"], true);
    assert.equal(buttons(menuTree).filter(button => button.props.role === "tab")[0].props.tabIndex, -1);
  } finally { await runtime.close(); }
});
