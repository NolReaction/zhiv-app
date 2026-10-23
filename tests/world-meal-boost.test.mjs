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
const { WorldMealBoost, mealBoostReason, mealBoostSeconds, mealReturnReason } = await vite.ssrLoadModule("/features/economy/ui/food/world-meal-boost.tsx");
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
  return { snapshot: { ...state, storage: economyStorage(state) }, snapshotConfirmed: true, busy: false, uncertain: false, error: null, now, retryAt: 0, calls,
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
const confirmation = view => view.nodes.find(node => node.props["data-meal-confirm"] !== undefined);
function choose(props, view, itemId = "grilled_fish") { action(view, itemId).props.onClick(); return render(props); }
const job = (overrides = {}) => ({ id: "construction-1", kind: "construction", targetId: "home", targetLevel: 4, startedAt: new Date(now - 1000).toISOString(), finishesAt: new Date(now + 66_000).toISOString(), cost: { coins: 0, items: {} }, rewards: {}, ...overrides });

test("meal picker opens without spending and shows only opened or owned meals with actual stock and speed", () => {
  const economy = controller(), before = structuredClone(economy.snapshot), props = { economy, consumer: "hero", seconds: 7200, onNavigateStation() {} };
  const view = open(props);
  const visibleIds = view.nodes.filter(node => node.props["data-boost-meal"]).map(node => node.props["data-boost-meal"]);
  assert.deepEqual(visibleIds, ["grilled_fish", "berry_fish", "hearty_fish", "legendary_fish"]);
  assert.equal(row(view, "fish_soup"), undefined, "the first personally cooked grilled fish still needs collecting");
  const visible = economy.snapshot.catalog.food.meals.filter(meal => visibleIds.includes(meal.itemId));
  for (const meal of visible) {
    const markup = renderToStaticMarkup(row(view, meal.itemId));
    assert.ok(markup.includes(`+${meal.heroSpeedBps / 100}%`));
    assert.ok(markup.includes(economy.snapshot.inventory[meal.itemId] ? `В запасе ${economy.snapshot.inventory[meal.itemId]}` : "Нет в запасе"));
  }
  assert.deepEqual(economy.calls, []); assert.deepEqual(economy.snapshot, before);
  assert.equal(confirmation(view).props.disabled, true);
  const close = view.nodes.find(node => node.props["data-meal-picker-close"]);
  assert.equal(close.props["aria-label"], "Закрыть выбор еды");
});

test("only the explicit dish is eaten once, never raw fish or a second meal from a double click", () => {
  for (const consumer of ["hero", "builder"]) {
    const economy = controller(), props = { economy, consumer, seconds: 3600 }, view = choose(props, open(props));
    assert.deepEqual(economy.calls, [], "choosing and previewing do not spend");
    const control = confirmation(view);
    assert.equal(control.props.disabled, false);
    control.props.onClick(); control.props.onClick();
    assert.deepEqual(economy.calls, [[consumer === "hero" ? "eat_food" : "feed_builder", "grilled_fish", 1, 0]]);
    assert.equal(economy.snapshot.inventory.fish, 99);
  }
});

test("changing the selected dish invalidates an old confirmation before rerender and previews only the chosen bonus", () => {
  const economy = controller(), props = { economy, consumer: "builder", seconds: 7200 };
  let view = choose(props, open(props));
  const previousConfirm = confirmation(view).props.onClick;
  assert.equal(action(view, "grilled_fish").props["aria-pressed"], true);
  assert.equal(view.nodes.filter(node => node.props["data-meal-preview"]).length, 1);
  const preview = view.nodes.find(node => node.props["data-meal-preview"] === "grilled_fish");
  assert.match(renderToStaticMarkup(preview), /\+10% скорости/);
  action(view, "legendary_fish").props.onClick();
  previousConfirm();
  assert.deepEqual(economy.calls, [], "a retained handler cannot spend the previously selected dish");
  view = render(props);
  assert.equal(action(view, "grilled_fish").props["aria-pressed"], false);
  assert.equal(action(view, "legendary_fish").props["aria-pressed"], true);
  confirmation(view).props.onClick();
  assert.deepEqual(economy.calls, [["feed_builder", "legendary_fish", 1, 0]]);
});

test("an accepted confirmation stays pending, locks other choices and cannot be reopened for another debit", () => {
  const economy = controller(), props = { economy, consumer: "builder", seconds: 7200 };
  let view = choose(props, open(props));
  confirmation(view).props.onClick(); view = render(props);
  assert.equal(confirmation(view).props.disabled, true);
  assert.match(renderToStaticMarkup(confirmation(view)), /Подтверждаем/);
  assert.equal(action(view, "legendary_fish").props.disabled, true);
  action(view, "legendary_fish").props.onClick(); confirmation(view).props.onClick();
  view.tree.props.onOpenChange(false); view = render(props);
  view.tree.props.onOpenChange(true); view = render(props);
  assert.equal(view.tree.props.open, false);
  assert.equal(economy.calls.length, 1);
  assert.equal(economy.snapshot.inventory.grilled_fish, 2);
});

test("a server rejection is shown beside the confirmation and keeps the selected dish retryable", () => {
  const economy = controller(), props = { economy, consumer: "builder", jobId: "construction-1" };
  economy.snapshot.jobs = [job()];
  let view = choose(props, open(props)); confirmation(view).props.onClick();
  economy.busy = true; render(props);
  economy.busy = false; economy.error = "Не удалось выдать обед."; render(props); view = render(props);
  assert.equal(confirmation(view).props.disabled, false);
  assert.equal(action(view, "grilled_fish").props["aria-pressed"], true);
  assert.ok(view.nodes.some(node => node.props.role === "status" && renderToStaticMarkup(node).includes(economy.error)));
  confirmation(view).props.onClick();
  assert.equal(economy.calls.length, 2);
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
    const economy = controller(), props = { economy, consumer: "hero", seconds: 3600 }, view = choose(props, open(props));
    const control = confirmation(view); mutate(economy); control.props.onClick(); assert.deepEqual(economy.calls, []);
  }
});

