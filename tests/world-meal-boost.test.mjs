import assert from "node:assert/strict";
import test, { after } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Children, createElement, isValidElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const cacheDir = await mkdtemp(join(tmpdir(), "zhiv-meal-boost-test-"));
const hookModule = "virtual:meal-boost-hooks";
const vite = await createServer({ appType: "custom", configFile: false, root, cacheDir, resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false },
  plugins: [{ name: "meal-boost-hooks", enforce: "pre",
    resolveId(id) { if (id === hookModule) return `\0${id}`; },
    load(id) { if (id === `\0${hookModule}`) return `
      let slots = [], cursor = 0, effects = [];
      export function reset() { slots = []; cursor = 0; effects = []; }
      export function render() { cursor = 0; effects = []; }
      export function flush() { for (const effect of effects) effect(); }
      export function useRef(initial) { const index = cursor++; return slots[index] ??= { current: initial }; }
      export function useId() { return useRef('meal-' + cursor).current; }
      export function useState(initial) { const slot = useRef(typeof initial === 'function' ? initial() : initial); return [slot.current, value => { slot.current = typeof value === 'function' ? value(slot.current) : value; }]; }
      export function useEffect(effect, dependencies) {
        const previous = useRef(null);
        if (!previous.current || dependencies.some((value, index) => !Object.is(value, previous.current[index]))) { previous.current = dependencies; effects.push(effect); }
      }
      export const useLayoutEffect = useEffect;
    `; },
    transform(source, id) { if (id.endsWith("/features/economy/ui/food/world-meal-boost.tsx")) return source.replace('from "react";', `from "${hookModule}";`); },
  }],
});
after(async () => { await vite.close(); await rm(cacheDir, { recursive: true, force: true }); });
const hooks = await vite.ssrLoadModule(hookModule);
const { WorldMealBoost, mealBoostReason, mealBoostSeconds } = await vite.ssrLoadModule("/features/economy/ui/food/world-meal-boost.tsx");
const { WorldExpeditionSector } = await vite.ssrLoadModule("/features/economy/ui/expeditions/world-expeditions-menu.tsx");
const { WorldUpgradeContent } = await vite.ssrLoadModule("/features/economy/ui/construction/world-upgrade-dialog.tsx");
const { BuilderConversation } = await vite.ssrLoadModule("/features/world/ui/characters/world-builder-dialog.tsx");
const { economyCatalog } = await vite.ssrLoadModule("/features/economy/domain/model.ts");
const { economyStorage } = await vite.ssrLoadModule("/features/economy/domain/rules.ts");
const now = Date.parse("2026-10-07T18:00:00Z");
function controller(overrides = {}, flags = {}) {
  const state = { ownerPublicId: "boost-owner", revision: 1, serverTime: new Date(now).toISOString(), catalog: structuredClone(economyCatalog), wallet: { coins: 1000, pearls: 0 },
    inventory: { grilled_fish: 2, legendary_fish: 1, fish: 99 }, buildings: { home: 5, warehouse: 1, workshop: 2, dryer: 5 }, jobs: [], food: { heroMeal: null, builderMeal: null },
    completedExplorations: 0, migration: { version: 1, coinsGranted: 0, woodGranted: 0, stoneGranted: 0 }, ...overrides };
  const calls = [];
  return { snapshot: { ...state, storage: economyStorage(state) }, busy: false, uncertain: false, error: null, now, retryAt: 0, calls,
    act: (...args) => { calls.push(args); return true; }, retry() {}, ...flags };
}
function elements(tree) {
  const result = [];
  const walk = node => { if (isValidElement(node)) { result.push(node); Children.forEach(node.props.children, walk); } };
  walk(tree); return result;
}
function render(props) { hooks.render(); const tree = WorldMealBoost(props); hooks.flush(); return { tree, nodes: elements(tree) }; }
function open(props) { hooks.reset(); let view = render(props); assert.equal(view.tree.props.open, false); view.tree.props.onOpenChange(true); view = render(props); assert.equal(view.tree.props.open, true); return view; }
const row = (view, id) => view.nodes.find(node => node.props["data-boost-meal"] === id);
const action = (view, id) => elements(row(view, id)).find(node => node.type === "button");
const job = (overrides = {}) => ({ id: "construction-1", kind: "construction", targetId: "home", targetLevel: 4, startedAt: new Date(now - 1000).toISOString(), finishesAt: new Date(now + 66_000).toISOString(), cost: { coins: 0, items: {} }, rewards: {}, ...overrides });

