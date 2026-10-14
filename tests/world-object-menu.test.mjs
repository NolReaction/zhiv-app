import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { createElement } from "react";
import { Dialog } from "radix-ui";
import { renderToStaticMarkup } from "react-dom/server";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false } });
const helpers = await vite.ssrLoadModule("/features/economy/ui/shared/world-stations.ts");
const { WorldObjectMenu, WorldObjectSale } = await vite.ssrLoadModule("/features/economy/ui/stations/world-object-menu.tsx");
const { WorldExpeditionSector } = await vite.ssrLoadModule("/features/economy/ui/expeditions/world-expeditions-menu.tsx");
const { WorldUpgradeContent } = await vite.ssrLoadModule("/features/economy/ui/construction/world-upgrade-dialog.tsx");
const { ProductionActivity } = await vite.ssrLoadModule("/features/economy/ui/production/production-activity.tsx");
const { economyCatalog } = await vite.ssrLoadModule("/features/economy/domain/model.ts");
const { economyStorage } = await vite.ssrLoadModule("/features/economy/domain/rules.ts");
const { newTutorialOrder } = await vite.ssrLoadModule("/features/economy/domain/tutorial-order.ts");
after(() => vite.close());

const now = Date.parse("2026-10-03T12:00:00Z");
function snapshot(overrides = {}) {
  const result = { ownerPublicId: "ME", revision: 7, serverTime: new Date(now).toISOString(), wallet: { coins: 0, pearls: 0 }, inventory: {},
    buildings: { home: 1, garden: 1, warehouse: 1 }, jobs: [], completedExplorations: 0,
    migration: { version: 1, coinsGranted: 0, woodGranted: 0, stoneGranted: 0 }, catalog: structuredClone(economyCatalog), ...overrides };
  return { ...result, storage: overrides.storage ?? economyStorage(result) };
}
function controller(overrides = {}) {
  return { snapshot: snapshot(), market: null, marketError: null, busy: false, uncertain: false, error: null, notice: "", now, retryAt: 0,
    act() {}, actMarket() {}, refresh() {}, refreshMarket() {}, retry() {}, ...overrides };
}
function job(overrides = {}) {
  return { id: "da818fb4-6c9e-4b42-9b78-60669b234f0a", kind: "production", targetId: "garden", recipeId: "grow_berries", targetLevel: null,
    startedAt: new Date(now - 100_000).toISOString(), finishesAt: new Date(now + 500_000).toISOString(), rewards: { berries: 6 },
    cost: { coins: 0, items: {} }, catalogVersion: 2, ...overrides };
}

test("workbench illustration follows only an active production timer and stops for ready or construction jobs", () => {
  const recipe = economyCatalog.recipes.find(entry => entry.buildingId === "dryer");
  const active = job({ targetId: recipe.buildingId, recipeId: recipe.id, rewards: recipe.rewards });
  const state = snapshot({ buildings: { home: 1, dryer: 1, warehouse: 1 }, jobs: [active] });
  assert.match(render("campfire", controller({ snapshot: state })), /data-production-activity="dryer"/);
  active.finishesAt = new Date(now).toISOString();
  assert.doesNotMatch(render("campfire", controller({ snapshot: state })), /data-production-activity/);
  active.finishesAt = "invalid";
  assert.equal(renderToStaticMarkup(createElement(ProductionActivity, { job: active, now })), "");
  active.startedAt = new Date(now + 1_000).toISOString();
  active.finishesAt = new Date(now + 500_000).toISOString();
  assert.doesNotMatch(render("campfire", controller({ snapshot: state })), /data-production-activity/);
  assert.equal(renderToStaticMarkup(createElement(ProductionActivity, { job: active, now: NaN })), "");
  active.startedAt = active.finishesAt;
  assert.doesNotMatch(render("campfire", controller({ snapshot: state })), /data-production-activity/);
  active.startedAt = new Date(now - 100_000).toISOString();
  active.finishesAt = new Date(now + 500_000).toISOString();
  active.kind = "construction"; active.targetLevel = 2; active.recipeId = null;
  assert.doesNotMatch(render("campfire", controller({ snapshot: state })), /data-production-activity/);
  state.jobs = [];
  assert.doesNotMatch(render("campfire", controller({ snapshot: state })), /data-production-activity/);
});
function render(place, economy = controller(), extra = {}) {
  return renderToStaticMarkup(createElement(WorldObjectMenu, { selection: { place, objectId: `${place}.position`, x: 195, y: 380, viewportWidth: 390, viewportHeight: 844 }, economy, onClose() {}, ...extra }));
}
function renderUpgrade(stationId, economy = controller(), extra = {}) {
  return renderToStaticMarkup(createElement(Dialog.Root, { open: true }, createElement(WorldUpgradeContent, { stationId, economy, onClose() {}, onOpenPantry() {}, ...extra })));
}
function button(html, text) {
  const found = [...html.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)].map(match => ({ attributes: match[1], text: match[2].replace(/<[^>]*>/g, "") })).find(entry => entry.text.includes(text));
  assert.ok(found, `Missing button: ${text}`);
  return found;
}

