import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { Children, createElement, isValidElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, cacheDir: `/tmp/zhiv-simple-cards-${process.pid}`,
  resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false } });
const { WorldObjectMenu } = await vite.ssrLoadModule("/features/economy/ui/stations/world-object-menu.tsx");
const { WorldProductionCard } = await vite.ssrLoadModule("/features/economy/ui/production/world-production-card.tsx");
const { WorldExpeditionSector, ExpeditionRouteDetails } = await vite.ssrLoadModule("/features/economy/ui/expeditions/world-expeditions-menu.tsx");
const { economyCatalog } = await vite.ssrLoadModule("/features/economy/domain/model.ts");
const { economyStorage } = await vite.ssrLoadModule("/features/economy/domain/rules.ts");
const { worldRecipeGroups } = await vite.ssrLoadModule("/features/economy/ui/stations/world-recipe-groups.ts");
const { newTutorialOrder } = await vite.ssrLoadModule("/features/economy/domain/tutorial-order.ts");
after(() => vite.close());

const now = Date.parse("2026-10-03T12:00:00Z");
function controller(overrides = {}, flags = {}) {
  const state = { ownerPublicId: "ME", revision: 1, serverTime: new Date(now).toISOString(), wallet: { coins: 100, pearls: 0 }, inventory: {},
    buildings: { home: 3, garden: 2, warehouse: 1, workshop: 2 }, jobs: [], completedExplorations: 0,
    migration: { version: 1, coinsGranted: 0, woodGranted: 0, stoneGranted: 0 }, catalog: structuredClone(economyCatalog), ...overrides };
  return { snapshot: { ...state, storage: overrides.storage ?? economyStorage(state) }, market: null, marketError: null, busy: false, uncertain: false, error: null, notice: "", now, retryAt: 0,
    act() { return true; }, actMarket() {}, refresh() {}, refreshMarket() {}, retry() {}, ...flags };
}
function renderMenu(place, economy = controller(), extra = {}) {
  return renderToStaticMarkup(createElement(WorldObjectMenu, { selection: { place, objectId: `${place}.position`, x: 195, y: 380, viewportWidth: 390, viewportHeight: 844 }, economy, onClose() {}, ...extra }));
}
function renderCard(id, economy = controller(), extra = {}) {
  return renderToStaticMarkup(createElement(WorldProductionCard, { economy, recipe: economy.snapshot.catalog.recipes.find(recipe => recipe.id === id), ...extra }));
}
function cardBlocked(html) {
  const match = html.match(/<button\b([^>]*data-recipe=[^>]*)>/);
  assert.ok(match, "Missing one-tap product card");
  return /data-blocked="true"/.test(match[1]);
}

test("first raspberry aid is visible only in the active lesson and reverts to the catalog duration when paused or used", () => {
  const economy = controller({ buildings: { home: 1, garden: 1, warehouse: 1 }, tutorialOrder: newTutorialOrder(),
    progression: { recipes: {}, routes: {}, buildings: {} } });
  const ordinary = renderCard("grow_berries", economy);
  assert.doesNotMatch(ordinary, /Сразу · первый урожай/);
  assert.match(ordinary, /aria-label="Произвести: Малина, 1 мин"/);
  const fresh = renderCard("grow_berries", economy, { tutorialHarvestActive: true });
  assert.match(fresh, /Сразу · первый урожай/);
  assert.match(fresh, /Сбор Мохликом остаётся обычным; помощь доступна один раз/);
  economy.snapshot.tutorialOrder.firstHarvestPrepared = true;
  const replay = renderCard("grow_berries", economy, { tutorialHarvestActive: true });
  assert.doesNotMatch(replay, /Сразу · первый урожай/);
  assert.match(replay, /aria-label="Произвести: Малина, 1 мин"/);
});

