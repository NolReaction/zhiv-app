import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { Children, createElement, isValidElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const hooksId = "virtual:campfire-catalog-hooks";
const vite = await createServer({ appType: "custom", configFile: false, root, cacheDir: `/tmp/zhiv-campfire-groups-${process.pid}`,
  resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false },
  plugins: [{ name: "campfire-catalog-hooks", enforce: "pre",
    resolveId(id) { if (id === hooksId) return `\0${id}`; },
    load(id) { if (id === `\0${hooksId}`) return `
      let slots = [], cursor = 0;
      export function reset() { slots = []; cursor = 0; }
      export function render() { cursor = 0; }
      export function useState(initial) { const index = cursor++; if (!(index in slots)) slots[index] = typeof initial === "function" ? initial() : initial;
        return [slots[index], value => { slots[index] = typeof value === "function" ? value(slots[index]) : value; }]; }
      export function useRef(initial) { const index = cursor++; return slots[index] ??= { current: initial }; }
      export function useEffect() {}
      export function useId() { return "campfire-group-test"; }
    `; },
    transform(source, id) { if (id.endsWith("/features/economy/ui/stations/world-object-menu.tsx")) return source.replace('from "react";', `from "${hooksId}";`); },
  }],
});
after(() => vite.close());
const hooks = await vite.ssrLoadModule(hooksId);
const { CampfireRecipeCatalog, WorldObjectMenu } = await vite.ssrLoadModule("/features/economy/ui/stations/world-object-menu.tsx");
const { WorldProductionCard } = await vite.ssrLoadModule("/features/economy/ui/production/world-production-card.tsx");
const { worldRecipeGroups } = await vite.ssrLoadModule("/features/economy/ui/stations/world-recipe-groups.ts");
const { campfireDurationMatches, campfireRecipeGroups } = await vite.ssrLoadModule("/features/economy/ui/food/campfire-recipe-groups.ts");
const { economyCatalog } = await vite.ssrLoadModule("/features/economy/domain/model.ts");
const now = Date.parse("2026-10-14T23:45:00Z");

function controller(overrides = {}) {
  return { snapshot: { ownerPublicId: "ME", revision: 1, serverTime: new Date(now).toISOString(), catalog: structuredClone(economyCatalog),
    wallet: { coins: 200, pearls: 0 }, inventory: {}, buildings: { home: 5, dryer: 5, garden: 5, kiln: 5, woodlot: 5, workshop: 5, quarry: 5, warehouse: 5 },
    jobs: [], progression: { recipes: { cook_grilled_fish: 1, cook_compote: 1 } }, storage: { capacity: 500, available: 500, used: 0, reserved: 0 }, ...overrides },
    now, busy: false, uncertain: false, retryAt: 0, error: null, act() { assert.fail("Reading or filtering recipes must never send a command"); }, retry() {} };
}
const recipes = economy => economy.snapshot.catalog.recipes.filter(recipe => recipe.buildingId === "dryer");
function elements(tree) {
  const result = [];
  function visit(node) { if (!isValidElement(node)) return; result.push(node); Children.forEach(node.props.children, visit); }
  visit(tree); return result;
}
function catalog(economy, focusedRecipeId = null) {
  hooks.render();
  const tree = CampfireRecipeCatalog({ economy, recipes: recipes(economy), focusedRecipeId });
  const nodes = elements(tree);
  return { tree, html: renderToStaticMarkup(tree), nodes,
    filter: id => nodes.find(node => node.type === "button" && node.props["data-cooking-duration"] === id),
    cards: nodes.filter(node => node.type === WorldProductionCard),
    ids: nodes.filter(node => node.type === WorldProductionCard).map(node => node.props.recipe.id) };
}
function menu(economy, extra = {}) {
  hooks.reset();
  return renderToStaticMarkup(createElement(WorldObjectMenu, { selection: { place: "campfire", objectId: "campfire.position", x: 195, y: 380, viewportWidth: 390, viewportHeight: 844 }, economy, onClose() {}, ...extra }));
}