test("meal picker opens without spending and shows only opened or owned meals with actual stock and speed", () => {
  const economy = controller(), before = structuredClone(economy.snapshot), props = { economy, consumer: "hero", seconds: 7200, onNavigateStation() {} };
  const view = open(props);
  const visible = economy.snapshot.catalog.food.meals.filter(meal => (economy.snapshot.inventory[meal.itemId] ?? 0) > 0
    || economy.snapshot.catalog.recipes.some(recipe => recipe.rewards[meal.itemId] > 0 && recipe.buildingLevel <= (economy.snapshot.buildings[recipe.buildingId] ?? 0)
      && recipe.requiredHomeLevel <= economy.snapshot.buildings.home && Object.entries(recipe.requiredBuildings).every(([id, level]) => (economy.snapshot.buildings[id] ?? 0) >= level)));
  assert.equal(view.nodes.filter(node => node.props["data-boost-meal"]).length, visible.length);
  assert.ok(visible.length < economy.snapshot.catalog.food.meals.length, "locked recipes are absent");
  for (const meal of visible) {
    const markup = renderToStaticMarkup(row(view, meal.itemId));
    assert.ok(markup.includes(`+${meal.heroSpeedBps / 100}%`));
    assert.ok(markup.includes(`есть ${economy.snapshot.inventory[meal.itemId] ?? 0}`));
  }
  assert.deepEqual(economy.calls, []); assert.deepEqual(economy.snapshot, before);
  const close = view.nodes.find(node => node.props["data-meal-picker-close"]);
  assert.equal(close.props["aria-label"], "Закрыть выбор еды");
});

test("only the explicit dish is eaten once, never raw fish or a second meal from a double click", () => {
  for (const consumer of ["hero", "builder"]) {
    const economy = controller(), props = { economy, consumer, seconds: 3600 }, view = open(props);
    const control = action(view, "grilled_fish");
    assert.equal(control.props.disabled, false);
    control.props.onClick(); control.props.onClick();
    assert.deepEqual(economy.calls, [[consumer === "hero" ? "eat_food" : "feed_builder", "grilled_fish", 1, 0]]);
    assert.equal(economy.snapshot.inventory.fish, 99);
  }
});

test("missing meals open their exact recipe without feeding or departing", () => {
  const economy = controller({ inventory: {} }), opened = [], props = { economy, consumer: "hero", seconds: 3600, onNavigateStation: (...args) => opened.push(args) };
  const view = open(props), control = action(view, "grilled_fish");
  assert.match(control.props["aria-label"], /^Приготовить:/);
  control.props.onClick();
  assert.deepEqual(opened, [["dryer", "cook_grilled_fish"]]); assert.deepEqual(economy.calls, []);
  assert.equal(render(props).tree.props.open, false);
});

test("transport, actor and saved food locks never offer a debit", () => {
  for (const props of [
    { economy: controller({}, { busy: true }), consumer: "hero" },
    { economy: controller({}, { uncertain: true }), consumer: "hero" },
    { economy: controller({}, { retryAt: now + 1 }), consumer: "hero" },
    { economy: controller(), consumer: "hero", isOnline: false },
    { economy: controller({ jobs: [job({ kind: "exploration", targetId: "forest" })] }), consumer: "hero" },
    { economy: controller({ jobs: [job({ kind: "production", targetId: "garden", collection: { startedAt: new Date(now).toISOString() } })] }), consumer: "hero" },
    { economy: controller({ food: { heroMeal: "grilled_fish", builderMeal: null } }), consumer: "hero" },
  ]) {
    hooks.reset(); assert.ok(mealBoostReason(props)); const view = render(props);
    const trigger = view.nodes.find(node => node.type === "button" && node.props["data-meal-boost"]);
    if (trigger) { assert.equal(trigger.props.disabled, true); view.tree.props.onOpenChange(true); assert.equal(render(props).tree.props.open, false); }
    else assert.ok(view.nodes.some(node => node.props["data-meal-applied"]));
    assert.deepEqual(props.economy.calls, []);
  }
  hooks.reset(); assert.equal(render({ economy: controller({}, { snapshot: null }), consumer: "hero" }).tree, null);
});

test("open picker rechecks current inventory, revision, owner and actor before spending", () => {
  for (const mutate of [
    economy => { economy.snapshot.inventory.grilled_fish = 0; },
    economy => { economy.snapshot.revision++; },
    economy => { economy.snapshot.ownerPublicId = "another-owner"; },
    economy => { economy.snapshot.food.heroMeal = "grilled_fish"; },
    economy => { economy.snapshot.jobs = [job({ kind: "exploration" })]; },
    economy => { economy.busy = true; },
    economy => { economy.uncertain = true; },
    economy => { economy.retryAt = now + 1000; },
    economy => { economy.snapshot = null; },
  ]) {
    const economy = controller(), props = { economy, consumer: "hero", seconds: 3600 }, view = open(props);
    const control = action(view, "grilled_fish"); mutate(economy); control.props.onClick(); assert.deepEqual(economy.calls, []);
  }
});

