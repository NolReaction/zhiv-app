import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { Children, isValidElement } from "react";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false } });
const { worldUpgradeUnlocks, WorldUpgradeContent } = await vite.ssrLoadModule("/features/economy/ui/construction/world-upgrade-dialog.tsx");
const { economyCatalog } = await vite.ssrLoadModule("/features/economy/domain/model.ts");
const { economyBuilderStatus } = await vite.ssrLoadModule("/features/economy/domain/builder-status.ts");
const { mealDuration } = await vite.ssrLoadModule("/features/economy/domain/food.ts");
const { worldDuration } = await vite.ssrLoadModule("/features/economy/ui/shared/world-stations.ts");
after(() => vite.close());

function unlocks(stationId, level, catalog = economyCatalog) {
  const target = catalog.buildings.find(building => building.id === stationId).levels.find(target => target.level === level);
  return worldUpgradeUnlocks({ catalog }, stationId, target);
}

test("house 2 explains the mine, workshop kiln, exploration and player market together", () => {
  const result = unlocks("home", 2);
  assert.ok(result.upgrades.some(target => target.stationId === "quarry" && target.level === 1));
  assert.ok(result.upgrades.some(target => target.stationId === "kiln" && target.level === 1));
  assert.ok(result.recipes.some(recipe => recipe.id === "smelt_iron"));
  assert.ok(result.routes.some(route => route.id === "cave"));
  assert.equal(result.market, true);
  assert.ok(!result.upgrades.some(target => target.stationId === "home"));
  assert.ok(!result.upgrades.some(target => target.level === 3));
  assert.equal(unlocks("home", 3).market, false);
});

test("equipment upgrades include their recipes and dependent world progression", () => {
  const result = unlocks("workshop", 2);
  assert.deepEqual(result.recipes.map(recipe => recipe.id), ["make_metal_parts", "weave_cloth", "workshop_overnight"]);
  assert.ok(result.routes.some(route => route.id === "old_woodland"));
  assert.ok(result.upgrades.some(target => target.stationId === "home" && target.level === 3));
  assert.equal(result.market, false);
  assert.deepEqual(unlocks("garden", 2).recipes.map(recipe => recipe.id), ["grow_berries_large", "garden_fiber"]);
});

test("pantry development has real dependent upgrades even though it has no recipes", () => {
  const result = unlocks("warehouse", 2);
  assert.equal(result.recipes.length, 0);
  assert.equal(result.routes.length, 0);
  assert.ok(result.upgrades.some(target => target.stationId === "home" && target.level === 3));
  assert.ok(!result.upgrades.some(target => target.stationId === "warehouse"));
});

test("the highest catalog requirement wins, so a recipe is not promised one level too early", () => {
  const catalog = structuredClone(economyCatalog);
  const recipe = catalog.recipes.find(recipe => recipe.id === "grow_berries_large");
  recipe.requiredBuildings.home = 3;
  assert.ok(!unlocks("home", 2, catalog).recipes.some(entry => entry.id === recipe.id));
  assert.ok(unlocks("home", 3, catalog).recipes.some(entry => entry.id === recipe.id));
});

const now = Date.parse("2026-10-06T12:00:00Z");
const construction = { id: "building-home", kind: "construction", targetId: "home", targetLevel: 2,
  startedAt: new Date(now - 60_000).toISOString(), finishesAt: new Date(now + 30_000).toISOString() };
function economy(overrides = {}) {
  return { snapshot: { catalog: economyCatalog, buildings: { home: 2, warehouse: 1, workshop: 1 }, jobs: [],
    inventory: Object.fromEntries(economyCatalog.items.map(item => [item.id, 10000])), wallet: { coins: 1_000_000, pearls: 1000 } },
    busy: false, uncertain: false, now, retryAt: 0, act() {}, ...overrides };
}
function elements(tree) {
  const found = [];
  const visit = element => {
    if (!isValidElement(element)) return;
    found.push(element); Children.forEach(element.props.children, visit);
  };
  visit(tree); return found;
}
function content(controller, navigation) {
  return elements(WorldUpgradeContent({ stationId: "warehouse", economy: controller, navigation, onClose() {} }));
}
const startButton = nodes => nodes.find(element => element.type === "button" && element.props.className?.includes("confirm"));