test("ordinary workshop menus hide future recipes while upgrade previews keep them discoverable", () => {
  const state = snapshot({ buildings: { home: 2, workshop: 1, warehouse: 1 } });
  const economy = controller({ snapshot: state });
  const next = state.catalog.recipes.find(recipe => recipe.buildingId === "workshop" && recipe.buildingLevel === 2);
  assert.ok(next);
  const initial = render("workshop", economy);
  assert.match(initial, /data-recipe=/);
  assert.doesNotMatch(initial, /Позже|пока закрыто/);
  assert.ok(!initial.includes(`data-recipe="${next.id}"`));
  const stale = render("workshop", economy, { initialRecipeId: next.id });
  assert.ok(!stale.includes(`data-recipe="${next.id}"`));
  assert.ok(renderUpgrade("workshop", economy).includes(`data-recipe="${next.id}"`));
  state.buildings.home = 3;
  state.buildings.workshop = 2;
  assert.ok(!render("workshop", economy).includes(`data-recipe="${next.id}"`), "other building prerequisites remain necessary");
  state.buildings.kiln = 2;
  assert.ok(render("workshop", economy).includes(`data-recipe="${next.id}"`), "opening the recipe reveals it despite empty materials");
});
const disabled = entry => /\bdisabled=/.test(entry.attributes);

test("production slots are available at home one with pearl gates and keep all orders claimable", () => {
  let state = snapshot({ buildings: { home: 1, garden: 1 }, wallet: { coins: 0, pearls: 10000 } });
  let html = render("garden", controller({ snapshot: state }));
  assert.match(html, /data-production-slots="garden"/);
  assert.doesNotMatch(html, /Нужен дом 2 уровня/);
  assert.equal(disabled(button(html, "Место 2")), false);
  state.buildings.home = 2;
  html = render("garden", controller({ snapshot: state }));
  assert.equal(disabled(button(html, "Место 2")), false);
  assert.match(html, /Открыть место 2 за 100 жемчужин/);
  state.wallet.pearls = 199;
  html = render("garden", controller({ snapshot: state }));
  assert.equal(disabled(button(html, "Место 2")), true);
  assert.match(html, /Не хватает жемчужин: 0,5/);
  state.wallet.pearls = 10000; state.productionSlots = { garden: 2 };
  html = render("garden", controller({ snapshot: state }));
  assert.doesNotMatch(html, /Нужен дом 4 уровня/);
  assert.match(html, /Открыть место 3 за 250 жемчужин/);
  assert.equal(disabled(button(html, "Место 3")), false);
  state.buildings.home = 4;
  assert.equal(disabled(button(render("garden", controller({ snapshot: state })), "Место 3")), false);
  assert.equal(disabled(button(render("garden", controller({ snapshot: state, uncertain: true })), "Место 3")), true);
  assert.equal(disabled(button(render("garden", controller({ snapshot: state, busy: true })), "Место 3")), true);
  state.productionSlots.garden = 3;
  state.jobs = [job({ id: "crop-a", finishesAt: new Date(now).toISOString() }), job({ id: "crop-b" }), job({ id: "crop-c" })];
  html = render("garden", controller({ snapshot: state }));
  assert.match(html, /Свободно <span[^>]*>0 из 3<\/span>/);
  assert.doesNotMatch(html, /Открыть место/);
  for (const id of ["crop-a", "crop-b", "crop-c"]) assert.match(html, new RegExp(`data-job-id="${id}"`));
  assert.match(html, /data-state="ready"/);
  const upgraded = renderUpgrade("garden", controller({ snapshot: state }));
  for (const id of ["crop-a", "crop-b", "crop-c"]) assert.match(upgraded, new RegExp(`data-job-id="${id}"`));
  assert.doesNotMatch(render("quarry", controller({ snapshot: state })), /data-production-slots=/);
});

test("a second recipe uses the remaining station slot while ready results and construction still block", () => {
  const recipe = economyCatalog.recipes.find(entry => entry.buildingId === "workshop");
  const current = job({ targetId: "workshop", recipeId: recipe.id, rewards: recipe.rewards, finishesAt: new Date(now - 1).toISOString() });
  const state = snapshot({ buildings: { home: 5, workshop: 5, warehouse: 5 }, inventory: { wood: 1000 }, wallet: { coins: 100000, pearls: 10000 }, productionSlots: { workshop: 2 }, jobs: [current] });
  assert.equal(helpers.worldProductionReason(state, recipe), null);
  state.jobs.push({ ...current, id: "second-order" });
  assert.match(helpers.worldProductionReason(state, recipe), /Все места заняты/);
  state.jobs.pop(); state.jobs[0].kind = "construction";
  assert.match(helpers.worldProductionReason(state, recipe), /завершите улучшение/);
  assert.equal(disabled(button(render("workshop", controller({ snapshot: state })), "Место 3")), true);
});

test("idle production opens with a compact slot summary and recipes, leaving slot purchases inside a closed disclosure", () => {
  const buildings = { home: 5, workshop: 5, kiln: 5, garden: 5, woodlot: 5, dryer: 5, warehouse: 5 };
  for (const [place, stationId] of [["workshop", "workshop"], ["workshop", "kiln"], ["garden", "garden"], ["woodlot", "woodlot"], ["campfire", "dryer"]]) {
    const html = render(place, controller({ snapshot: snapshot({ buildings, wallet: { coins: 0, pearls: 10000 } }) }), { initialStationId: stationId });
    const disclosure = html.match(new RegExp(`<details\\b([^>]*data-production-slots="${stationId}"[^>]*)>([\\s\\S]*?)</details>`));
    assert.ok(disclosure, `Missing slots disclosure for ${stationId}`);
    assert.doesNotMatch(disclosure[1], /\bopen(?:=|\s|$)/);
    const summary = disclosure[2].match(/<summary\b[^>]*>[\s\S]*?<\/summary>/)?.[0];
    assert.match(summary, /Места производства: занято 0 из 1\. Расширить/);
    assert.doesNotMatch(summary, /<button|750|Не хватает/);
    assert.match(disclosure[2].slice(summary.length), /Открыть место 2 за 100 жемчужин/);
    const rest = html.replace(disclosure[0], "");
    assert.match(rest, /data-recipe=/);
    assert.doesNotMatch(rest, /data-running-orders=|Все уровни оборудования открыты/);
  }
});