test("fish cooking retains its catalog class cost and never substitutes a more valuable rarity", () => {
  const calls = [], economy = controller({ buildings: { home: 5, dryer: 5, warehouse: 1 }, inventory: { fish_common: 2, fish_legendary: 1 } },
    { act: (...args) => { calls.push(args); return true; } });
  const before = structuredClone(economy.snapshot), initial = renderCard("cook_grilled_fish", economy);
  assert.equal(cardBlocked(initial), false); assert.match(initial, /data-item-icon="fish_common"/);
  assert.doesNotMatch(initial, /data-item-icon="fish_legendary"|<select\b/);
  assert.deepEqual(economy.snapshot, before); economy.snapshot.inventory.fish_common = 0;
  const recipe = economy.snapshot.catalog.recipes.find(recipe => recipe.id === "cook_grilled_fish");
  let tree;
  function Probe() { tree = WorldProductionCard({ economy, recipe }); return tree; }
  const blocked = renderToStaticMarkup(createElement(Probe)); assert.equal(cardBlocked(blocked), true);
  const action = elements(tree).find(element => element.props["data-recipe-order"] !== undefined);
  action.props.onClick(); assert.deepEqual(calls, [], "legendary stock cannot pay a missing common-fish cost");
});
function elements(tree) {
  const found = [];
  const walk = element => { if (isValidElement(element)) { found.push(element); Children.forEach(element.props.children, walk); } };
  walk(tree); return found;
}
function prepareMineRoute(economy, routeId = "quarry_stone") {
  let selectedRoute = null, tree;
  const calls = [], elements = [];
  const trackedEconomy = { ...economy, act: (...args) => calls.push(args) };
  function Probe() {
    tree = WorldExpeditionSector({ sectorId: "caves", selectedRoute, onSelectRoute: id => { selectedRoute = id; },
      economy: trackedEconomy, state: economy.snapshot, exploring: economy.snapshot.jobs.some(job => job.kind === "exploration" && job.actorId !== "miner"), onOpenPantry() {} });
    return tree;
  }
  function walk(element) {
    if (!isValidElement(element)) return;
    elements.push(element);
    if (element.type === ExpeditionRouteDetails) {
      function DetailProbe() { const details = ExpeditionRouteDetails(element.props); walk(details); return details; }
      renderToStaticMarkup(createElement(DetailProbe));
    }
    Children.forEach(element.props.children, walk);
  }
  const list = renderToStaticMarkup(createElement(Probe)); walk(tree);
  assert.doesNotMatch(list, /aria-label="Отправиться:/, "route selection opens preparation before offering departure");
  const card = elements.find(element => element.type === "button" && element.props["data-route"] === routeId);
  assert.ok(card, "mine route must be selectable for reviewing its conditions");
  assert.notEqual(card.props.disabled, true);
  card.props.onClick();
  assert.equal(selectedRoute, routeId);
  assert.deepEqual(calls, [], "selecting a route does not start an expedition");
  elements.length = 0;
  const html = renderToStaticMarkup(createElement(Probe)); walk(tree);
  assert.match(html, /data-route-preparation="true"/);
  return { html, calls, departure: elements.find(element => element.type === "button"
    && element.props["aria-label"] === "Начать добычу: Добыть камень") };
}


test("workshop shows one tap products with inline material costs and no preparation screen", () => {
  const html = renderMenu("workshop");
  assert.deepEqual([...html.matchAll(/data-recipe="([^"]+)"/g)].map(match => match[1]), ["make_planks", "make_rope", "weave_cloth"]);
  assert.match(html, /data-item-icon="fiber"/);
  assert.match(html, /data-item-icon="rope"/);
  assert.match(html, /0 \/ 1/);
  assert.doesNotMatch(html, /data-recipe-preparation|data-recipe-method|Способов|Способ производства|Все рецепты|Начать ·|Откуда брать/);
});

test("workshop tabs and all three slot controls remain available beside a focused product", () => {
  const economy = controller({ buildings: { home: 3, workshop: 2, kiln: 1, warehouse: 1 } });
  for (const stationId of ["workshop", "kiln"]) {
    const html = renderMenu("workshop", economy, { initialStationId: stationId, initialRecipeId: "make_planks" });
    assert.match(html, /role="tablist" aria-label="Оборудование: Мастерская"/);
    assert.equal((html.match(/role="tab"/g) ?? []).length, 2);
    assert.match(html, /role="tabpanel" aria-labelledby=/);
    assert.match(html, /data-production-slot="1"/);
    assert.match(html, /data-production-slot="2"/);
    assert.match(html, /data-production-slot="3"/);
    assert.match(html, /aria-haspopup="dialog"/);
    assert.doesNotMatch(html, /hidden=""[^>]*aria-label="Продукция/);
  }
});

test("garden upgrades improve the single product automatically and retain precise seconds", () => {
  for (const [home, garden, raspberryId, strawberryId] of [
    [1, 1, "grow_berries", "grow_strawberries"],
    [3, 2, "grow_berries_large", "grow_strawberries"],
    [3, 3, "garden_season", "grow_strawberries"],
    [4, 4, "garden_season", "garden_supply"],
    [5, 5, "garden_season", "garden_abundance"],
  ]) {
    const economy = controller({ buildings: { home, garden, warehouse: 1 }, progression: { recipes: { cook_compote: 1 } } });
    const html = renderMenu("garden", economy);
    assert.equal((html.match(/data-recipe-product="berries"/g) ?? []).length, 1);
    assert.equal((html.match(/data-recipe-product="strawberries"/g) ?? []).length, 1);
    assert.match(html, new RegExp(`data-recipe="${raspberryId}"`));
    assert.match(html, new RegExp(`data-recipe="${strawberryId}"`));
    assert.doesNotMatch(html, /Способ производства|data-recipe-method|data-recipe-preparation/);
    if (garden >= 3) assert.match(html, /30 с/);
    else if (garden === 2) assert.match(html, /45 с/);
  }
});

test("automatic product grouping preserves paid legacy recipes and chooses personally unlocked improvements", () => {
  const economy = controller({ buildings: { home: 3, woodlot: 3, garden: 3, warehouse: 1 }, progression: { recipes: {} } });
  const before = structuredClone(economy.snapshot);
  const group = () => worldRecipeGroups(economy.snapshot, economy.snapshot.catalog.recipes).find(entry => entry.methods.some(method => method.id === "gather_hardwood"));
  assert.equal(group().recipe.id, "gather_hardwood");
  assert.deepEqual(economy.snapshot, before);
  economy.snapshot.progression.recipes.gather_hardwood = 10;
  assert.equal(group().recipe.id, "hardwood_shift");
});

test("help links focus the logical product without starting it or hiding existing work", () => {
  const economy = controller({ buildings: { home: 3, garden: 3, warehouse: 1 } }, { act() { assert.fail("Opening a source must never start production"); } });
  for (const id of ["grow_berries", "grow_berries_large", "garden_season"]) {
    const html = renderMenu("garden", economy, { initialRecipeId: id });
    assert.match(html, /data-recipe="garden_season"[^>]*data-recipe-focused="true"/);
    assert.match(html, /data-production-slots="garden"/);
    assert.doesNotMatch(html, /data-recipe-preparation|Все рецепты|data-recipe-method/);
  }
  for (const initialRecipeId of ["make_planks", "missing_recipe"]) {
    assert.doesNotMatch(renderMenu("garden", economy, { initialRecipeId }), /data-recipe-focused="true"/);
  }
});

test("crafting shows only its actual ingredient images and quantities inline", () => {
  const html = renderCard("weave_cloth", controller({ inventory: { wood: 6, fiber: 3, rope: 1 } }));
  assert.match(html, /data-item-icon="cloth"/);
  assert.match(html, /data-item-icon="fiber"/);
  assert.match(html, /3 \/ 5/);
  assert.match(html, /data-item-icon="rope"/);
  assert.match(html, /×1/);
  assert.doesNotMatch(html, /data-item-icon="wood"|<select|Где получить|Открыть рецепт|Все рецепты/);
  assert.equal(cardBlocked(html), true);
  assert.doesNotMatch(html, /disabled=/, "shortages remain clickable for an explanation");
});

test("ordinary production puts the product name alongside its image without an output multiplier", () => {
  const html = renderCard("grow_berries");
  const header = html.match(/<span\b[^>]*data-production-header[^>]*>([\s\S]*?)<\/strong><\/span>/)?.[1];
  assert.ok(header);
  assert.match(header, /data-item-icon="berries"/);
  assert.match(header, /<strong[^>]*>Малина/);
  assert.doesNotMatch(header, /×1/);
  assert.doesNotMatch(html, /×1/, "free one-item cultivation has no redundant quantity badge or invented inputs");
  assert.match(html, /1 мин/);
});

test("larger and mixed production outputs retain their actual quantities", () => {
  const economy = controller();
  const recipe = economy.snapshot.catalog.recipes.find(entry => entry.id === "grow_berries");
  for (const rewards of [{ berries: 3 }, { berries: 1, strawberries: 2 }]) {
    const html = renderToStaticMarkup(createElement(WorldProductionCard, { economy, recipe: { ...recipe, rewards } }));
    for (const [id, amount] of Object.entries(rewards)) {
      assert.match(html, new RegExp(`data-item-icon="${id}"`));
      assert.match(html, new RegExp(`×${amount}`));
    }
  }
});

test("locked food cards show the prerequisite along with ingredients and bonuses", () => {
  const economy = controller({ buildings: { home: 3, dryer: 2, warehouse: 1 }, inventory: { berries: 1 } });
  const recipe = economy.snapshot.catalog.recipes.find(entry => entry.id === "cook_fish_soup");
  let tree;
  function Probe() { tree = WorldProductionCard({ economy, recipe }); return tree; }
  const html = renderToStaticMarkup(createElement(Probe));
  const card = elements(tree).find(element => element.type === "button");
  assert.match(card.props.title, /Приготовьте и заберите/);
  const contents = renderToStaticMarkup(createElement("div", null, card.props.children));
  assert.match(contents, /data-recipe-access[^>]*>Приготовьте и заберите/, "access is explained without a hover or failed production click");
  assert.match(contents, /data-production-inputs/);
  assert.match(contents, /data-item-icon="fish_common"/);
  assert.match(contents, /data-item-icon="berries"/);
  assert.match(contents, /data-item-icon="charcoal"/);
  assert.match(contents, /0 \/ 2/);
  assert.match(contents, /Вылазка \+25%/);
  assert.match(contents, /Стройка \+25%/);
  assert.match(html, /aria-describedby=/);
  assert.equal(card.props.disabled, undefined, "a locked card still explains its reason on tap");
});

test("one tap dispatches a single unit, reports shortages and refuses repeated submissions", async () => {
  const hookModule = "virtual:simple-production-hooks";
  const runtime = await createServer({ appType: "custom", configFile: false, root, cacheDir: `/tmp/zhiv-simple-card-hooks-${process.pid}`,
    resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false },
    plugins: [{ name: "simple-production-hooks", enforce: "pre",
      resolveId(id) { if (id === hookModule) return `\0${id}`; },
      load(id) { if (id === `\0${hookModule}`) return `
        let slots = [], cursor = 0, effects = [];
        export function reset() { slots = []; cursor = 0; effects = []; }
        export function render() { cursor = 0; effects = []; }
        export function flush() { for (const effect of effects) effect(); }
        export function useRef(initial) { const index = cursor++; return slots[index] ??= { current: initial }; }
        export function useId() { return useRef('card-status').current; }
        export function useState(initial) { const slot = useRef(typeof initial === 'function' ? initial() : initial); return [slot.current, value => { slot.current = typeof value === 'function' ? value(slot.current) : value; }]; }
        export function useEffect(effect, dependencies) { const previous = useRef(null); if (!previous.current || dependencies.some((value, index) => !Object.is(value, previous.current[index]))) { previous.current = dependencies; effects.push(effect); } }
        export const useLayoutEffect = useEffect;
      `; },
      transform(source, id) { if (id.endsWith("/features/economy/ui/production/world-production-card.tsx")) return source.replace('from "react";', `from "${hookModule}";`); },
    }],
  });
  try {
    const hooks = await runtime.ssrLoadModule(hookModule);
    const { WorldProductionCard: Card } = await runtime.ssrLoadModule("/features/economy/ui/production/world-production-card.tsx");
    const calls = [], contexts = [];
    const economy = controller({ inventory: { wood: 8 } }, { act(...args) { calls.push(args); return true; } });
    const recipe = economy.snapshot.catalog.recipes.find(recipe => recipe.id === "make_planks");
    const render = () => { hooks.render(); const tree = Card({ economy, recipe, onHelpContextChange: context => contexts.push(context) }); hooks.flush(); return tree; };
    const action = tree => elements(tree).find(element => element.type === "button" && element.props["data-recipe-order"]);
    hooks.reset();
    hooks.render();
    const focusedTree = Card({ economy, recipe, focused: true });
    const movements = [];
    action(focusedTree).props.ref.current = { focus: options => movements.push(["focus", options]), scrollIntoView: options => movements.push(["scroll", options]) };
    hooks.flush();
    assert.deepEqual(movements, [["focus", { preventScroll: true }], ["scroll", { block: "nearest" }]]);
    assert.deepEqual(calls, [], "help focus and scroll cannot start an order");
    hooks.reset();
    const first = action(render());
    assert.deepEqual(calls, [], "rendering and reading costs cannot spend");
    first.props.onClick(); first.props.onClick();
    assert.deepEqual(calls, [["start_production", "make_planks", 1]], "a double press cannot queue two jobs from one intent");
    assert.match(renderToStaticMarkup(render()), /role="status"[^>]*>Дождитесь завершения действия/);
    assert.deepEqual(contexts[0], { intent: "production", stationId: "workshop", recipeId: "make_planks", quantity: 1 });
    economy.snapshot = { ...economy.snapshot, revision: 2 };
    render(); action(render()).props.onClick();
    assert.equal(calls.length, 2, "a confirmed revision releases the local submission guard");
    for (const flags of [{ busy: true }, { uncertain: true }, { retryAt: now + 10_000 }]) {
      hooks.reset(); Object.assign(economy, { busy: false, uncertain: false, retryAt: 0 }, flags);
      const before = calls.length; action(render()).props.onClick();
      assert.equal(calls.length, before); assert.match(renderToStaticMarkup(render()), /role="status"/);
    }
    hooks.reset(); Object.assign(economy, { busy: false, uncertain: false, retryAt: 0, error: null });
    economy.snapshot.inventory.wood = 0;
    action(render()).props.onClick();
    assert.match(renderToStaticMarkup(render()), /Не хватает: Бревно ×1/);
    const before = calls.length;
    economy.snapshot.inventory.wood = 2;
    economy.act = () => false;
    action(render()).props.onClick();
    assert.match(renderToStaticMarkup(render()), /Не удалось начать/);
    economy.act = (...args) => { calls.push(args); return true; };
    action(render()).props.onClick();
    assert.equal(calls.length, before + 1, "a refused command cannot latch the card forever");
    economy.busy = true; render(); economy.busy = false; economy.error = "Материалы уже использованы"; render();
    action(render()).props.onClick();
    assert.equal(calls.length, before + 2, "a definitive old error cannot block an otherwise valid new order");

    hooks.reset();
    const aidCalls = [], aid = controller({ buildings: { home: 1, garden: 1, warehouse: 1 }, tutorialOrder: newTutorialOrder(),
      progression: { recipes: {}, routes: {}, buildings: {} } }, { productionQueueAvailable: true,
      act(...args) { aidCalls.push(args); return true; } });
    const berry = aid.snapshot.catalog.recipes.find(recipe => recipe.id === "grow_berries");
    let activeLesson = true;
    const renderAid = () => { hooks.render(); const tree = Card({ economy: aid, recipe: berry, tutorialHarvestActive: activeLesson }); hooks.flush(); return tree; };
    const oldAidButton = action(renderAid());
    activeLesson = false; const ordinaryButton = action(renderAid());
    oldAidButton.props.onClick(); assert.deepEqual(aidCalls, [], "a pre-pause callback cannot issue assistance after the lesson closes");
    ordinaryButton.props.onClick(); assert.deepEqual(aidCalls, [["start_production", "grow_berries", 1]]);
    hooks.reset(); aidCalls.length = 0; activeLesson = true;
    const assistance = action(renderAid()); assistance.props.onClick(); assistance.props.onClick();
    assert.deepEqual(aidCalls, [["start_tutorial_harvest", "grow_berries", 1]], "the aid uses one confirmed direct action even with the ordinary durable queue enabled");
    hooks.reset(); aidCalls.length = 0; aid.directActionsAvailable = false;
    action(renderAid()).props.onClick(); assert.deepEqual(aidCalls, [], "teaching aid is never accepted into the offline production queue");
    assert.match(renderToStaticMarkup(renderAid()), /Восстанавливаем соединение/);
  } finally { await runtime.close(); }
});

test("occupied places and prerequisites explain themselves without dispatch or navigation", async () => {
  const cases = [
    controller({ jobs: [{ kind: "production", targetId: "workshop", rewards: { plank: 1 } }], inventory: { wood: 8 } }),
    controller({ inventory: {} }),
    controller({ buildings: { home: 1, workshop: 0, warehouse: 1 }, inventory: { wood: 8 } }),
  ];
  for (const economy of cases) {
    let called = 0, tree;
    economy.act = () => { called++; return true; };
    function Probe() { tree = WorldProductionCard({ economy, recipe: economy.snapshot.catalog.recipes.find(recipe => recipe.id === "make_planks") }); return tree; }
    renderToStaticMarkup(createElement(Probe));
    elements(tree).find(element => element.type === "button").props.onClick();
    assert.equal(called, 0);
  }
});

test("mine exposes actor routes instead of production and passive crafting remains available while the hero is busy", () => {
  assert.equal(economyCatalog.recipes.some(recipe => recipe.buildingId === "quarry"), false);
  const free = controller({ buildings: { home: 2, quarry: 1, workshop: 1, warehouse: 1 } });
  const idle = renderMenu("quarry", free);
  assert.doesNotMatch(idle, /data-recipe=|Начать ·|data-quarry-tab=/);
  assert.match(idle, /data-route="quarry_stone"/);
  const available = prepareMineRoute(free);
  assert.ok(available.departure);
  assert.equal(available.departure.props.disabled, false);
  available.departure.props.onClick();
  assert.deepEqual(available.calls, [["start_exploration", "quarry_stone", 1, 0]]);
  const base = { id: "busy", startedAt: new Date(now - 1_000).toISOString(), finishesAt: new Date(now + 30_000).toISOString(), rewards: {}, cost: { coins: 0, items: {} } };
  for (const occupied of [
    { ...base, kind: "exploration", targetId: "forest" },
    { ...base, kind: "exploration", targetId: "forest", finishesAt: new Date(now).toISOString() },
    { ...base, kind: "production", targetId: "garden", collection: { startedAt: new Date(now).toISOString() } },
  ]) {
    const economy = controller({ buildings: { home: 2, quarry: 1, workshop: 1, warehouse: 1 }, inventory: { wood: 2 }, jobs: [occupied] });
    const mine = renderMenu("quarry", economy);
    assert.doesNotMatch(mine, /data-recipe=|Начать ·/);
    assert.match(mine, /data-route="quarry_stone"/);
    const preparation = prepareMineRoute(economy), departure = preparation.departure;
    assert.ok(departure);
    assert.equal(departure.props.disabled, false, "the miner remains independent during a hero trip or harvest");
    departure.props.onClick();
    assert.deepEqual(preparation.calls, [["start_exploration", "quarry_stone", 1, 0]]);
    assert.equal(cardBlocked(renderCard("make_planks", economy)), false);
  }
});