test("pending builder food quotes the server speed formula without spending or applying it twice", () => {
  const controller = economy(), catalog = structuredClone(economyCatalog);
  const target = catalog.buildings.find(building => building.id === "warehouse").levels.find(level => level.level === 2);
  // A duration where dividing by 1.1 and subtracting 10% visibly differ.
  target.seconds = 6600;
  controller.snapshot.catalog = catalog;
  controller.snapshot.food = { heroMeal: "hearty_fish", builderMeal: null };
  let nodes = content(controller);
  const quote = nodes => nodes.find(element => element.type === "span" && element.props.className?.includes("duration"));
  const value = nodes => elements(quote(nodes)).find(element => element.type === "strong").props.children;
  assert.equal(value(nodes), "1 ч 50 мин", "the hero's pending food cannot accelerate construction");
  controller.snapshot.food.builderMeal = "grilled_fish";
  const before = structuredClone(controller.snapshot);
  const expected = worldDuration(mealDuration(target.seconds, 1000));
  assert.equal(expected, "1 ч 40 мин");
  assert.notEqual(expected, worldDuration(Math.ceil(target.seconds * 0.9)));
  for (let render = 0; render < 2; render++) {
    nodes = content(controller);
    assert.equal(value(nodes), expected);
    assert.equal(elements(quote(nodes)).find(element => element.type === "small").props.children, "Сыт · скорость +10%");
    assert.equal(startButton(nodes).props.disabled, false);
  }
  assert.deepEqual(controller.snapshot, before, "previewing food never consumes it or mutates the base duration");
});

test("builder status counts unclaimed construction only, including a finished timer", () => {
  const state = economy().snapshot;
  assert.equal(economyBuilderStatus(state, now), null);
  state.jobs = [{ ...construction, kind: "production" }, { ...construction, kind: "exploration" }];
  assert.equal(economyBuilderStatus(state, now), null);
  state.jobs.push(construction);
  const before = structuredClone(state.jobs);
  assert.equal(economyBuilderStatus(state, now).seconds, 30);
  assert.equal(economyBuilderStatus(state, now).ready, false);
  assert.equal(economyBuilderStatus(state, now + 30_000).ready, true);
  assert.equal(economyBuilderStatus(state, now + 30_000).seconds, 0);
  assert.equal(economyBuilderStatus(state, now).stationId, "home");
  assert.equal(economyBuilderStatus(state, now).stationName, "Дом Мохлика");
  assert.deepEqual(state.jobs, before, "displaying a ready builder cannot claim or delete paid jobs");
});

test("busy builder links to the paid construction and disabled callbacks cannot start a second job", () => {
  for (const time of [now, now + 30_000]) {
    const calls = [], opened = [], controller = economy({ now: time, act: (...args) => calls.push(args) });
    controller.snapshot.jobs = [construction];
    const nodes = content(controller, { canOpen: () => true, open: id => opened.push(id) });
    const status = nodes.find(element => element.props["data-builder-status"]);
    assert.equal(status.props["data-builder-status"], time === now ? "working" : "ready");
    const link = nodes.find(element => element.props["aria-label"] === "К текущей стройке: Дом Мохлика");
    link.props.onClick(); assert.deepEqual(opened, ["home"]);
    const start = startButton(nodes);
    assert.equal(start.props.disabled, true); start.props.onClick();
    assert.deepEqual(calls, []);
  }
});

test("upgrade callback rechecks the latest snapshot and transport lock even without a rerender", () => {
  for (const patch of [
    controller => { controller.snapshot = { ...controller.snapshot, jobs: [construction] }; },
    controller => { controller.busy = true; },
    controller => { controller.uncertain = true; },
    controller => { controller.retryAt = now + 1000; },
    controller => { controller.snapshot = null; },
  ]) {
    const calls = [], controller = economy({ act: (...args) => calls.push(args) });
    const start = startButton(content(controller));
    assert.equal(start.props.disabled, false);
    patch(controller); start.props.onClick(); assert.deepEqual(calls, []);
  }
  const calls = [], controller = economy({ act: (...args) => calls.push(args) });
  startButton(content(controller)).props.onClick();
  assert.deepEqual(calls, [["start_construction", "warehouse"]]);
});