test("current orders expose each result and timer immediately, then move ready claims first", () => {
  const recipe = economyCatalog.recipes.find(entry => entry.buildingId === "workshop");
  const jobs = [3, 1, 2].map(index => job({ id: `order-${index}`, targetId: "workshop", recipeId: recipe.id, rewards: { planks: index },
    finishesAt: new Date(now + index * 60000).toISOString() }));
  const state = snapshot({ buildings: { home: 5, workshop: 5, warehouse: 5 }, productionSlots: { workshop: 3 }, jobs });
  const economy = controller({ snapshot: state });
  let html = render("workshop", economy);
  const current = html.match(/<section[^>]*aria-label="Текущая работа"[^>]*>([\s\S]*?)<\/section>/)?.[1];
  assert.ok(current);
  assert.doesNotMatch(current, /<details|<summary|<button/);
  for (const entry of jobs) {
    assert.match(current, new RegExp(`data-job-id="${entry.id}"`));
    assert.match(current, new RegExp(`Доска ×${entry.rewards.planks}`));
    assert.match(current, new RegExp(`Осталось ${entry.rewards.planks} мин`));
  }
  assert.match(html, /data-recipe=/);
  economy.now += 60000;
  html = render("workshop", economy);
  assert.match(html, /data-job-id="order-1" data-ready="true"/);
  assert.ok(html.indexOf('data-job-id="order-1"') < html.indexOf('data-job-id="order-3"'));
  assert.equal(disabled(button(html, "Забрать")), false);
  assert.equal(state.jobs.length, 3, "view changes must not claim or remove an order");
});

test("map objects group equipment by place, with campfire food and pantry at the house", () => {
  assert.deepEqual(helpers.worldStations.house.stationIds, ["home", "warehouse"]);
  assert.deepEqual(helpers.worldStations.workshop.stationIds, ["workshop", "kiln"]);
  assert.deepEqual(helpers.worldStations.campfire.stationIds, ["dryer"]);
  for (const id of ["home", "warehouse", "garden", "dryer", "workshop", "kiln", "quarry", "woodlot", "bridge", "lighthouse"]) assert.ok(helpers.worldPlaceForStation(id));
  assert.equal(helpers.worldPlaceForStation("unknown"), null);
});

test("portrait production sheet uses the useful map height and stays between the HUD and dock", () => {
  const selection = { x: 195, y: 405, viewportWidth: 390, viewportHeight: 844 };
  const bounds = { top: 120, right: 8, bottom: 110, left: 8 };
  const dimensions = helpers.worldMenuDimensions(selection, bounds);
  assert.equal(dimensions.width, 374);
  assert.ok(dimensions.maxHeight >= 480 && dimensions.maxHeight <= 844 - 230);
  const placed = helpers.worldStableMenuPosition(selection, bounds);
  assert.equal(placed.side, "sheet");
  assert.ok(placed.x >= 8 && placed.x + placed.width <= 382);
  assert.ok(placed.y >= 120 && placed.y + placed.height <= 734);
  assert.ok(placed.height >= 480, "recipe materials and the fixed order action must have useful space");
});

test("portrait production overview fits its contents above the dock while preparation keeps a fixed height", () => {
  const bounds = { top: 120, right: 12, bottom: 110, left: 12 };
  const selectedStyle = html => html.match(/<section[^>]*role="dialog"[^>]*style="([^"]+)"/)?.[1];
  const overview = selectedStyle(render("garden", controller(), { bounds }));
  assert.ok(overview);
  assert.match(overview, /(?:^|;)bottom:110px/);
  assert.match(overview, /(?:^|;)max-height:[0-9]+px/);
  assert.doesNotMatch(overview, /(?:^|;)(?:height|top):/);
  const preparation = selectedStyle(render("garden", controller(), { bounds, initialRecipeId: "grow_berries" }));
  assert.ok(preparation);
  assert.match(preparation, /(?:^|;)height:[0-9]+px/);
  assert.match(preparation, /(?:^|;)top:[0-9]+px/);
  assert.doesNotMatch(preparation, /(?:^|;)bottom:/);
});

test("landscape uses available map height and anchors beside the object instead of a zero-height body", () => {
  const selection = { x: 420, y: 210, viewportWidth: 844, viewportHeight: 390 };
  const bounds = { top: 140, bottom: 90 };
  const dimensions = helpers.worldMenuDimensions(selection, bounds);
  assert.equal(dimensions.maxHeight, 160);
  const placed = helpers.worldMenuPosition(selection, { width: dimensions.width, height: dimensions.maxHeight }, bounds);
  assert.ok(placed.y >= 140 && placed.y + placed.height <= 300);
  assert.ok(selection.x < placed.x || selection.x > placed.x + placed.width);
  assert.ok(["right", "left"].includes(placed.side));
});