test("builder boost belongs to the exact active job and cannot feed a different construction from a preview", () => {
  for (const [construction, jobId, expected] of [[job(), undefined, true], [job(), "different", true], [job({ finishesAt: new Date(now).toISOString() }), "construction-1", true], [job({ meal: { itemId: "grilled_fish", consumer: "builder", speedBps: 1000 } }), "construction-1", true], [job(), "construction-1", false]]) {
    const economy = controller({ jobs: [construction] }), props = { economy, consumer: "builder", stationId: "workshop", jobId };
    assert.equal(Boolean(mealBoostReason(props)), expected);
    if (!expected) {
      const view = choose(props, open(props)); economy.snapshot.jobs = [job({ id: "replacement-job" })];
      confirmation(view).props.onClick(); assert.deepEqual(economy.calls, []);
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

test("25 percent speed preview explains the six-hour duration and actual saving before spending", () => {
  const economy = controller({ inventory: { fish_soup: 1 } });
  const props = { economy, consumer: "builder", seconds: 6 * 3600 };
  const view = choose(props, open(props), "fish_soup");
  const preview = view.nodes.find(node => node.props["data-meal-preview"] === "fish_soup");
  const markup = renderToStaticMarkup(preview);
  assert.match(markup, /\+25% скорости · время −20%/);
  assert.match(markup, /6 ч/);
  assert.match(markup, /4 ч 48 мин/);
  assert.match(markup, /Экономия 1 ч 12 мин/);
  assert.deepEqual(economy.calls, [], "the true time and saving are shown before confirmation");
});

test("active builder preview shows the saving on the remaining time rather than the original duration", () => {
  const economy = controller({ inventory: { fish_soup: 1 }, jobs: [job({
    startedAt: new Date(now - 3600_000).toISOString(), finishesAt: new Date(now + 5 * 3600_000).toISOString(),
  })] });
  const props = { economy, consumer: "builder", jobId: "construction-1" };
  const view = choose(props, open(props), "fish_soup");
  const preview = view.nodes.find(node => node.props["data-meal-preview"] === "fish_soup");
  const markup = renderToStaticMarkup(preview);
  assert.match(markup, /5 ч/);
  assert.match(markup, />4 ч</);
  assert.match(markup, /Экономия 1 ч</);
  assert.deepEqual(economy.calls, []);
});

test("confirmed feeding closes the picker and exposes the saved bonus without auto-starting a job", () => {
  const economy = controller(), props = { economy, consumer: "hero", seconds: 7200 };
  const view = choose(props, open(props)); confirmation(view).props.onClick();
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

test("saved next-route meal names the dish and shows the true time improvement with an explicit return action", () => {
  const economy = controller({ food: { heroMeal: "grilled_fish", builderMeal: null } }); hooks.reset();
  const meal = economy.snapshot.catalog.food.meals.find(value => value.itemId === "grilled_fish");
  const view = render({ economy, consumer: "hero", seconds: 7200 }), html = renderToStaticMarkup(view.tree);
  assert.match(html, /Жареная рыба/);
  assert.ok(html.includes(`+${meal.heroSpeedBps / 100}% скорости`));
  assert.match(html, /Для следующей вылазки/);
  const timer = view.nodes.find(node => node.props["data-meal-duration"] !== undefined);
  assert.match(renderToStaticMarkup(timer), /arrow-right/);
  assert.equal(view.nodes.filter(node => node.props["data-meal-return"] === "hero").length, 1);
  assert.match(html, /Забрать блюдо/);
  assert.deepEqual(economy.calls, []);
});

test("each unused meal returns exactly once through its consumer command and never changes local stock or food", () => {
  for (const consumer of ["hero", "builder"]) {
    const economy = controller({ food: { heroMeal: "grilled_fish", builderMeal: "legendary_fish" } });
    const before = structuredClone(economy.snapshot), props = { economy, consumer, isOnline: true };
    hooks.reset(); let view = render(props);
    const button = view.nodes.find(node => node.props["data-meal-return"] === consumer);
    assert.equal(button.props.disabled, false); assert.match(renderToStaticMarkup(button), /Забрать блюдо/);
    button.props.onClick(); button.props.onClick();
    assert.deepEqual(economy.calls, [["cancel_meal", consumer, 1, 0]]); assert.deepEqual(economy.snapshot, before);
    view = render(props);
    assert.equal(view.nodes.find(node => node.props["data-meal-return"] === consumer).props.disabled, true);
    assert.match(renderToStaticMarkup(view.tree), /Возвращаем/);
    economy.busy = true; render(props);
    economy.busy = false; economy.snapshot = { ...economy.snapshot, revision: 2,
      food: { ...economy.snapshot.food, [consumer === "hero" ? "heroMeal" : "builderMeal"]: null } };
    view = render(props);
    assert.equal(view.nodes.some(node => node.props["data-meal-return"]), false);
    assert.equal(economy.calls.length, 1);
  }
});

test("returning an unused meal respects connection, receipt, queue and confirmed snapshot guards", () => {
  for (const flags of [{ busy: true }, { uncertain: true }, { retryAt: now + 1 }, { pendingProductionCount: 1 },
    { directActionsAvailable: false }, { snapshotConfirmed: false }]) {
    const economy = controller({ food: { heroMeal: "grilled_fish", builderMeal: null } }, flags);
    const props = { economy, consumer: "hero", isOnline: true };
    hooks.reset(); const view = render(props), button = view.nodes.find(node => node.props["data-meal-return"]);
    assert.ok(mealReturnReason(props)); assert.equal(button.props.disabled, true); button.props.onClick(); assert.deepEqual(economy.calls, []);
  }
  const economy = controller({ food: { heroMeal: null, builderMeal: "grilled_fish" } });
  hooks.reset(); const view = render({ economy, consumer: "builder", isOnline: false });
  const button = view.nodes.find(node => node.props["data-meal-return"]);
  assert.equal(button.props.disabled, true); button.props.onClick(); assert.deepEqual(economy.calls, []);
  assert.match(renderToStaticMarkup(view.tree), /Подключитесь к интернету/);
});

test("an old return handler cannot return a changed owner, revision, dish or consumer", () => {
  for (const mutate of [
    economy => { economy.snapshot.ownerPublicId = "another-owner"; },
    economy => { economy.snapshot.revision++; },
    economy => { economy.snapshot.food.heroMeal = "legendary_fish"; },
    economy => { economy.snapshot.food.heroMeal = null; },
    economy => { economy.snapshotConfirmed = false; },
    economy => { economy.busy = true; },
    economy => { economy.uncertain = true; },
    economy => { economy.snapshot = null; },
  ]) {
    const economy = controller({ food: { heroMeal: "grilled_fish", builderMeal: null } }), props = { economy, consumer: "hero" };
    hooks.reset(); const button = render(props).nodes.find(node => node.props["data-meal-return"]);
    mutate(economy); button.props.onClick(); assert.deepEqual(economy.calls, []);
  }
  const economy = controller({ food: { heroMeal: "grilled_fish", builderMeal: "legendary_fish" } });
  hooks.reset(); const stale = render({ economy, consumer: "hero" }).nodes.find(node => node.props["data-meal-return"]);
  render({ economy, consumer: "builder" }); stale.props.onClick(); assert.deepEqual(economy.calls, []);
  hooks.reset(); const old = render({ economy, consumer: "hero" }).nodes.find(node => node.props["data-meal-return"]);
  const replacement = controller({ revision: 2, food: { heroMeal: "legendary_fish", builderMeal: null } });
  render({ economy: replacement, consumer: "hero" }); old.props.onClick(); assert.deepEqual(replacement.calls, []);
});

test("refused or rejected meal returns keep the saved portion and allow a later explicit retry", () => {
  const attempts = [], economy = controller({ food: { heroMeal: "grilled_fish", builderMeal: null } },
    { act: (...args) => { attempts.push(args); return attempts.length > 1; } });
  const props = { economy, consumer: "hero" }; hooks.reset();
  render(props).nodes.find(node => node.props["data-meal-return"]).props.onClick();
  let view = render(props); assert.match(renderToStaticMarkup(view.tree), /Не удалось отправить возврат блюда/);
  const button = view.nodes.find(node => node.props["data-meal-return"]); assert.equal(button.props.disabled, false); button.props.onClick();
  economy.busy = true; render(props); economy.busy = false; economy.error = "Сначала проверьте состояние хозяйства.";
  render(props); view = render(props);
  assert.equal(view.nodes.find(node => node.props["data-meal-return"]).props.disabled, false);
  assert.match(renderToStaticMarkup(view.tree), /Сначала проверьте состояние хозяйства/);
  assert.equal(economy.snapshot.food.heroMeal, "grilled_fish"); assert.equal(attempts.length, 2);
});

test("current work meals are used and never returnable even without an explicit construction job id", () => {
  for (const consumer of ["hero", "builder"]) {
    const economy = controller({ jobs: [job({ kind: consumer === "hero" ? "exploration" : "construction",
      meal: { itemId: "grilled_fish", consumer, speedBps: 1000 } })] });
    hooks.reset(); const view = render({ economy, consumer, seconds: 7200 }), html = renderToStaticMarkup(view.tree);
    assert.match(html, /Блюдо уже использовано/); assert.match(html, /Вернуть его нельзя/);
    assert.doesNotMatch(html, /Для следующей|Забрать блюдо/); assert.equal(view.nodes.some(node => node.type === "button"), false);
    assert.match(renderToStaticMarkup(view.nodes.find(node => node.props["data-meal-duration"] !== undefined)), /2 мин/);
    assert.deepEqual(economy.calls, []);
  }
});

test("legacy pending food beside an applied job stays separate and returns only the unused portion", () => {
  for (const consumer of ["hero", "builder"]) {
    const economy = controller({ food: { heroMeal: consumer === "hero" ? "legendary_fish" : null, builderMeal: consumer === "builder" ? "legendary_fish" : null },
      jobs: [job({ kind: consumer === "hero" ? "exploration" : "construction", meal: { itemId: "grilled_fish", consumer, speedBps: 1000 } })] });
    hooks.reset(); const view = render({ economy, consumer });
    assert.equal(view.tree.props["data-meal-applied"], "grilled_fish");
    assert.equal(view.nodes.find(node => node.props["data-meal-pending"]).props["data-meal-pending"], "legendary_fish");
    const button = view.nodes.find(node => node.props["data-meal-return"]); assert.equal(button.props.disabled, false);
    button.props.onClick(); assert.deepEqual(economy.calls, [["cancel_meal", consumer, 1, 0]]);
    assert.equal(economy.snapshot.jobs[0].meal.itemId, "grilled_fish");
  }
});

test("feeding during construction previews remaining work and shows the confirmed bonus on that current job", () => {
  const economy = controller({ jobs: [job()] }), props = { economy, consumer: "builder", jobId: "construction-1" };
  let view = choose(props, open(props));
  assert.ok(view.nodes.some(node => node.type === "p" && node.props.children === "Ускорит оставшееся время"));
  assert.doesNotMatch(renderToStaticMarkup(view.nodes.find(node => node.props["data-meal-preview"])), /Для следующей/);
  confirmation(view).props.onClick(); assert.deepEqual(economy.calls, [["feed_builder", "grilled_fish", 1, 0]]);
  economy.busy = true; render(props);
  economy.busy = false; economy.snapshot = { ...economy.snapshot, revision: 2,
    jobs: [job({ finishesAt: new Date(now + 60_000).toISOString(), meal: { itemId: "grilled_fish", consumer: "builder", speedBps: 1000 } })] };
  view = render(props); const html = renderToStaticMarkup(view.tree);
  assert.match(html, /текущая стройка/); assert.match(html, /Блюдо уже использовано в этой стройке/);
  assert.doesNotMatch(html, /Для следующей|Забрать блюдо/);
  assert.equal(economy.snapshot.food.builderMeal, null);
});

test("browser connectivity blocks a pending meal return even when the surrounding page has no online prop", t => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: { onLine: false } });
  t.after(() => { if (descriptor) Object.defineProperty(globalThis, "navigator", descriptor); else delete globalThis.navigator; });
  const economy = controller({ food: { heroMeal: "grilled_fish", builderMeal: null } });
  hooks.reset(); const view = render({ economy, consumer: "hero" }), button = view.nodes.find(node => node.props["data-meal-return"]);
  assert.equal(button.props.disabled, true); button.props.onClick(); assert.deepEqual(economy.calls, []);
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
  const props = { economy, consumer: "hero", seconds: 7200 }, view = choose(props, open(props));
  confirmation(view).props.onClick();
  const refused = render(props);
  assert.equal(refused.tree.props.open, true);
  assert.equal(refused.nodes.some(node => node.props.role === "status" && renderToStaticMarkup(node).includes("Обед не отправлен")), true);
  confirmation(refused).props.onClick();
  confirmation(refused).props.onClick();
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
