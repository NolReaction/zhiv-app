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
      let slots = [], cursor = 0, changed = false;
      export function reset() { slots = []; cursor = 0; changed = false; }
      export function render() { cursor = 0; changed = false; }
      export function needsRender() { return changed; }
      export function useState(initial) { const index = cursor++; if (!(index in slots)) slots[index] = typeof initial === "function" ? initial() : initial;
        return [slots[index], value => { const next = typeof value === "function" ? value(slots[index]) : value; changed ||= !Object.is(next, slots[index]); slots[index] = next; }]; }
      export function useRef(initial) { const index = cursor++; return slots[index] ??= { current: initial }; }
      export function useEffect() {}
      export function useId() { return "campfire-group-test"; }
    `; },
    transform(source, id) { if (id.endsWith("/features/economy/ui/food/world-cookbook.tsx")) return source.replace('from "react";', `from "${hooksId}";`); },
  }],
});
after(() => vite.close());
const hooks = await vite.ssrLoadModule(hooksId);
const { WorldObjectMenu } = await vite.ssrLoadModule("/features/economy/ui/stations/world-object-menu.tsx");
const { WorldCookbook } = await vite.ssrLoadModule("/features/economy/ui/food/world-cookbook.tsx");
const { WorldProductionCard } = await vite.ssrLoadModule("/features/economy/ui/production/world-production-card.tsx");
const { worldRecipeGroups } = await vite.ssrLoadModule("/features/economy/ui/stations/world-recipe-groups.ts");
const { campfireDurationMatches, campfireRecipeGroups } = await vite.ssrLoadModule("/features/economy/ui/food/campfire-recipe-groups.ts");
const { economyCatalog } = await vite.ssrLoadModule("/features/economy/domain/model.ts");
const now = Date.parse("2026-10-14T23:45:00Z");

function controller(overrides = {}) {
  return { snapshot: { ownerPublicId: "ME", revision: 1, serverTime: new Date(now).toISOString(), catalog: structuredClone(economyCatalog),
    wallet: { coins: 200, pearls: 0 }, inventory: {}, buildings: { home: 5, dryer: 5, garden: 5, kiln: 5, woodlot: 5, workshop: 5, quarry: 5, warehouse: 5 },
    familiarItems: economyCatalog.items.map(item => item.id),
    jobs: [], progression: { recipes: { cook_grilled_fish: 1, cook_compote: 1 }, skills: { version: 1, cookingSeconds: economyCatalog.skills.levels[2].requiredSeconds } }, storage: { capacity: 500, available: 500, used: 0, reserved: 0 }, ...overrides },
    now, busy: false, uncertain: false, retryAt: 0, error: null, act() { assert.fail("Reading or filtering recipes must never send a command"); }, retry() {} };
}
const recipes = economy => economy.snapshot.catalog.recipes.filter(recipe => recipe.buildingId === "dryer");
function elements(tree) {
  const result = [];
  function visit(node) { if (!isValidElement(node)) return; result.push(node); Children.forEach(node.props.children, visit); }
  visit(tree); return result;
}
const navigation = { canOpen() { return false; }, open() { assert.fail("Filtering never navigates to another station"); } };
function catalog(economy, focusedRecipeId = null, navigationRequest = 0) {
  let tree, attempts = 0;
  do {
    assert.ok(attempts++ < 4, "source navigation settles without a render loop");
    hooks.render();
    tree = WorldCookbook({ economy, recipes: recipes(economy), focusedRecipeId, navigationRequest, navigation });
  } while (hooks.needsRender());
  const nodes = elements(tree);
  return { tree, html: renderToStaticMarkup(tree), nodes,
    tab: id => nodes.find(node => node.props.role === "tab" && node.props.id.endsWith(`-${id}`)),
    search: nodes.find(node => node.type === "input" && node.props.type === "search"),
    available: nodes.find(node => node.type === "input" && node.props.type === "checkbox"),
    rarity: nodes.find(node => node.type === "select"),
    queue: nodes.find(node => node.type === "button" && node.props["data-cookbook-queue"]),
    cards: nodes.filter(node => node.type === WorldProductionCard),
    ids: nodes.filter(node => node.props["data-cookbook-recipe"]).map(node => node.props["data-cookbook-recipe"]) };
}
function menu(economy, extra = {}) {
  hooks.reset();
  return renderToStaticMarkup(createElement(WorldObjectMenu, { selection: { place: "campfire", objectId: "campfire.position", x: 195, y: 380, viewportWidth: 390, viewportHeight: 844 }, economy, onClose() {}, ...extra }));
}

test("campfire sections include every selected product once and leave the catalogue untouched", () => {
  const economy = controller(), products = worldRecipeGroups(economy.snapshot, recipes(economy)), before = structuredClone(products);
  const groups = campfireRecipeGroups(products, "all");
  assert.deepEqual(groups.map(group => group.id), ["fish", "drinks", "desserts", "provisions"]);
  assert.equal(products.length, 30);
  assert.deepEqual(groups.map(group => group.recipes.length), [15, 5, 5, 5]);
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

test("cookbook tabs show every product once and filters use real fish rarity and ingredients", () => {
  hooks.reset(); const economy = controller({ inventory: { berries: 2 } }), before = structuredClone(economy.snapshot);
  let view = catalog(economy);
  assert.equal(view.tab("fish").props["aria-selected"], true);
  for (const name of ["Рыбные блюда", "Напитки", "Десерты", "Припасы"]) assert.ok(view.html.includes(name));
  const seen = [];
  for (const [category, count] of [["fish", 13], ["drinks", 5], ["desserts", 4], ["provisions", 4], ["discoveries", 4]]) {
    view.tab(category).props.onClick(); view = catalog(economy);
    assert.equal(view.tab(category).props["aria-selected"], true);
    assert.equal(view.ids.length, count);
    assert.match(view.html, new RegExp(`data-cooking-group="${category}"`));
    seen.push(...view.ids);
  }
  assert.deepEqual(seen.toSorted(), recipes(economy).map(recipe => recipe.id).toSorted());
  assert.equal(new Set(seen).size, 30);
  view.tab("fish").props.onClick(); view = catalog(economy);
  view.rarity.props.onChange({ target: { value: "common" } }); view = catalog(economy);
  assert.deepEqual(view.ids.toSorted(), ["cook_fish_soup", "cook_forest_pan", "cook_grilled_fish", "cook_grilled_silverfin"]);
  assert.doesNotMatch(view.html, /data-cookbook-rarity="(?:uncommon|rare|epic|legendary)"/);
  view.tab("drinks").props.onClick(); view = catalog(economy);
  view.available.props.onChange({ target: { checked: true } }); view = catalog(economy);
  assert.deepEqual(view.ids, ["cook_compote"]);
  view.available.props.onChange({ target: { checked: false } }); view = catalog(economy);
  assert.equal(view.ids.length, 5);
  assert.deepEqual(economy.snapshot, before);
});

test("experiments search only their clues until successful collection, then move to their dish category", () => {
  hooks.reset(); const economy = controller(), secret = economy.snapshot.catalog.recipes.find(recipe => recipe.id === "experiment_river_aspic");
  let view = catalog(economy);
  view.tab("discoveries").props.onClick(); view = catalog(economy);
  view.search.props.onChange({ target: { value: secret.name } }); view = catalog(economy);
  assert.deepEqual(view.ids, [], "the real dish name cannot discover a hidden recipe through search");
  view.search.props.onChange({ target: { value: secret.experiment.title } }); view = catalog(economy);
  assert.deepEqual(view.ids, [secret.id]);
  economy.snapshot.progression.recipes[secret.id] = 1;
  view.search.props.onChange({ target: { value: "" } }); view = catalog(economy);
  assert.ok(!view.ids.includes(secret.id));
  view.tab("fish").props.onClick(); view = catalog(economy);
  assert.ok(view.ids.includes(secret.id), "a discovered dish from prepared soup remains in the book");
  assert.match(view.html, /Блюда из заготовок/);
});

test("source navigation clears conflicting filters and a repeated target reopens its detail", () => {
  hooks.reset(); const economy = controller();
  let view = catalog(economy);
  view.rarity.props.onChange({ target: { value: "common" } });
  view.available.props.onChange({ target: { checked: true } });
  view.search.props.onChange({ target: { value: "несуществующий рецепт" } });
  view = catalog(economy, "cook_legendary_fish");
  assert.equal(view.rarity.props.value, "all"); assert.equal(view.available.props.checked, false); assert.equal(view.search.props.value, "");
  assert.deepEqual(view.cards.map(card => card.props.recipe.id), ["cook_legendary_fish"]);
  assert.equal(view.cards[0].props.focused, true);
  view.rarity.props.onChange({ target: { value: "common" } }); view = catalog(economy, "cook_legendary_fish");
  assert.equal(view.rarity.props.value, "common");
  assert.ok(!view.ids.includes("cook_legendary_fish"), "the player can filter again after source navigation");
  view = catalog(economy, "cook_compote");
  assert.equal(view.tab("drinks").props["aria-selected"], true);
  const bottle = view.nodes.find(node => node.props["data-cookbook-recipe"] === "bottle_compote");
  bottle.props.onClick({ currentTarget: null }); view = catalog(economy, "cook_compote");
  assert.equal(view.cards[0].props.recipe.id, "bottle_compote");
  view = catalog(economy, "cook_compote", 1);
  assert.equal(view.cards[0].props.recipe.id, "cook_compote");
  assert.equal(view.cards[0].props.focused, true);
});

test("an unchanged source preserves manual filters while foreign station targets never open a recipe", () => {
  hooks.reset(); const economy = controller();
  let view = catalog(economy, "cook_compote");
  view.search.props.onChange({ target: { value: "Малиновый" } }); view = catalog(economy, "cook_compote");
  assert.equal(view.search.props.value, "Малиновый"); assert.deepEqual(view.ids, ["cook_compote"]);
  for (const id of ["missing_recipe", "make_planks"]) {
    view = catalog(economy, id);
    assert.equal(view.search.props.value, "");
    assert.equal(view.tab("fish").props["aria-selected"], true);
    assert.deepEqual(view.cards, []);
    assert.ok(!view.ids.includes(id));
    assert.match(view.html, /data-cookbook-view="recipes"/);
  }
});

test("future dishes stay hidden even through an explicit source link", () => {
  hooks.reset(); const economy = controller({ buildings: { home: 1, dryer: 1, garden: 1, warehouse: 1 } });
  const before = structuredClone(economy.snapshot), ordinary = catalog(economy);
  assert.ok(!ordinary.ids.includes("cook_legendary_fish"));
  assert.ok(!ordinary.ids.includes("cook_epic_fish"));
  const preview = catalog(economy, "cook_legendary_fish");
  assert.deepEqual(preview.cards, []);
  assert.doesNotMatch(preview.html, /data-recipe="cook_legendary_fish"|data-item-icon="fish_legendary"|Легендарное рыбное жаркое/);
  assert.deepEqual(economy.snapshot, before);
});

test("the level-zero cookbook starts with fish and introduces compote after improving the campfire", () => {
  const economy = controller({ buildings: { home: 1, dryer: 0, garden: 1, warehouse: 1 }, familiarItems: [], progression: { recipes: {}, routes: {} } });
  const before = structuredClone(economy.snapshot);
  for (const target of [null, "cook_grilled_fish", "cook_compote", "cook_legendary_fish"]) {
    hooks.reset(); const view = catalog(economy, target);
    assert.equal(view.cards.length, target === "cook_grilled_fish" ? 1 : 0);
    assert.deepEqual(view.ids, ["cook_grilled_fish"]);
    assert.doesNotMatch(view.html, /data-recipe-access|Доступно с [1-5] уровня костра/);
    assert.match(view.html, /data-campfire-catalog/);
  }
  assert.deepEqual(economy.snapshot, before);
  economy.snapshot.buildings.dryer = 1;
  hooks.reset(); const view = catalog(economy, "cook_compote");
  assert.equal(view.cards[0].props.recipe.id, "cook_compote");
  assert.doesNotMatch(view.html, /data-recipe-access/);
});

test("an empty search explains how to recover and clearing it restores the selected category", () => {
  hooks.reset(); const economy = controller({ buildings: { home: 1, dryer: 1, garden: 1, warehouse: 1 } });
  let view = catalog(economy);
  const before = [...view.ids];
  view.search.props.onChange({ target: { value: "несуществующий рецепт" } }); view = catalog(economy);
  assert.equal(view.ids.length, 0); assert.match(view.html, /Нет подходящих рецептов. Попробуйте другой раздел или фильтр/);
  view.search.props.onChange({ target: { value: "" } }); view = catalog(economy);
  assert.deepEqual(view.ids, before);
});

test("running slots stay in their own queue and source navigation opens detail without hiding the queue control", () => {
  const economy = controller({ jobs: [{ id: "cooking-now", kind: "production", targetId: "dryer", recipeId: "cook_compote", quantity: 1,
    startedAt: new Date(now - 30_000).toISOString(), finishesAt: new Date(now + 150_000).toISOString(), rewards: { berry_compote: 1 }, cost: { coins: 0, items: { berries: 2 } } }] });
  hooks.reset(); let view = catalog(economy);
  assert.match(view.html, /data-cookbook-view="queue"/); assert.match(view.html, /data-job-id="cooking-now"/);
  view = catalog(economy, "cook_legendary_fish");
  assert.match(view.html, /data-cookbook-view="detail"/);
  assert.doesNotMatch(view.html, /data-production-slots=/);
  assert.match(view.html, /data-recipe="cook_legendary_fish"[^>]*data-recipe-focused="true"/);
  assert.match(view.html, /data-section-guide-target="workshop-recipes"/);
  view.queue.props.onClick(); view = catalog(economy, "cook_legendary_fish");
  assert.match(view.html, /data-job-id="cooking-now"/); assert.match(view.html, /data-production-slots="dryer"/);
  assert.equal(view.cards.length, 0);
  view.queue.props.onClick(); view = catalog(economy, "cook_legendary_fish");
  assert.equal(view.cards[0].props.recipe.id, "cook_legendary_fish");
  const html = menu(economy, { initialRecipeId: "cook_legendary_fish" });
  assert.match(html, /aria-modal="true"/); assert.match(html, /Книга рецептов/);
  assert.match(html, /data-cookbook-view="detail"/); assert.match(html, /data-cookbook-queue/);
  assert.doesNotMatch(html, /data-recipe-preparation|Способ производства/);
});

test("the campfire catalogue does not replace other station product lists", () => {
  const economy = controller(); hooks.reset();
  const html = renderToStaticMarkup(createElement(WorldObjectMenu, { selection: { place: "workshop", objectId: "workshop.position", x: 195, y: 380, viewportWidth: 390, viewportHeight: 844 }, economy, onClose() {} }));
  assert.match(html, /data-recipe="make_planks"/);
  assert.doesNotMatch(html, /data-campfire-catalog|data-cooking-duration|Время приготовления/);
});


test("unknown cooking experiments hide the future dish and its effects until a successful discovery", () => {
  const recipeId = "experiment_berry_pastila";
  const economy = controller();
  hooks.reset();
  const hidden = catalog(economy, recipeId).html;
  assert.match(hidden, /Ингредиенты будут потрачены в любом случае/);
  assert.match(hidden, /При неудаче блюдо не получится/);
  assert.match(hidden, /Успех/);
  assert.doesNotMatch(hidden, /data-known-meal-benefits|Ягодная пастила|Поможет в работе|При неудаче получите/);
  economy.snapshot.progression.recipes[recipeId] = 1;
  hooks.reset();
  const discovered = catalog(economy, recipeId).html;
  assert.match(discovered, /Ягодная пастила/);
  assert.match(discovered, /data-known-meal-benefits/);
  assert.match(discovered, /1 ч →/);
});


test("an unknown experiment cannot be exposed through search or a recipe link before ingredient familiarity", () => {
  const economy = controller({ familiarItems: [], progression: { recipes: {}, routes: {} } });
  hooks.reset(); let view = catalog(economy, "experiment_berry_pastila");
  assert.deepEqual(view.cards, []);
  assert.doesNotMatch(view.html, /Тягучая ягодная сладость|Ягодная пастила/);
  view.tab("discoveries").props.onClick(); view = catalog(economy, "experiment_berry_pastila");
  assert.deepEqual(view.ids, []);
  assert.match(view.html, /Новые опыты появятся/);
  economy.snapshot.familiarItems = ["strawberry_compote", "berries"];
  view = catalog(economy, "experiment_berry_pastila", 1);
  assert.equal(view.cards[0].props.recipe.id, "experiment_berry_pastila");
  assert.doesNotMatch(view.html, /Ягодная пастила|data-known-meal-benefits/);
});