test("small viewport edge anchors still stay inside safe insets", () => {
  const bounds = { top: 80, right: 16, bottom: 90, left: 16 };
  for (const x of [0, 160, 319]) for (const y of [0, 220, 567]) {
    const selection = { x, y, viewportWidth: 320, viewportHeight: 568 };
    const dimensions = helpers.worldMenuDimensions(selection, bounds);
    const placed = helpers.worldMenuPosition(selection, { width: dimensions.width, height: dimensions.maxHeight }, bounds);
    assert.ok(placed.x >= 16 && placed.x + placed.width <= 304);
    assert.ok(placed.y >= 80 && placed.y + placed.height <= 478);
  }
});

test("small portrait pantry keeps useful content height between the HUD and camera controls", () => {
  const bounds = { top: 140, right: 8, bottom: 116, left: 8 };
  for (const y of [140, 284, 452]) {
    const selection = { x: 160, y, viewportWidth: 320, viewportHeight: 568 };
    const dimensions = helpers.worldMenuDimensions(selection, bounds);
    assert.ok(dimensions.maxHeight >= 280, "header, station tabs and footer must leave room for pantry contents");
    const placed = helpers.worldStableMenuPosition(selection, bounds);
    assert.ok(placed.height >= 280);
    assert.ok(placed.x >= 8 && placed.x + placed.width <= 312);
    assert.ok(placed.y >= 140 && placed.y + placed.height <= 452);
  }
});

test("catalog gates and current stock determine construction availability together", () => {
  const state = snapshot({ buildings: { home: 3, warehouse: 1, workshop: 3, kiln: 3 } });
  const target = { level: 1, requiredHomeLevel: 4, requiredBuildings: { kiln: 4 }, seconds: 90, cost: { coins: 1740, items: { glass: 7 } } };
  assert.deepEqual(helpers.worldRequirements(target), { kiln: 4, home: 4 });
  assert.match(helpers.worldConstructionReason(state, "quarry", target), /уровень 4/);
  state.buildings.home = 4; state.buildings.kiln = 4; state.wallet.coins = 1740; state.inventory.glass = 6;
  assert.deepEqual(helpers.worldCostShortfalls(state, target.cost), [{ id: "glass", required: 7, available: 6 }]);
  assert.match(helpers.worldConstructionReason(state, "quarry", target), /материалов/);
  state.inventory.glass = 7;
  assert.equal(helpers.worldConstructionReason(state, "quarry", target), null);
  state.jobs = [job({ kind: "construction", targetId: "home", recipeId: null, targetLevel: 5, rewards: {}, finishesAt: new Date(now).toISOString() })];
  assert.match(helpers.worldConstructionReason(state, "quarry", target), /текущую стройку/);
});

test("batches use full capacity; unclaimed work still occupies the station", () => {
  const state = snapshot({ storage: { capacity: 200, used: 195, reserved: 0, available: 5, overflow: 0 } });
  const recipe = { ...state.catalog.recipes.find(entry => entry.id === "grow_berries"), rewards: { berries: 70, fiber: 20 }, maxBatch: 10 };
  assert.equal(helpers.worldBatchLimit(state, { ...recipe, maxBatch: 1 }), 1);
  assert.equal(helpers.worldBatchLimit(state, recipe), 2);
  assert.equal(helpers.worldProductionReason(state, recipe, 2), null);
  assert.match(helpers.worldProductionReason(state, recipe, 3), /партию/);
  state.jobs = [job({ finishesAt: new Date(now).toISOString() })];
  assert.match(helpers.worldProductionReason(state, recipe), /сначала заберите/);
});

test("starter stone sources use an available forest exploration instead of the locked mine", () => {
  const state = snapshot();
  const source = helpers.worldMaterialSource(state, "stone");
  assert.equal(source.kind, "exploration");
  const route = state.catalog.explorations.find(entry => entry.id === source.targetId);
  assert.ok(route.rewards.stone > 0);
  assert.deepEqual(helpers.worldMissingRequirements(state, helpers.worldRequirements(route)), []);
  const html = renderUpgrade("woodlot", controller({ snapshot: state }), { navigation: { open() {}, canOpen() { return true; }, explore() {} } });
  assert.match(html, /aria-label="Где получить: Камень, В путь\. Есть 0, нужно [0-9]+"/);
  state.buildings.home = 2; state.buildings.quarry = 1;
  assert.equal(helpers.worldMaterialSource(state, "stone").kind, "exploration");
  assert.equal(helpers.worldMaterialSource(state, "stone").targetId, "quarry_stone");
  assert.equal(helpers.worldMaterialSource(state, "clay").targetId, "quarry_clay");
  state.buildings.quarry = 0;
  assert.equal(helpers.worldMaterialSource(state, "stone").targetId, "quarry_stone", "the second stage directs stone to its mine construction");
});