test("campfire sections include every selected product once and leave the catalogue untouched", () => {
  const economy = controller(), products = worldRecipeGroups(economy.snapshot, recipes(economy)), before = structuredClone(products);
  const groups = campfireRecipeGroups(products, "all");
  assert.deepEqual(groups.map(group => group.id), ["fish", "drinks", "desserts", "provisions"]);
  assert.equal(products.length, 15);
  assert.deepEqual(groups.map(group => group.recipes.length), [6, 3, 3, 3]);
  assert.deepEqual(groups.flatMap(group => group.recipes.map(product => product.key)).sort(), products.map(product => product.key).sort());
  for (const group of groups) assert.deepEqual(group.recipes.map(product => product.recipe.seconds), group.recipes.map(product => product.recipe.seconds).toSorted((left, right) => left - right));
  assert.deepEqual(products, before);
});

test("cooking time boundaries put each timer in exactly one filter without rounding", () => {
  for (const [seconds, expected] of [[1, "short"], [900, "short"], [901, "medium"], [3600, "medium"], [3601, "long"], [7200, "long"]]) {
    assert.equal(campfireDurationMatches(seconds, "all"), true);
    assert.deepEqual(["short", "medium", "long"].filter(filter => campfireDurationMatches(seconds, filter)), [expected]);
  }
});

test("mixed or new outputs remain visible once in the fallback section", () => {
  const mixed = { key: "mixed", recipe: { seconds: 180, rewards: { grilled_fish: 1, berry_compote: 1 } }, methods: [] };
  const added = { key: "new", recipe: { seconds: 1800, rewards: { new_food: 1 } }, methods: [] };
  const groups = campfireRecipeGroups([mixed, added], "all");
  assert.equal(groups.length, 1);
  assert.equal(groups[0].label, "Другие заготовки");
  assert.deepEqual(groups[0].recipes.map(product => product.key), ["mixed", "new"]);
});

test("cooking filters show logical blocks and exact current product cards", () => {
  hooks.reset(); const economy = controller(), before = structuredClone(economy.snapshot);
  let view = catalog(economy);
  assert.equal(view.filter("all").props["aria-pressed"], true);
  for (const name of ["Рыбные блюда", "Напитки", "Ягодные десерты", "Походные припасы"]) assert.ok(view.html.includes(name));
  view.filter("short").props.onClick(); view = catalog(economy);
  assert.deepEqual(view.ids, ["cook_grilled_fish", "cook_compote", "cook_strawberry_compote", "cook_blueberry_compote"]);
  assert.doesNotMatch(view.html, /data-cooking-group="desserts"|data-cooking-group="provisions"/);
  view.filter("medium").props.onClick(); view = catalog(economy);
  assert.ok(view.ids.includes("cook_hearty_fish")); assert.ok(view.ids.includes("prepare_trail_ration"));
  assert.ok(!view.ids.includes("cook_epic_fish"));
  view.filter("long").props.onClick(); view = catalog(economy);
  assert.deepEqual(view.ids, ["cook_epic_fish", "cook_legendary_fish", "cook_cranberry_glaze"]);
  view.filter("all").props.onClick(); view = catalog(economy);
  assert.equal(view.ids.length, 15); assert.equal(new Set(view.ids).size, 15);
  assert.deepEqual(economy.snapshot, before);
});

test("a changed source target reveals its recipe outside the filter without consuming", () => {
  hooks.reset(); const economy = controller();
  let view = catalog(economy); view.filter("short").props.onClick();
  view = catalog(economy, "cook_legendary_fish");
  assert.equal(view.filter("all").props["aria-pressed"], true);
  const focused = view.cards.find(card => card.props.recipe.id === "cook_legendary_fish");
  assert.equal(focused.props.focused, true);
  view.filter("medium").props.onClick(); view = catalog(economy, "cook_legendary_fish");
  assert.equal(view.filter("medium").props["aria-pressed"], true);
  assert.ok(!view.ids.includes("cook_legendary_fish"), "a player can intentionally filter after source navigation");
  view = catalog(economy, "cook_compote");
  assert.equal(view.filter("all").props["aria-pressed"], true);
  assert.equal(view.cards.find(card => card.props.recipe.id === "cook_compote").props.focused, true);
});