test("builder boost belongs to the exact active job and cannot feed a different construction from a preview", () => {
  for (const [construction, jobId, expected] of [[job(), undefined, true], [job(), "different", true], [job({ finishesAt: new Date(now).toISOString() }), "construction-1", true], [job({ meal: { itemId: "grilled_fish", consumer: "builder", speedBps: 1000 } }), "construction-1", true], [job(), "construction-1", false]]) {
    const economy = controller({ jobs: [construction] }), props = { economy, consumer: "builder", stationId: "workshop", jobId };
    assert.equal(Boolean(mealBoostReason(props)), expected);
    if (!expected) {
      const view = open(props); economy.snapshot.jobs = [job({ id: "replacement-job" })];
      action(view, "grilled_fish").props.onClick(); assert.deepEqual(economy.calls, []);
    }
  }
});

test("speed previews divide duration, preserve remaining millisecond precision and keep historical paid buffs", () => {
  const economy = controller();
  assert.equal(mealBoostSeconds({ economy, seconds: 7200 }, 10000), 3600);
  assert.equal(mealBoostSeconds({ economy, seconds: 7200 }, 9000), 3790);
  economy.snapshot.jobs = [job({ finishesAt: new Date(now + 1001).toISOString() })];
  assert.equal(mealBoostSeconds({ economy, jobId: "construction-1" }, 1000), 1, "round milliseconds after acceleration, not seconds before it");
  economy.snapshot.jobs = [job({ meal: { itemId: "hearty_fish", consumer: "builder", speedBps: 1000 } })];
  hooks.reset(); const historical = render({ economy, consumer: "builder", jobId: "construction-1" });
  assert.equal(historical.tree.props["data-meal-applied"], "hearty_fish");
  assert.match(historical.tree.props["aria-label"], /\+10%/);
  assert.equal(historical.nodes.some(node => node.type === "button"), false);
});

test("confirmed feeding closes the picker and exposes the saved bonus without auto-starting a job", () => {
  const economy = controller(), props = { economy, consumer: "hero", seconds: 7200 };
  const view = open(props); action(view, "grilled_fish").props.onClick();
  economy.busy = true; render(props);
  economy.busy = false; economy.snapshot = { ...economy.snapshot, revision: 2, food: { heroMeal: "grilled_fish", builderMeal: null } };
  const confirmed = render(props);
  assert.equal(confirmed.tree.props["data-meal-applied"], "grilled_fish");
  assert.equal(confirmed.nodes.some(node => node.props["data-meal-picker"]), false);
  assert.deepEqual(economy.calls, [["eat_food", "grilled_fish", 1, 0]]);
});

test("meal choice is wired to route duration, construction preparation and the builder's active timer", () => {
  const economy = controller(), callbacks = { onNavigateStation() {}, isOnline: true };
  let routeNodes;
  function Probe() { const tree = WorldExpeditionSector({ economy, state: economy.snapshot, sectorId: "forest", selectedRoute: "forest", onSelectRoute() {}, exploring: false, onOpenPantry() {}, ...callbacks }); routeNodes = elements(tree); return tree; }
  hooks.reset(); renderToStaticMarkup(createElement(Probe));
  const route = routeNodes.find(node => node.type === WorldMealBoost);
  assert.equal(route.props.seconds, economy.snapshot.catalog.explorations.find(route => route.id === "forest").seconds);
  assert.equal(route.props.consumer, "hero"); assert.equal(route.props.onNavigateStation, callbacks.onNavigateStation);
  const upgrades = elements(WorldUpgradeContent({ stationId: "warehouse", economy, onClose() {}, navigation: { canOpen: () => true, open: callbacks.onNavigateStation }, ...callbacks }));
  const upgrade = upgrades.find(node => node.type === WorldMealBoost);
  assert.equal(upgrade.props.consumer, "builder"); assert.equal(upgrade.props.stationId, "warehouse"); assert.equal(upgrade.props.jobId, undefined);
  economy.snapshot.jobs = [job()];
  const builder = elements(BuilderConversation({ economy, onOpenConstruction() {}, ...callbacks })).find(node => node.type === WorldMealBoost);
  assert.equal(builder.props.jobId, "construction-1"); assert.equal(builder.props.onNavigateStation, callbacks.onNavigateStation);
});