test("first-stage preparation produces one item and strawberry unlock shows the real compote prerequisite", () => {
  const state = snapshot({ buildings: { home: 1, garden: 1, warehouse: 1, dryer: 1, workshop: 1, woodlot: 1 },
    inventory: { berries: 4, wood: 2, fish_common: 1 }, progression: { recipes: {} } });
  for (const [place, stationId, recipeId] of [["garden", "garden", "grow_berries"], ["workshop", "workshop", "make_planks"],
    ["campfire", "dryer", "cook_compote"], ["woodlot", "woodlot", "gather_wood"]]) {
    const recipe = state.catalog.recipes.find(entry => entry.id === recipeId);
    assert.ok(recipe, recipeId);
    const html = render(place, controller({ snapshot: state }), { initialStationId: stationId, initialRecipeId: recipeId });
    assert.match(html, /1 предмет · 1 место производства/);
    assert.doesNotMatch(html, /Увеличить партию|Уменьшить партию|<label[^>]*>Партий/);
    assert.equal(disabled(button(html, "Начать ·")), false);
  }
  const recipe = state.catalog.recipes.find(entry => entry.id === "grow_strawberries");
  let html = render("garden", controller({ snapshot: state }), { initialRecipeId: recipe.id, onNavigate() {} });
  assert.match(html, /Сначала приготовьте:.*компот/);
  assert.match(html, /Приготовить:.*компот/);
  assert.equal(disabled(button(html, "Начать ·")), true);
  assert.equal(helpers.worldRecipeUnlockReason(state, recipe).includes("0 / 1"), true);
  state.progression.recipes.cook_compote = 1;
  html = render("garden", controller({ snapshot: state }), { initialRecipeId: recipe.id });
  assert.doesNotMatch(html, /Сначала приготовьте:|Приготовить:/);
  assert.equal(disabled(button(html, "Начать ·")), false);
});

test("new house two requires the four confirmed tutorial requests even with enough stock and coins", () => {
  const state = snapshot({ wallet: { coins: 250, pearls: 0 }, inventory: { wood: 3, stone: 2, planks: 2 },
    buildings: { home: 1, warehouse: 1, garden: 1, woodlot: 1, dryer: 1, workshop: 1 }, tutorialOrder: newTutorialOrder() });
  const target = state.catalog.buildings.find(entry => entry.id === "home").levels.find(entry => entry.level === 2);
  assert.match(helpers.worldConstructionReason(state, "home", target), /учебные заказы: 0 \/ 4/);
  state.tutorialOrder.step = 3;
  assert.match(renderUpgrade("home", controller({ snapshot: state })), /учебные заказы: 3 \/ 4/);
  state.tutorialOrder.step = 4; state.tutorialOrder.completed = true;
  assert.equal(helpers.worldConstructionReason(state, "home", target), null);
  delete state.tutorialOrder;
  assert.equal(helpers.worldConstructionReason(state, "home", target), null, "legacy profiles keep their previous building access");
});

test("new house three requires seven stage requests and workshop one, quarry two and kiln one with warehouse one", () => {
  const target = economyCatalog.buildings.find(entry => entry.id === "home").levels.find(entry => entry.level === 3);
  assert.deepEqual(target.requiredBuildings, { workshop: 1, quarry: 2, kiln: 1 });
  const state = snapshot({ wallet: { coins: target.cost.coins, pearls: 0 }, inventory: { ...target.cost.items },
    buildings: { home: 2, warehouse: 1, garden: 1, woodlot: 1, dryer: 1, workshop: 1, quarry: 2, kiln: 1 },
    tutorialOrder: { ...newTutorialOrder(), step: 4, completed: true },
    stageOrders: { version: 1, stages: { 2: { step: 0, completed: false, terms: null } } } });
  assert.match(helpers.worldConstructionReason(state, "home", target), /заказы.*0 \/ 7/i);
  assert.match(renderUpgrade("home", controller({ snapshot: state })), /0 \/ 7/);
  state.stageOrders.stages[2].step = 6;
  assert.match(helpers.worldConstructionReason(state, "home", target), /заказы.*6 \/ 7/i);
  state.stageOrders.stages[2] = { step: 7, completed: true, terms: null };
  assert.equal(helpers.worldConstructionReason(state, "home", target), null);
  assert.equal(state.storage.capacity, 50);
  assert.equal(disabled(button(renderUpgrade("home", controller({ snapshot: state })), "Улучшить до ур. 3")), false);
  for (const [id, level] of [["workshop", 0], ["quarry", 1], ["kiln", 0]]) {
    const before = state.buildings[id]; state.buildings[id] = level;
    assert.notEqual(helpers.worldConstructionReason(state, "home", target), null, id);
    state.buildings[id] = before;
  }
  state.stageOrders.stages[2] = { step: 5, completed: true, terms: null };
  assert.equal(helpers.worldConstructionReason(state, "home", target), null, "the completed previous five-request course does not reopen");
  delete state.tutorialOrder; delete state.stageOrders;
  assert.equal(helpers.worldConstructionReason(state, "home", target), null, "legacy accounts keep the previous course-free access");
});

