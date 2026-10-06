import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { Children, createElement, isValidElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false } });
const { WorldObjectMenu, WorldRecipeDetail } = await vite.ssrLoadModule("/features/economy/world-object-menu.tsx");
const { WorldExpeditionSector, ExpeditionRouteDetails } = await vite.ssrLoadModule("/features/economy/world-expeditions-menu.tsx");
const { economyCatalog } = await vite.ssrLoadModule("/features/economy/model.ts");
const { economyStorage } = await vite.ssrLoadModule("/features/economy/rules.ts");
after(() => vite.close());

const now = Date.parse("2026-10-03T12:00:00Z");
function controller(overrides = {}, flags = {}) {
  const state = { ownerPublicId: "ME", revision: 1, serverTime: new Date(now).toISOString(), wallet: { coins: 100, pearls: 0 }, inventory: {},
    buildings: { home: 2, garden: 2, warehouse: 1, workshop: 2 }, jobs: [], completedExplorations: 0,
    migration: { version: 1, coinsGranted: 0, woodGranted: 0, stoneGranted: 0 }, catalog: structuredClone(economyCatalog), ...overrides };
  return { snapshot: { ...state, storage: overrides.storage ?? economyStorage(state) }, market: null, marketError: null, busy: false, uncertain: false, error: null, notice: "", now, retryAt: 0,
    act() {}, actMarket() {}, refresh() {}, refreshMarket() {}, retry() {}, ...flags };
}
function renderMenu(place, economy = controller()) {
  return renderToStaticMarkup(createElement(WorldObjectMenu, { selection: { place, objectId: `${place}.position`, x: 195, y: 380, viewportWidth: 390, viewportHeight: 844 }, economy, onClose() {} }));
}
function renderRecipe(id, economy = controller(), extra = {}) {
  return renderToStaticMarkup(createElement(WorldRecipeDetail, { economy, recipe: economy.snapshot.catalog.recipes.find(recipe => recipe.id === id), onCollapse() {}, ...extra }));
}
function section(html, label) {
  const match = html.match(new RegExp(`<section[^>]*aria-label="${label}"[^>]*>([\\s\\S]*?)</section>`));
  assert.ok(match, `Missing section: ${label}`);
  return match[1];
}
function laterRecipes(html) {
  const sections = [...html.matchAll(/<details\b([^>]*)>([\s\S]*?)<\/details>/g)];
  const match = sections.find(([, , content]) => /<summary[^>]*>[\s\S]*?<span>Позже<\/span>/.test(content));
  assert.ok(match, "Missing later recipe disclosure");
  return { attributes: match[1], content: match[2] };
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
      economy: trackedEconomy, state: economy.snapshot, exploring: economy.snapshot.jobs.some(job => job.kind === "exploration"), onOpenPantry() {} });
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
    && element.props["aria-label"] === "Отправиться: Добыть камень") };
}

test("workshop separates ordinary recipes, long batches and unmet unlocks", () => {
  const html = renderMenu("workshop");
  const ordinary = section(html, "Обычные заказы");
  const long = section(html, "На несколько часов");
  const later = laterRecipes(html);
  assert.doesNotMatch(later.attributes, /\bopen/);
  for (const id of ["make_planks", "make_rope", "weave_cloth"]) assert.ok(ordinary.includes(`data-recipe="${id}"`));
  assert.match(long, /data-recipe="workshop_overnight"/);
  assert.doesNotMatch(ordinary + long, /data-recipe="make_metal_parts"|data-recipe="make_tools"/);
  assert.match(later.content, /data-recipe="make_metal_parts"/);
  assert.match(later.content, /data-recipe="make_tools"/);
  assert.doesNotMatch(html, /aria-label="Стоимость"|Недостающие условия|Начать ·/);
});

test("unlocking an external station moves its recipe into ordinary orders", () => {
  const html = renderMenu("workshop", controller({ buildings: { home: 2, workshop: 2, kiln: 2, warehouse: 1 } }));
  assert.match(section(html, "Обычные заказы"), /data-recipe="make_metal_parts"/);
  const later = laterRecipes(html);
  assert.doesNotMatch(later.content, /data-recipe="make_metal_parts"/);
});

test("harvest cards distinguish quantity and time while keeping the result name short", () => {
  const html = renderMenu("garden", controller({ buildings: { home: 1, garden: 1, warehouse: 1 } }));
  const ordinary = section(html, "Обычные заказы");
  const long = section(html, "На несколько часов");
  assert.match(ordinary, /<strong>Лесные ягоды<\/strong>/);
  assert.match(ordinary, /×4<\/b>/);
  assert.match(ordinary, /15 мин/);
  assert.match(long, /<strong>Лесные ягоды<\/strong>/);
  assert.match(long, /×32<\/b>/);
  assert.match(long, /8 ч/);
});

test("selected recipe shows actual multi-item rewards and only its own costs", () => {
  const html = renderRecipe("workshop_overnight", controller({ inventory: { wood: 12, fiber: 20 } }));
  assert.match(html, /Все рецепты/);
  for (const amount of [6, 4, 1]) assert.match(html, new RegExp(`×${amount}</b>`));
  assert.match(html, /Понадобится/);
  assert.match(html, /12 \/ 12/);
  assert.match(html, /20 \/ 20/);
  assert.equal(startDisabled(html), false);
  assert.doesNotMatch(html, /Обычные заказы|На несколько часов|data-recipe=/);
});

test("selection preserves missing-material navigation and all request locks", () => {
  const navigation = { open() {}, canOpen() { return true; }, explore() {} };
  const missing = renderRecipe("make_planks", controller(), { navigation });
  assert.equal(startDisabled(missing), true);
  assert.match(missing, /aria-label="Где получить: Древесина, В путь"/);
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

test("storage warning appears only when the selected result will not currently fit", () => {
  const available = { capacity: 200, used: 198, reserved: 0, available: 2, overflow: 0 };
  assert.match(renderRecipe("grow_berries", controller({ storage: available })), /Для получения понадобится 4 мест · свободно 2/);
  assert.doesNotMatch(renderRecipe("grow_berries", controller()), /Для получения понадобится|Место понадобится/);
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
    if (occupied.kind === "exploration") {
      assert.equal(departure, undefined, "a current or unclaimed trip has a claim/recall card instead of another departure");
      assert.match(preparation.html, /Сначала заберите находки или отмените текущую вылазку/);
    } else {
      assert.ok(departure);
      assert.equal(departure.props.disabled, true);
      assert.match(preparation.html, /Сначала завершите сбор припасов/);
      departure.props.onClick();
    }
    assert.deepEqual(preparation.calls, [], "busy heroes cannot dispatch another departure from preparation");
    assert.equal(startDisabled(renderRecipe("make_planks", economy)), false);
  }
});
