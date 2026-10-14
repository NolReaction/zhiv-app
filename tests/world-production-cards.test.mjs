import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { Children, createElement, isValidElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false } });
const { WorldObjectMenu, WorldRecipeDetail } = await vite.ssrLoadModule("/features/economy/ui/stations/world-object-menu.tsx");
const { WorldExpeditionSector, ExpeditionRouteDetails } = await vite.ssrLoadModule("/features/economy/ui/expeditions/world-expeditions-menu.tsx");
const { economyCatalog } = await vite.ssrLoadModule("/features/economy/domain/model.ts");
const { economyStorage } = await vite.ssrLoadModule("/features/economy/domain/rules.ts");
const { worldRecipeGroups } = await vite.ssrLoadModule("/features/economy/ui/stations/world-recipe-groups.ts");
after(() => vite.close());

const now = Date.parse("2026-10-03T12:00:00Z");
function controller(overrides = {}, flags = {}) {
  const state = { ownerPublicId: "ME", revision: 1, serverTime: new Date(now).toISOString(), wallet: { coins: 100, pearls: 0 }, inventory: {},
    buildings: { home: 3, garden: 2, warehouse: 1, workshop: 2 }, jobs: [], completedExplorations: 0,
    migration: { version: 1, coinsGranted: 0, woodGranted: 0, stoneGranted: 0 }, catalog: structuredClone(economyCatalog), ...overrides };
  return { snapshot: { ...state, storage: overrides.storage ?? economyStorage(state) }, market: null, marketError: null, busy: false, uncertain: false, error: null, notice: "", now, retryAt: 0,
    act() {}, actMarket() {}, refresh() {}, refreshMarket() {}, retry() {}, ...flags };
}
function renderMenu(place, economy = controller(), extra = {}) {
  return renderToStaticMarkup(createElement(WorldObjectMenu, { selection: { place, objectId: `${place}.position`, x: 195, y: 380, viewportWidth: 390, viewportHeight: 844 }, economy, onClose() {}, ...extra }));
}
function renderRecipe(id, economy = controller(), extra = {}) {
  return renderToStaticMarkup(createElement(WorldRecipeDetail, { economy, recipe: economy.snapshot.catalog.recipes.find(recipe => recipe.id === id), onCollapse() {}, ...extra }));
}
function section(html, label) {
  const match = html.match(new RegExp(`<section[^>]*aria-label="${label}"[^>]*>([\\s\\S]*?)</section>`));
  assert.ok(match, `Missing section: ${label}`);
  return match[1];
}
function startDisabled(html) {
  const match = html.match(/<button\b([^>]*)>Начать ·/);
  assert.ok(match, "Missing production action");
  return /\bdisabled=/.test(match[1]);
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

test("workshop presents one catalogue of unlocked recipes regardless of duration", () => {
  const html = renderMenu("workshop");
  const catalogue = section(html, "Доступные рецепты");
  assert.deepEqual([...catalogue.matchAll(/data-recipe="([^"]+)"/g)].map(match => match[1]), ["make_planks", "make_rope", "weave_cloth"]);
  assert.equal((html.match(/aria-label="Доступные рецепты"/g) ?? []).length, 1);
  assert.doesNotMatch(html, /data-recipe="workshop_overnight"|data-recipe="make_metal_parts"|data-recipe="make_tools"|Обычные заказы|На несколько часов|Позже/);
  assert.doesNotMatch(html, /aria-label="Стоимость"|Недостающие условия|Начать ·/);
});

test("unlocking an external station reveals its recipe in the same catalogue", () => {
  const html = renderMenu("workshop", controller({ buildings: { home: 3, workshop: 2, kiln: 2, warehouse: 1 } }));
  assert.match(section(html, "Доступные рецепты"), /data-recipe="make_metal_parts"/);
});

test("workshop equipment tabs share the header and expose the selected station and its own level", () => {
  const economy = controller({ buildings: { home: 3, workshop: 2, kiln: 1, warehouse: 1 } });
  for (const stationId of ["workshop", "kiln"]) {
    const html = renderMenu("workshop", economy, { initialStationId: stationId });
    const header = html.match(/<header\b[^>]*>([\s\S]*?)<\/header>/)?.[1];
    assert.ok(header);
    assert.match(header, /role="tablist" aria-label="Оборудование: Мастерская"/);
    assert.doesNotMatch(header, /<h2|Верстак/);
    const tabs = [...header.matchAll(/<button\b([^>]*role="tab"[^>]*)>([\s\S]*?)<\/button>/g)];
    assert.equal(tabs.length, 2);
    for (const [index, [, attributes, content]] of tabs.entries()) {
      const selected = (index === 0 ? "workshop" : "kiln") === stationId;
      assert.match(attributes, new RegExp(`aria-selected="${selected}"`));
      assert.match(attributes, new RegExp(`tabindex="${selected ? 0 : -1}"`));
      assert.match(content, index === 0 ? /Мастерская<small>ур. 2<\/small>/ : /Печь<small>ур. 1<\/small>/);
    }
    assert.match(html, /role="tabpanel" aria-labelledby=/);
  }
});

test("harvest cards distinguish quantity and time while keeping the result name short", () => {
  const html = renderMenu("garden", controller({ buildings: { home: 1, garden: 1, warehouse: 1 } }));
  const catalogue = section(html, "Доступные рецепты");
  const cards = [...catalogue.matchAll(/<button[^>]*data-recipe="([^"]+)"[^>]*>([\s\S]*?)<\/button>/g)];
  assert.equal(cards.length, 2);
  assert.deepEqual(cards.map(card => card[1]), ["grow_berries", "grow_strawberries"]);
  assert.match(cards[0][2], /<strong>Малина<\/strong>/);
  assert.match(cards[1][2], /<strong>Клубника<\/strong>/);
  for (const [, , card] of cards) assert.match(card, /×1<\/b>/);
  assert.match(cards[0][2], /1 мин/);
  assert.match(cards[1][2], /5 мин/);
  assert.doesNotMatch(catalogue, /grow_berries_overnight|8 ч/);
});

test("upgraded gardens keep one card per crop and show the fastest personally unlocked method", () => {
  for (const [home, garden, raspberryId, strawberryId] of [
    [1, 1, "grow_berries", "grow_strawberries"],
    [3, 2, "grow_berries_large", "grow_strawberries"],
    [3, 3, "garden_season", "grow_strawberries"],
    [4, 4, "garden_season", "garden_supply"],
    [5, 5, "garden_season", "garden_abundance"],
  ]) {
    const economy = controller({ buildings: { home, garden, warehouse: 1 }, progression: { recipes: { cook_compote: 1 } } });
    const html = section(renderMenu("garden", economy), "Доступные рецепты");
    const ids = [...html.matchAll(/data-recipe="([^"]+)"/g)].map(match => match[1]);
    assert.equal((html.match(/<strong>Малина<\/strong>/g) ?? []).length, 1);
    assert.equal((html.match(/<strong>Клубника<\/strong>/g) ?? []).length, 1);
    assert.ok(ids.includes(raspberryId));
    assert.ok(ids.includes(strawberryId));
    if (garden >= 3) assert.match(html, /30 с/);
    else if (garden === 2) assert.match(html, /45 с/);
    if (garden === 4) assert.match(html, /2 мин 30 с/);
  }
});

test("grouping retains meaningful methods, joint rewards and original catalog data", () => {
  const economy = controller({ buildings: { home: 3, woodlot: 3, garden: 3, warehouse: 1 }, progression: { recipes: {} } });
  const before = structuredClone(economy.snapshot);
  const recipes = economy.snapshot.catalog.recipes;
  const group = () => worldRecipeGroups(economy.snapshot, recipes).find(entry => entry.methods.some(method => method.id === "gather_hardwood"));
  assert.equal(group().recipe.id, "gather_hardwood", "a faster recipe needing ten claimed base products is not selected prematurely");
  assert.deepEqual(group().methods.map(method => method.id), ["gather_hardwood", "hardwood_shift"]);
  assert.deepEqual(economy.snapshot, before);
  economy.snapshot.progression.recipes.gather_hardwood = 10;
  assert.equal(group().recipe.id, "hardwood_shift");
  const base = recipes.find(recipe => recipe.id === "gather_hardwood");
  const cheaper = { ...base, id: "alternative-cost", seconds: 700, cost: { coins: 2, items: { wood: 1 } }, rewards: { hardwood: 2 } };
  const joint = { ...base, id: "joint-result", rewards: { hardwood: 1, resin: 1 } };
  const otherStation = { ...base, id: "garden-hardwood", buildingId: "garden" };
  const groups = worldRecipeGroups(economy.snapshot, [base, cheaper, joint, otherStation]);
  assert.equal(groups.length, 3, "another station and a joint reward remain separate entries");
  assert.deepEqual(groups[0].methods.map(method => method.id), [base.id, cheaper.id], "different cost and result quantity remain selectable methods");
});

test("method preparation preserves exact requested ids, prerequisites and visibly different times", () => {
  const economy = controller({ buildings: { home: 3, garden: 3, woodlot: 3, warehouse: 1 }, progression: { recipes: {} } });
  for (const [id, duration] of [["grow_berries", "1 мин"], ["grow_berries_large", "45 с"], ["garden_season", "30 с"]]) {
    const html = renderMenu("garden", economy, { initialRecipeId: id });
    assert.match(html, new RegExp(`data-recipe-preparation="${id}"`));
    assert.match(html, new RegExp(`data-recipe-method="${id}" aria-pressed="true"`));
    assert.match(html, new RegExp(`Начать · ${duration}`));
    assert.equal((html.match(/data-recipe-method=/g) ?? []).length, 3);
  }
  const locked = renderMenu("woodlot", economy, { initialRecipeId: "hardwood_shift", onNavigate() {} });
  assert.match(locked, /data-recipe-preparation="hardwood_shift"/);
  assert.match(locked, /Произведите и заберите: Крепкое бревно \(0 \/ 10\)/);
  assert.match(locked, /Открыть рецепт: Крепкое бревно/);
  assert.equal(startDisabled(locked), true);
  const base = renderMenu("woodlot", economy, { initialRecipeId: "gather_hardwood" });
  assert.match(base, /data-recipe-preparation="gather_hardwood"/);
  assert.equal(startDisabled(base), false);
});

test("choosing a method only changes preparation and starts its exact recipe when confirmed", () => {
  const calls = [];
  const economy = controller({ buildings: { home: 3, garden: 3, warehouse: 1 } }, { act(...args) { calls.push(args); } });
  let recipeId = "garden_season";
  const elements = [];
  function walk(element) {
    if (!isValidElement(element)) return;
    elements.push(element);
    Children.forEach(element.props.children, walk);
  }
  function Probe() {
    const tree = WorldRecipeDetail({ economy, recipe: economy.snapshot.catalog.recipes.find(recipe => recipe.id === recipeId), onCollapse() {}, onChooseRecipe(id) { recipeId = id; } });
    walk(tree);
    return tree;
  }
  renderToStaticMarkup(createElement(Probe));
  const original = elements.find(element => element.props["data-recipe-method"] === "grow_berries");
  assert.ok(original);
  original.props.onClick();
  assert.equal(recipeId, "grow_berries");
  assert.deepEqual(calls, []);
  elements.length = 0;
  renderToStaticMarkup(createElement(Probe));
  const start = elements.find(element => element.type === "button" && element.props.children?.[0] === "Начать · ");
  assert.ok(start);
  start.props.onClick();
  assert.deepEqual(calls, [["start_production", "grow_berries", 1]]);
});

test("selected current recipe shows its exact unit reward and only its own costs", () => {
  const recipe = economyCatalog.recipes.find(recipe => recipe.id === "weave_cloth");
  assert.deepEqual(recipe.rewards, { cloth: 1 });
  assert.deepEqual(recipe.cost, { coins: 0, items: { fiber: 5, rope: 1 } });
  assert.equal(recipe.maxBatch, 1);
  const html = renderRecipe(recipe.id, controller({ inventory: { wood: 6, fiber: 5, rope: 1 } }));
  assert.match(html, /Все рецепты/);
  assert.match(html, /data-item-icon="cloth"/);
  assert.equal((html.match(/×1<\/b>/g) ?? []).length, 1);
  assert.match(html, /1 предмет · 1 место производства/);
  assert.match(html, /Понадобится/);
  assert.match(html, /5 \/ 5/);
  assert.match(html, /1 \/ 1/);
  assert.equal(startDisabled(html), false);
  assert.doesNotMatch(html, /data-item-icon="wood"|Обычные заказы|На несколько часов|data-recipe=|aria-label="Увеличить партию"/);
});

test("selection preserves missing-material navigation and all request locks", () => {
  const navigation = { open() {}, canOpen() { return true; }, explore() {} };
  const missing = renderRecipe("make_planks", controller(), { navigation });
  assert.equal(startDisabled(missing), true);
  assert.match(missing, /aria-label="Где получить: Бревно"/);
  for (const flags of [{ busy: true }, { uncertain: true }, { retryAt: now + 10_000 }]) {
    const html = renderRecipe("make_planks", controller({ inventory: { wood: 2 } }, flags));
    assert.equal(startDisabled(html), true);
    assert.match(html, /<button(?![^>]*disabled)[^>]*>[\s\S]*?Все рецепты<\/button>/);
  }
});

test("locked recipe explains its prerequisites once and remains unavailable", () => {
  const html = renderRecipe("make_metal_parts", controller({ inventory: { iron_ingot: 1, wood: 1 } }));
  assert.equal(startDisabled(html), true);
  assert.match(html, /aria-label="Недостающие условия"/);
  assert.match(html, /Печь · нужен ур. 2/);
  assert.doesNotMatch(html, /Печь: нужен уровень 2/);
});

test("direct material navigation opens only unlocked recipe preparations", () => {
  for (const workshopLevel of [0, 1]) {
    const economy = controller({ buildings: { home: 2, workshop: workshopLevel, warehouse: 1 }, inventory: { wood: 2 } },
      { act() { assert.fail("opening recipe preparation cannot start production"); } });
    const recipe = economy.snapshot.catalog.recipes.find(entry => entry.id === "make_planks");
    const html = renderMenu("workshop", economy, { initialStationId: "workshop", initialRecipeId: recipe.id });
    if (!workshopLevel) {
      assert.doesNotMatch(html, /data-recipe-preparation=|data-recipe="make_planks"|Начать ·/);
      assert.match(html, /Сначала обустройте это место/);
      continue;
    }
    const preparation = section(html, recipe.name);
    assert.match(preparation, /Все рецепты/);
    assert.match(preparation, /2 \/ 1/);
    assert.equal(startDisabled(preparation), false);
    assert.match(html, /<div[^>]*hidden=""[^>]*aria-label="Продукция: Мастерская"/);
  }
});

test("recipe preparation replaces goal, slots, running jobs and upgrade controls with its own order screen", () => {
  const economy = controller({ inventory: { wood: 8 }, jobs: [{ id: "existing-planks", kind: "production", targetId: "workshop", recipeId: "make_planks", startedAt: new Date(now - 1_000).toISOString(), finishesAt: new Date(now + 30_000).toISOString(), rewards: { plank: 1 }, cost: { coins: 0, items: { wood: 2 } } }] });
  const goal = { goal: { buildingId: "home", targetLevel: 3 }, details: { goal: { buildingId: "home", targetLevel: 3 }, name: "Дом", cost: { coins: 100, items: { plank: 8 } }, missing: { coins: 0, items: { plank: 8 } }, keepItems: { wood: 8 }, excessItems: {}, reservesComplete: true }, pin() {}, clear() {} };
  const catalogue = renderMenu("workshop", economy, { constructionGoal: goal, onOpenGoal() {} });
  assert.match(catalogue, /data-running-orders="workshop"/);
  assert.match(catalogue, /aria-haspopup="dialog"/);
  const html = renderMenu("workshop", economy, { initialRecipeId: "make_planks", constructionGoal: goal, onOpenGoal() {} });
  assert.match(html, /data-recipe-preparation="make_planks"/);
  assert.match(html, /data-recipe-scroll="true"/);
  assert.match(html, /data-recipe-order="true"/);
  assert.doesNotMatch(html, /data-running-orders=|data-job-id=|aria-haspopup="dialog"|data-construction-goal-open/);
  assert.match(html, /Все рецепты/);
  assert.equal(startDisabled(html), true, "the occupied slot still blocks production even though its card is hidden");
});

test("a direct recipe from another station or an unknown recipe leaves the ordinary catalog visible", () => {
  const economy = controller({}, { act() { assert.fail("an invalid recipe cannot start production"); } });
  for (const initialRecipeId of ["grow_berries", "missing_recipe"]) {
    const html = renderMenu("workshop", economy, { initialStationId: "workshop", initialRecipeId });
    assert.match(section(html, "Доступные рецепты"), /data-recipe="make_planks"/);
    assert.doesNotMatch(html, /Начать ·|Все рецепты|<div[^>]*hidden=""[^>]*aria-label="Продукция:/);
  }
});

test("storage warning appears only when the selected result will not currently fit", () => {
  const available = { capacity: 50, used: 50, reserved: 0, available: 0, overflow: 0 };
  assert.match(renderRecipe("grow_berries", controller({ storage: available })), /Для получения понадобится 1 мест · свободно 0/);
  assert.doesNotMatch(renderRecipe("grow_berries", controller()), /Для получения понадобится|Место понадобится/);
});

test("recipe returns to its catalogue only after its own confirmed order, retaining failed or uncertain preparations", async () => {
  const hookModule = "virtual:production-preparation-hooks";
  const runtime = await createServer({ appType: "custom", configFile: false, root,
    resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false },
    plugins: [{ name: "production-preparation-hooks", enforce: "pre",
      resolveId(id) { if (id === hookModule) return `\0${id}`; },
      load(id) { if (id === `\0${hookModule}`) return `
        let slots = [], cursor = 0, effects = [];
        export function reset() { slots = []; cursor = 0; effects = []; }
        export function render() { cursor = 0; effects = []; }
        export function flush() { for (const effect of effects) effect(); }
        export function useRef(initial) { const index = cursor++; return slots[index] ??= { current: initial }; }
        export function useId() { return useRef('preparation-quantity').current; }
        export function useState(initial) { const slot = useRef(typeof initial === 'function' ? initial() : initial); return [slot.current, value => { slot.current = typeof value === 'function' ? value(slot.current) : value; }]; }
        export function useEffect(effect, dependencies) {
          const previous = useRef(null);
          if (!previous.current || dependencies.some((value, index) => !Object.is(value, previous.current[index]))) { previous.current = dependencies; effects.push(effect); }
        }
      `; },
      transform(source, id) { if (id.endsWith("/features/economy/ui/stations/world-object-menu.tsx")) return source.replace('from "react";', `from "${hookModule}";`); },
    }],
  });
  try {
    const hooks = await runtime.ssrLoadModule(hookModule);
    const { WorldRecipeDetail: Preparation } = await runtime.ssrLoadModule("/features/economy/ui/stations/world-object-menu.tsx");
    const recipeId = "make_planks";
    const newJob = id => ({ id, kind: "production", targetId: "workshop", recipeId, startedAt: new Date(now).toISOString(), finishesAt: new Date(now + 30_000).toISOString(), rewards: { plank: 1 }, cost: { coins: 0, items: { wood: 2 } } });
    for (const outcome of ["confirmed", "failed", "uncertain", "background"]) {
      hooks.reset(); let collapsed = 0;
      const calls = [];
      const economy = controller({ inventory: { wood: 8 } }, { act(...args) { calls.push(args); } });
      const props = { economy, recipe: economy.snapshot.catalog.recipes.find(recipe => recipe.id === recipeId), onCollapse() { collapsed++; } };
      const render = () => { hooks.render(); const tree = Preparation(props); hooks.flush(); return tree; };
      const elements = [];
      const walk = element => { if (isValidElement(element)) { elements.push(element); Children.forEach(element.props.children, walk); } };
      walk(render());
      assert.equal(collapsed, 0);
      if (outcome !== "background") {
        const action = elements.find(element => element.type === "button" && element.props.children?.[0] === "Начать · ");
        assert.ok(action); assert.equal(action.props.disabled, false);
        action.props.onClick();
        assert.deepEqual(calls, [["start_production", recipeId, 1]]);
        assert.equal(collapsed, 0, "sending alone must not leave the preparation");
        economy.busy = true; render();
        economy.busy = false;
      }
      economy.snapshot = { ...economy.snapshot, revision: 2, jobs: [newJob("confirmed-job")] };
      if (outcome === "failed") economy.error = "Заказ не создан";
      if (outcome === "uncertain") { economy.error = "Нет подтверждения"; economy.uncertain = true; }
      render();
      assert.equal(collapsed, outcome === "confirmed" ? 1 : 0, outcome);
      if (outcome === "uncertain") {
        economy.error = null; economy.uncertain = false; render();
        assert.equal(collapsed, 1, "a confirmed retry may safely return to the catalogue");
      }
      if (outcome === "failed") {
        economy.error = null; render();
        assert.equal(collapsed, 0, "later snapshots cannot revive an order intent after a definitive failure");
      }
      render();
      assert.ok(collapsed <= 1, "a consumed confirmation cannot keep moving focus");
    }
  } finally { await runtime.close(); }
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
    assert.equal(startDisabled(renderRecipe("make_planks", economy)), false);
  }
});