test("a target already inside the chosen filter keeps that filter and rejects foreign IDs", () => {
  hooks.reset(); const economy = controller();
  let view = catalog(economy); view.filter("short").props.onClick();
  view = catalog(economy, "cook_compote");
  assert.equal(view.filter("short").props["aria-pressed"], true);
  for (const id of ["missing_recipe", "make_planks"]) {
    view = catalog(economy, id);
    assert.equal(view.filter("short").props["aria-pressed"], true);
    assert.ok(view.cards.every(card => !card.props.focused));
  }
});

test("a locked source recipe can be read while unrelated future dishes stay hidden", () => {
  hooks.reset(); const economy = controller({ buildings: { home: 1, dryer: 1, garden: 1, warehouse: 1 } });
  const ordinary = catalog(economy);
  assert.ok(!ordinary.ids.includes("cook_legendary_fish"));
  const preview = catalog(economy, "cook_legendary_fish");
  assert.ok(preview.ids.includes("cook_legendary_fish"));
  assert.ok(!preview.ids.includes("cook_epic_fish"));
  assert.match(preview.html, /data-recipe="cook_legendary_fish"[^>]*data-recipe-focused="true"[^>]*data-blocked="true"/);
  assert.match(preview.html, /data-item-icon="fish_legendary"/);
});

test("the level-zero campfire keeps a targeted locked dish visible with its building requirement", () => {
  hooks.reset(); const economy = controller({ buildings: { home: 1, dryer: 0, garden: 1, warehouse: 1 } });
  const before = structuredClone(economy.snapshot);
  for (const target of [null, "cook_grilled_fish", "cook_compote", "cook_legendary_fish"]) {
    const view = catalog(economy, target);
    const future = target && target !== "cook_grilled_fish";
    assert.deepEqual(view.ids, future ? ["cook_grilled_fish", target] : ["cook_grilled_fish"]);
    assert.equal(view.cards[0].props.focused, target === "cook_grilled_fish");
    if (future) {
      assert.equal(view.cards.find(card => card.props.recipe.id === target).props.focused, true);
      assert.match(view.html, /data-recipe-access/);
      assert.match(view.html, /Доступно с [1-5] уровня костра/);
      assert.match(view.html, /data-blocked="true"/);
    }
    assert.doesNotMatch(view.html, /data-cooking-duration=|Сначала обустройте/);
    assert.match(view.html, /На костре уже можно жарить рыбу/);
  }
  assert.deepEqual(economy.snapshot, before);
});

test("an empty duration result explains how to restore the available kitchen", () => {
  hooks.reset(); const economy = controller({ buildings: { home: 1, dryer: 1, garden: 1, warehouse: 1 } });
  let view = catalog(economy); view.filter("long").props.onClick(); view = catalog(economy);
  assert.equal(view.ids.length, 0); assert.match(view.html, /Нет рецептов с таким временем/);
  view.filter("all").props.onClick(); view = catalog(economy);
  assert.ok(view.ids.includes("cook_grilled_fish"));
});

test("running slots stay before the entire filterable catalogue and focused source", () => {
  const economy = controller({ jobs: [{ id: "cooking-now", kind: "production", targetId: "dryer", recipeId: "cook_compote", quantity: 1,
    startedAt: new Date(now - 30_000).toISOString(), finishesAt: new Date(now + 150_000).toISOString(), rewards: { berry_compote: 1 }, cost: { coins: 0, items: { berries: 2 } } }] });
  const html = menu(economy, { initialRecipeId: "cook_legendary_fish" });
  assert.match(html, /data-job-id="cooking-now"/);
  assert.ok(html.indexOf('data-production-slots="dryer"') < html.indexOf("data-campfire-catalog"));
  assert.match(html, /data-recipe="cook_legendary_fish"[^>]*data-recipe-focused="true"/);
  assert.match(html, /data-section-guide-target="workshop-recipes"/);
  assert.doesNotMatch(html, /data-recipe-preparation|Способ производства/);
});

test("the campfire catalogue does not replace other station product lists", () => {
  const economy = controller(); hooks.reset();
  const html = renderToStaticMarkup(createElement(WorldObjectMenu, { selection: { place: "workshop", objectId: "workshop.position", x: 195, y: 380, viewportWidth: 390, viewportHeight: 844 }, economy, onClose() {} }));
  assert.match(html, /data-recipe="make_planks"/);
  assert.doesNotMatch(html, /data-campfire-catalog|data-cooking-duration|Время приготовления/);
});