test("berry collection uses the server clock and pantry space while construction can finish with a full pantry", () => {
  const state = snapshot({ storage: { capacity: 200, used: 197, reserved: 0, available: 3, overflow: 0 } });
  const growing = job({ collection: { kind: "berry_harvest", seconds: 8, startedAt: null, finishesAt: null } });
  assert.equal(helpers.worldJobProgress(state, growing, now).ready, false);
  const growth = render("garden", controller({ snapshot: snapshot({ jobs: [growing] }) }));
  assert.match(growth, /Малина ×6|Осталось/);
  assert.doesNotMatch(growth, /aria-label="(?:Растут|Собрать):/);
  const ready = { ...growing, finishesAt: new Date(now).toISOString() };
  assert.deepEqual(helpers.worldJobProgress(state, ready, now), { ready: true, progress: 1, seconds: 0, storageShortfall: 3 });
  let html = render("garden", controller({ snapshot: { ...state, jobs: [ready] } }));
  assert.equal(disabled(button(html, "Собрать")), true);
  assert.match(html, /освободить 3 мест/);
  html = render("garden", controller({ snapshot: snapshot({ jobs: [ready] }) }));
  assert.equal(disabled(button(html, "Собрать")), false);
  const collected = { ...ready, collection: { ...ready.collection, startedAt: new Date(now - 8_000).toISOString(), finishesAt: new Date(now).toISOString() } };
  assert.equal(disabled(button(render("garden", controller({ snapshot: { ...state, jobs: [collected] } })), "В кладовую")), true);
  assert.equal(disabled(button(render("garden", controller({ snapshot: snapshot({ jobs: [collected] }) })), "В кладовую")), false);

  const construction = job({ kind: "construction", targetId: "home", recipeId: null, targetLevel: 2, rewards: {}, finishesAt: new Date(now).toISOString() });
  const full = snapshot({ storage: { capacity: 200, used: 200, reserved: 0, available: 0, overflow: 0 }, jobs: [construction] });
  assert.equal(helpers.worldJobProgress(full, construction, now).storageShortfall, 0);
  assert.equal(disabled(button(renderUpgrade("home", controller({ snapshot: full })), "Завершить")), false);
});

test("map menu is compact and nonmodal with place-specific production rather than all stations", () => {
  const html = render("garden");
  assert.match(html, /role="dialog" aria-modal="false"/);
  assert.match(html, /Ягодный куст/);
  assert.match(html, /aria-label="Вырастить малину/);
  assert.doesNotMatch(html, /aria-label="[^\"]*(Выплавить|Доски|Рыбу)/);
  assert.equal(disabled(button(render("workshop"), "Мастерская")), false);
  assert.doesNotMatch(renderUpgrade("home"), /<button[^>]*>[^<]*Кладовая/);
  assert.doesNotMatch(html, /Начать ·/);
});

test("the mine has one independent route picker without production tabs or paid slots and keeps upgrade gates", () => {
  const prepareMine = state => renderToStaticMarkup(createElement(WorldExpeditionSector, {
    sectorId: "caves", selectedRoute: "quarry_stone", onSelectRoute() {}, economy: controller({ snapshot: state }), state,
    exploring: false, embeddedCaves: true, onOpenPantry() {}, onNavigateStation() {},
  }));
  const initialState = snapshot();
  const initial = render("quarry", controller({ snapshot: initialState }));
  assert.match(initial, /data-sector="caves"/);
  assert.doesNotMatch(initial, /data-quarry-tab|data-recipe=|Секторы вылазок|data-production-slots/);
  assert.doesNotMatch(initial, /data-route=|aria-label="Начать добычу:|data-route-preparation=/);
  assert.doesNotMatch(prepareMine(initialState), /data-route=|aria-label="Начать добычу:/);
  assert.equal(disabled(button(initial, "Открыть")), false);
  const unbuiltState = snapshot({ buildings: { home: 2, warehouse: 1, quarry: 0 } });
  const unbuilt = render("quarry", controller({ snapshot: unbuiltState }));
  assert.match(unbuilt, /data-route="quarry_stone"/);
  assert.doesNotMatch(unbuilt, /Вход в пещеру|Просеять песок|data-production-slots/);
  assert.match(prepareMine(unbuiltState), /Каменоломня · нужен ур. 1/);
  assert.equal(disabled(button(prepareMine(unbuiltState), "Начать добычу")), true);
  assert.match(renderUpgrade("quarry", controller({ snapshot: unbuiltState })), /Добыть камень/,
    "the first mine level shows its actual stone route");
  const builtState = snapshot({ buildings: { home: 2, warehouse: 1, quarry: 1 } });
  assert.doesNotMatch(button(render("quarry", controller({ snapshot: builtState })), "Добыть камень").attributes, /data-locked="true"/);
  assert.doesNotMatch(render("quarry", controller({ snapshot: builtState })), /Вход в пещеру/);
  assert.equal(disabled(button(prepareMine(builtState), "Начать добычу")), false, "a completed quarry opens one stone per free launch");
  for (const finishesAt of [new Date(now + 500_000).toISOString(), new Date(now).toISOString()]) {
    const upgradingState = snapshot({ buildings: builtState.buildings, jobs: [job({ kind: "construction", targetId: "quarry", recipeId: null, targetLevel: 2, rewards: {}, finishesAt })] });
    const upgradingPreparation = prepareMine(upgradingState);
    assert.equal(disabled(button(upgradingPreparation, "Начать добычу")), true, "the site remains occupied until its construction result is claimed");
    assert.match(upgradingPreparation, /Дождитесь улучшения шахты и заберите результат/);
    assert.equal(disabled(button(render("quarry", controller({ snapshot: upgradingState })), "Стройка")), false);
  }
  const fullMine = render("quarry", controller({ snapshot: snapshot({ buildings: { home: 5, warehouse: 5, quarry: 5 } }) }));
  assert.doesNotMatch(fullMine, /data-route="quarry_shift"|data-route="quarry_deep_face"/);
  assert.match(fullMine, /data-route="quarry_supply"/);
});

test("legacy simultaneous quarry and expedition jobs remain claimable in the unified mine", () => {
  const quarry = job({ targetId: "quarry", recipeId: "quarry_stone", rewards: { stone: 8 }, finishesAt: new Date(now).toISOString() });
  const expedition = job({ id: "trip", kind: "exploration", targetId: "cave", recipeId: null, rewards: { stone: 8, ore: 4 }, finishesAt: new Date(now).toISOString() });
  const economy = controller({ snapshot: snapshot({ buildings: { home: 2, warehouse: 1, quarry: 1 }, jobs: [quarry, expedition] }) });
  const html = render("quarry", economy);
  assert.equal(disabled(button(html, "Забрать")), false);
  assert.match(html, /aria-label="Забрать находки: Вход в пещеру"/);
  assert.match(html, /Отказаться от находок/);
  economy.snapshot.storage = { capacity: 200, used: 200, reserved: 0, available: 0, overflow: 0 };
  const full = render("quarry", economy, { onOpenPantry() {} });
  assert.equal(disabled(button(full, "Забрать")), true);
  assert.equal(disabled(button(full, "К кладовой")), false);
  assert.equal(disabled(button(full, "Открыть кладовую")), false);
  assert.equal(disabled(button(full, "Отказаться от находок")), false);
});

test("berry harvest explains quarry occupation and becomes available when its timer ends", () => {
  const crop = job({ finishesAt: new Date(now).toISOString(), collection: { kind: "berry_harvest", seconds: 8, startedAt: null, finishesAt: null } });
  const quarry = job({ id: "quarry", targetId: "quarry", collection: null, finishesAt: new Date(now + 30_000).toISOString() });
  const economy = controller({ snapshot: snapshot({ jobs: [crop, quarry] }) });
  const active = render("garden", economy);
  assert.equal(disabled(button(active, "Собрать")), true);
  assert.match(active, /Мохлик работает в каменоломне/);
  quarry.finishesAt = new Date(now).toISOString();
  assert.equal(disabled(button(render("garden", economy), "Собрать")), false);
});

test("busy, uncertain and retry cooldown block claims while closing remains available", () => {
  const state = snapshot({ jobs: [job({ kind: "construction", targetId: "home", recipeId: null, targetLevel: 2, rewards: {}, finishesAt: new Date(now).toISOString() })] });
  for (const flags of [{ busy: true }, { uncertain: true }, { retryAt: now + 10_000 }]) {
    const html = renderUpgrade("home", controller({ snapshot: state, ...flags }));
    assert.equal(disabled(button(html, "Завершить")), true);
    assert.match(html, /<button(?![^>]*disabled)[^>]*aria-label="Закрыть окно улучшения"/);
  }
});

test("missing-navigation requirements remain honest text and landmarks offer actual restoration with home gates", () => {
  const html = renderUpgrade("quarry");
  assert.match(html, /нужен ур. 2/);
  assert.equal(disabled(button(html, "Начать обустройство")), true);
  for (const place of ["bridge", "lighthouse"]) {
    const landmark = render(place);
    assert.match(landmark, /Требует восстановления/);
    assert.match(landmark, /Восстановить/);
    assert.doesNotMatch(landmark, /Будущая ветка|Выберите рецепт|data-production-slots=/);
    const upgrade = renderUpgrade(place);
    assert.match(upgrade, /Время восстановления/);
    assert.match(upgrade, /Новый маршрут/);
    assert.doesNotMatch(upgrade, /Следующий уровень постройки/);
    assert.match(upgrade, /нужен ур. 4/);
    assert.equal(disabled(button(upgrade, "Начать восстановление")), true);
  }
});

test("restored landmarks show expedition routes and their remaining prerequisites without a production queue", () => {
  for (const place of ["bridge", "lighthouse"]) {
    const html = render(place, controller({ snapshot: snapshot({ buildings: { home: 4, warehouse: 1, bridge: 1, lighthouse: 1, workshop: 3 } }) }), { onExplore() {} });
    assert.match(html, /Восстановлено/);
    assert.match(html, /Маршруты экспедиций/);
    assert.match(html, /Выбрать экспедицию/);
    assert.match(html, /Восстановление завершено/);
    assert.doesNotMatch(html, /Выберите рецепт|Сначала обустройте|data-production-slots=|Место 2/);
    assert.doesNotMatch(html, /data-guide-station-upgrade=/);
  }
});

test("house five names the project as a guaranteed relic source while restoration keeps the generic paid-job controls", () => {
  const state = snapshot({ buildings: { home: 4, warehouse: 1, bridge: 1, lighthouse: 1, workshop: 3 } });
  const house = renderUpgrade("home", controller({ snapshot: state }));
  assert.match(house, /Гарантированный источник: завершите проект к дому 5/);
  assert.match(house, /Жемчуг не требуется/);
  const paid = job({ kind: "construction", targetId: "bridge", targetLevel: 1, rewards: {}, recipeId: null, finishesAt: new Date(now).toISOString() });
  const html = renderUpgrade("bridge", controller({ snapshot: snapshot({ buildings: { home: 4, warehouse: 1 }, jobs: [paid] }) }));
  assert.match(html, /Материалы оплачены/);
  assert.equal(disabled(button(html, "Завершить")), false);
  assert.doesNotMatch(html, /Начать восстановление/);
});

test("spent one-time project relics fall back to exploration and frozen reward terms override later catalog rewards", () => {
  const state = snapshot({ buildings: { home: 4, warehouse: 1, bridge: 1, lighthouse: 1, workshop: 3 },
    stageOrders: { version: 1, stages: { 4: { step: 12, completed: true, terms: null,
      completionRewards: { ancient_core: 1, moon_crystal: 1 } } } } });
  let html = renderUpgrade("home", controller({ snapshot: state }), { navigation: { canOpen() { return false; }, open() {}, explore() {} } });
  assert.doesNotMatch(html, /Гарантированный источник: завершите проект/);
  for (const id of ["ancient_core", "moon_crystal"]) {
    const name = state.catalog.items.find(item => item.id === id).name;
    assert.ok(html.includes(`Где искать: ${name}`), "an exhausted one-time reward does not hide its repeatable exploration alternative");
  }
  state.stageOrders.stages[4] = { step: 11, completed: false, terms: null, completionRewards: { ancient_core: 2 } };
  html = renderUpgrade("home", controller({ snapshot: state }), { navigation: { canOpen() { return false; }, open() {}, explore() {} } });
  const coreName = state.catalog.items.find(item => item.id === "ancient_core").name;
  const crystalName = state.catalog.items.find(item => item.id === "moon_crystal").name;
  assert.ok(html.includes(`${coreName} × 2`), "the accepted project reward remains frozen");
  assert.ok(html.includes(`Где искать: ${crystalName}`), "the current catalog cannot invent a crystal in an accepted older reward");
  assert.ok(!html.includes(`Где искать: ${coreName}`));
});

test("loading and initial failures show no made-up stocks or spend action", () => {
  let html = renderUpgrade("home", controller({ snapshot: null }));
  assert.match(html, /Открываем ваше хозяйство/);
  assert.doesNotMatch(html, /монет"|Начать обустройство|Продать|Развить дом/);
  html = render("garden", controller({ snapshot: null, error: "Нет связи" }));
  assert.match(html, /Нет связи/);
  assert.equal(disabled(button(html, "Попробовать ещё раз")), false);
});

// The actual portal and keyboard/focus transition are covered in the browser pass.
test("house skips the anchored menu and production upgrades use a separate dialog action", () => {
  assert.doesNotMatch(render("house"), /aria-modal="false"|Оборудование: Дом/);
  const html = render("garden");
  const upgrade = button(html, "Улучшить");
  assert.match(upgrade.attributes, /aria-haspopup="dialog"/);
  assert.match(html.match(/<header[^>]*>([\s\S]*?)<\/header>/)?.[1], /data-guide-station-upgrade="garden"/);
  assert.doesNotMatch(html, /<footer[\s\S]*data-guide-station-upgrade=/);
  assert.doesNotMatch(upgrade.attributes, /aria-expanded/);
  assert.doesNotMatch(html, /Улучшить до ур\.|aria-label="Обустройство:/);
});

test("navigation to house storage preserves the requested station instead of opening home upgrades", () => {
  const html = render("house", controller(), { initialStationId: "warehouse" });
  assert.match(html, /aria-modal="false"/);
  assert.match(html, /Пока пусто/);
  assert.equal(disabled(button(html, "Улучшить")), false);
  assert.doesNotMatch(render("house", controller(), { initialStationId: "kiln" }), /aria-modal="false"/);
});

test("embedded warehouse sale quotes the same markdown and preserves legacy catalog prices", () => {
  const state = snapshot({ inventory: { fish_common: 4 } }); state.catalog.localBuyer = { payoutBps: 6000 };
  const sale = () => renderToStaticMarkup(createElement(WorldObjectSale, { economy: controller({ snapshot: state }), itemId: "fish_common", onCollapse() {} }));
  let html = sale();
  assert.match(html, /быстрая продажа с уценкой 40%/); assert.match(html, /Плёска купит дороже: 40 монет/);
  assert.match(html, /Продать · 20/); assert.doesNotMatch(html, /торговец даёт 40/);
  delete state.catalog.localBuyer;
  html = sale(); assert.match(html, /торговец даёт 40 монет за штуку/); assert.match(html, /Продать · 40/);
});

test("embedded warehouse sale rejects zero-value stock and uses the aggregate wallet cap", () => {
  const state = snapshot({ inventory: { crumb_bait: 1 } }); state.catalog.localBuyer = { payoutBps: 6000 };
  state.catalog.items.find(item => item.id === "crumb_bait").baseSellPrice = 10;
  const sale = () => renderToStaticMarkup(createElement(WorldObjectSale, { economy: controller({ snapshot: state }), itemId: "crumb_bait", onCollapse() {} }));
  let html = sale(); assert.match(html, /нужно хотя бы 2 шт/); assert.match(html, /disabled=""[^>]*>Продать · -/);
  state.inventory.crumb_bait = 10; state.wallet.coins = 9_999_999_990;
  html = sale(); assert.match(html, /min="2" max="3"/); assert.match(html, /Продать · 10/);
});


test("missing fish class ingredients link to an available fishing route", () => {
  const state = snapshot({ buildings: { home: 3, warehouse: 3, dryer: 3 }, inventory: {} });
  for (const group of state.catalog.fishing.classes) {
    const source = helpers.worldMaterialSource(state, group.itemId);
    assert.equal(source.kind, "exploration");
    assert.ok(state.catalog.fishing.routeIds.includes(source.targetId));
  }
});