test("a missing meal without a recipe navigation stays unavailable instead of linking to a removed food page", () => {
  const economy = controller({ inventory: {} });
  const view = open({ economy, consumer: "hero", seconds: 3600 });
  const meal = row(view, "grilled_fish");
  assert.ok(meal);
  assert.equal(action(view, "grilled_fish"), undefined);
  assert.match(renderToStaticMarkup(meal), /Нет/);
  assert.deepEqual(economy.calls, []);
});

test("closed selector names the food boost and explicit choice for both workers without spending", () => {
  for (const consumer of ["hero", "builder"]) {
    const economy = controller(); hooks.reset();
    const view = render({ economy, consumer, seconds: 7200 });
    const trigger = view.nodes.find(node => node.type === "button" && node.props["data-meal-boost"] === consumer);
    const html = renderToStaticMarkup(trigger);
    assert.match(html, /Ускорение едой/);
    assert.match(html, /Выбрать блюдо/);
    assert.match(html, /1 порция ускорит работу/);
    assert.match(html, /chevron-right/);
    assert.equal(view.nodes.some(node => node.props["data-meal-picker"]), false);
    assert.deepEqual(economy.calls, []);
  }
});

test("saved next-route meal names the dish and shows the true time improvement instead of another action", () => {
  const economy = controller({ food: { heroMeal: "grilled_fish", builderMeal: null } }); hooks.reset();
  const meal = economy.snapshot.catalog.food.meals.find(value => value.itemId === "grilled_fish");
  const view = render({ economy, consumer: "hero", seconds: 7200 }), html = renderToStaticMarkup(view.tree);
  assert.match(html, /Жареная рыба/);
  assert.ok(html.includes(`+${meal.heroSpeedBps / 100}% скорости`));
  assert.match(html, /Для следующей вылазки/);
  const timer = view.nodes.find(node => node.props["data-meal-duration"] !== undefined);
  assert.match(renderToStaticMarkup(timer), /arrow-right/);
  assert.equal(view.nodes.some(node => node.type === "button"), false);
  assert.deepEqual(economy.calls, []);
});

test("applied builder meal shows its saved speed and remaining timer without speeding the timer a second time", () => {
  const economy = controller({ jobs: [job({ finishesAt: new Date(now + 49_000).toISOString(), meal: { itemId: "hearty_fish", consumer: "builder", speedBps: 1000 } })] }); hooks.reset();
  const view = render({ economy, consumer: "builder", jobId: "construction-1" }), html = renderToStaticMarkup(view.tree);
  assert.match(html, /\+10% скорости/);
  assert.match(html, /Обед учтён/);
  const timer = view.nodes.find(node => node.props["data-meal-duration"] !== undefined), timerHtml = renderToStaticMarkup(timer);
  assert.match(timerHtml, /49 с/);
  assert.doesNotMatch(timerHtml, /arrow-right/);
  assert.equal(view.nodes.some(node => node.type === "button"), false);
});

test("rejected meal action keeps the picker retryable and an accepted retry is sent only once", () => {
  const attempts = [];
  const economy = controller({}, { act: (...args) => { attempts.push(args); return attempts.length > 1; } });
  const props = { economy, consumer: "hero", seconds: 7200 }, view = open(props);
  action(view, "grilled_fish").props.onClick();
  const refused = render(props);
  assert.equal(refused.tree.props.open, true);
  assert.equal(refused.nodes.some(node => node.props.role === "status" && renderToStaticMarkup(node).includes("Обед не отправлен")), true);
  action(refused, "grilled_fish").props.onClick();
  action(refused, "grilled_fish").props.onClick();
  assert.deepEqual(attempts, [["eat_food", "grilled_fish", 1, 0], ["eat_food", "grilled_fish", 1, 0]]);
  assert.equal(economy.snapshot.inventory.grilled_fish, 2, "the client never deducts stock optimistically");
});

test("blocked choice explains the reason inside the tile without revealing a spending picker", () => {
  const economy = controller(); hooks.reset();
  const props = { economy, consumer: "hero", seconds: 3600, isOnline: false }, view = render(props);
  const trigger = view.nodes.find(node => node.type === "button" && node.props["data-meal-boost"]);
  assert.equal(trigger.props.disabled, true);
  assert.match(renderToStaticMarkup(trigger), /Подключитесь к интернету/);
  view.tree.props.onOpenChange(true);
  assert.equal(render(props).tree.props.open, false);
  assert.deepEqual(economy.calls, []);
});
