import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { createElement } from "react";
import { Dialog } from "radix-ui";
import { renderToStaticMarkup } from "react-dom/server";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false } });
const helpers = await vite.ssrLoadModule("/features/economy/world-stations.ts");
const { WorldObjectMenu, WorldObjectSale } = await vite.ssrLoadModule("/features/economy/world-object-menu.tsx");
const { WorldExpeditionSector } = await vite.ssrLoadModule("/features/economy/world-expeditions-menu.tsx");
const { WorldUpgradeContent } = await vite.ssrLoadModule("/features/economy/world-upgrade-dialog.tsx");
const { ProductionActivity } = await vite.ssrLoadModule("/features/economy/production-activity.tsx");
const { economyCatalog } = await vite.ssrLoadModule("/features/economy/model.ts");
const { economyStorage } = await vite.ssrLoadModule("/features/economy/rules.ts");
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
const disabled = entry => /\bdisabled=/.test(entry.attributes);

test("production slots show house and pearl gates, bought capacity, and keep all orders claimable", () => {
  let state = snapshot({ buildings: { home: 1, garden: 1 }, wallet: { coins: 0, pearls: 10000 } });
  let html = render("garden", controller({ snapshot: state }));
  assert.match(html, /data-production-slots="garden"/);
  assert.match(html, /Нужен дом 2 уровня/);
  assert.equal(disabled(button(html, "Место 2")), true);
  state.buildings.home = 2;
  html = render("garden", controller({ snapshot: state }));
  assert.equal(disabled(button(html, "Место 2")), false);
  assert.match(html, /Открыть место 2 за 750 жемчужин/);
  state.wallet.pearls = 1499;
  html = render("garden", controller({ snapshot: state }));
  assert.equal(disabled(button(html, "Место 2")), true);
  assert.match(html, /Не хватает жемчужин: 0,5/);
  state.wallet.pearls = 10000; state.productionSlots = { garden: 2 };
  html = render("garden", controller({ snapshot: state }));
  assert.match(html, /Нужен дом 4 уровня/);
  assert.match(html, /Открыть место 3 за 2[^\d]?500 жемчужин/);
  assert.equal(disabled(button(html, "Место 3")), true);
  state.buildings.home = 4;
  assert.equal(disabled(button(render("garden", controller({ snapshot: state })), "Место 3")), false);
  assert.equal(disabled(button(render("garden", controller({ snapshot: state, uncertain: true })), "Место 3")), true);
  assert.equal(disabled(button(render("garden", controller({ snapshot: state, busy: true })), "Место 3")), true);
  state.productionSlots.garden = 3;
  state.jobs = [job({ id: "crop-a", finishesAt: new Date(now).toISOString() }), job({ id: "crop-b" }), job({ id: "crop-c" })];
  html = render("garden", controller({ snapshot: state }));
  assert.match(html, /3 \/ 3/);
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
    assert.match(disclosure[2].slice(summary.length), /Открыть место 2 за 750 жемчужин/);
    const rest = html.replace(disclosure[0], "");
    assert.match(rest, /data-recipe=/);
    assert.doesNotMatch(rest, /data-running-orders=|Все уровни оборудования открыты/);
  }
});

test("running orders collapse into one timer and become directly claimable when the server clock reaches completion", () => {
  const recipe = economyCatalog.recipes.find(entry => entry.buildingId === "workshop");
  const jobs = [3, 1, 2].map(index => job({ id: `order-${index}`, targetId: "workshop", recipeId: recipe.id, rewards: recipe.rewards,
    finishesAt: new Date(now + index * 60000).toISOString() }));
  const state = snapshot({ buildings: { home: 5, workshop: 5, warehouse: 5 }, productionSlots: { workshop: 3 }, jobs });
  const economy = controller({ snapshot: state });
  let html = render("workshop", economy);
  let disclosure = html.match(/<details\b([^>]*data-running-orders="workshop"[^>]*)>([\s\S]*?)<\/details>/);
  assert.ok(disclosure);
  assert.doesNotMatch(disclosure[1], /\bopen(?:=|\s|$)/);
  assert.match(disclosure[2], /В работе · 3/);
  assert.match(disclosure[2], /Ещё 1 мин/);
  for (const entry of jobs) assert.match(disclosure[2], new RegExp(`data-job-id="${entry.id}"`));
  assert.doesNotMatch(html.replace(disclosure[0], ""), /data-job-id=/);
  assert.match(html.replace(disclosure[0], ""), /data-recipe=/);

  economy.now += 60000;
  html = render("workshop", economy);
  disclosure = html.match(/<details\b[^>]*data-running-orders="workshop"[^>]*>[\s\S]*?<\/details>/);
  assert.match(disclosure[0], /В работе · 2/);
  assert.doesNotMatch(disclosure[0], /data-job-id="order-1"/);
  const exposed = html.replace(disclosure[0], "");
  assert.match(exposed, /data-job-id="order-1" data-ready="true"/);
  assert.equal(disabled(button(exposed, "Забрать")), false);
  assert.equal(state.jobs.length, 3, "view compaction must not claim or remove an order");
});

test("map objects group equipment by place, with campfire food and pantry at the house", () => {
  assert.deepEqual(helpers.worldStations.house.stationIds, ["home", "warehouse"]);
  assert.deepEqual(helpers.worldStations.workshop.stationIds, ["workshop", "kiln"]);
  assert.deepEqual(helpers.worldStations.campfire.stationIds, ["dryer"]);
  for (const id of ["home", "warehouse", "garden", "dryer", "workshop", "kiln", "quarry", "woodlot"]) assert.ok(helpers.worldPlaceForStation(id));
  assert.equal(helpers.worldPlaceForStation("unknown"), null);
});

test("portrait popover respects HUD bounds and leaves its selected object visible", () => {
  const selection = { x: 195, y: 405, viewportWidth: 390, viewportHeight: 844 };
  const bounds = { top: 120, right: 8, bottom: 110, left: 8 };
  const dimensions = helpers.worldMenuDimensions(selection, bounds);
  assert.equal(dimensions.width, 320);
  assert.ok(dimensions.maxHeight < (844 - 230) / 2);
  const placed = helpers.worldMenuPosition(selection, { width: dimensions.width, height: 225 }, bounds);
  assert.ok(placed.x >= 8 && placed.x + placed.width <= 382);
  assert.ok(placed.y >= 120 && placed.y + placed.height <= 734);
  assert.ok(selection.y < placed.y || selection.y > placed.y + placed.height);
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
});

test("berry collection uses the server clock and pantry space while construction can finish with a full pantry", () => {
  const state = snapshot({ storage: { capacity: 200, used: 197, reserved: 0, available: 3, overflow: 0 } });
  const growing = job({ collection: { kind: "berry_harvest", seconds: 8, startedAt: null, finishesAt: null } });
  assert.equal(helpers.worldJobProgress(state, growing, now).ready, false);
  assert.equal(disabled(button(render("garden", controller({ snapshot: snapshot({ jobs: [growing] }) })), "Растут")), true);
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
  assert.match(html, /aria-label="Вырастить ягоды/);
  assert.doesNotMatch(html, /aria-label="[^\"]*(Выплавить|Доски|Рыбу)/);
  assert.equal(disabled(button(render("workshop"), "Верстак")), false);
  assert.doesNotMatch(renderUpgrade("home"), /<button[^>]*>[^<]*Кладовая/);
  assert.doesNotMatch(html, /Начать ·/);
});

test("the mine has one actor route picker without production tabs and keeps upgrade gates", () => {
  const prepareCave = state => renderToStaticMarkup(createElement(WorldExpeditionSector, {
    sectorId: "caves", selectedRoute: "cave", onSelectRoute() {}, economy: controller({ snapshot: state }), state,
    exploring: false, embeddedCaves: true, onOpenPantry() {},
  }));
  const initialState = snapshot();
  const initial = render("quarry", controller({ snapshot: initialState }));
  assert.match(initial, /data-sector="caves"/);
  assert.doesNotMatch(initial, /data-quarry-tab|data-recipe=|Секторы вылазок/);
  const lockedCave = button(initial, "Вход в пещеру");
  assert.match(lockedCave.attributes, /aria-label="Подготовиться: Вход в пещеру"/);
  assert.match(lockedCave.attributes, /data-route="cave"/);
  assert.match(lockedCave.attributes, /data-locked="true"/);
  assert.equal(disabled(lockedCave), false, "locked routes remain inspectable before meeting their conditions");
  assert.doesNotMatch(initial, /aria-label="Отправиться:|data-route-preparation=/);
  const lockedPreparation = prepareCave(initialState);
  assert.match(lockedPreparation, /data-route="cave"[^>]*data-route-preparation="true"/);
  assert.equal(disabled(button(lockedPreparation, "Отправиться")), true);
  assert.equal(disabled(button(initial, "Обустроить")), false);
  const unbuiltState = snapshot({ buildings: { home: 2, warehouse: 1, quarry: 0 } });
  const unbuilt = render("quarry", controller({ snapshot: unbuiltState }));
  const openCave = button(unbuilt, "Вход в пещеру");
  assert.equal(disabled(openCave), false);
  assert.doesNotMatch(openCave.attributes, /data-locked="true"/);
  assert.equal(disabled(button(prepareCave(unbuiltState), "Отправиться")), false, "entry cave keeps the free home-two resource path");
  assert.match(unbuilt, /data-route="quarry_clay"[^>]*data-locked="true"/);
  assert.match(unbuilt, /data-route="abandoned_quarry"[^>]*data-locked="true"/);
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

test("missing-navigation requirements remain honest text; future landmarks offer no spend controls", () => {
  const html = renderUpgrade("quarry");
  assert.match(html, /нужен ур. 2/);
  assert.equal(disabled(button(html, "Начать обустройство")), true);
  for (const place of ["bridge", "lighthouse"]) {
    const landmark = render(place);
    assert.match(landmark, /Будущая ветка/);
    assert.doesNotMatch(landmark, /Начать обустройство|Продать|Улучшить|монет"/);
  }
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
  assert.doesNotMatch(upgrade.attributes, /aria-expanded/);
  assert.doesNotMatch(html, /Улучшить до ур\.|aria-label="Обустройство:/);
});

test("navigation to house storage preserves the requested station instead of opening home upgrades", () => {
  const html = render("house", controller(), { initialStationId: "warehouse" });
  assert.match(html, /aria-modal="false"/);
  assert.match(html, /Пока пусто/);
  assert.equal(disabled(button(html, "Расширить кладовую")), false);
  assert.doesNotMatch(render("house", controller(), { initialStationId: "kiln" }), /aria-modal="false"/);
});

test("embedded warehouse sale quotes the same markdown and preserves legacy catalog prices", () => {
  const state = snapshot({ inventory: { fish: 4 } }); state.catalog.localBuyer = { payoutBps: 6000 };
  const sale = () => renderToStaticMarkup(createElement(WorldObjectSale, { economy: controller({ snapshot: state }), itemId: "fish", onCollapse() {} }));
  let html = sale();
  assert.match(html, /быстрая продажа с уценкой 40%/); assert.match(html, /Плёска купит дороже: 80 монет/);
  assert.match(html, /Продать · 40/); assert.doesNotMatch(html, /торговец даёт 80/);
  delete state.catalog.localBuyer;
  html = sale(); assert.match(html, /торговец даёт 80 монет за штуку/); assert.match(html, /Продать · 80/);
});

test("embedded warehouse sale rejects zero-value stock and uses the aggregate wallet cap", () => {
  const state = snapshot({ inventory: { crumb_bait: 1 } }); state.catalog.localBuyer = { payoutBps: 6000 };
  const sale = () => renderToStaticMarkup(createElement(WorldObjectSale, { economy: controller({ snapshot: state }), itemId: "crumb_bait", onCollapse() {} }));
  let html = sale(); assert.match(html, /нужно хотя бы 2 шт/); assert.match(html, /disabled=""[^>]*>Продать · —/);
  state.inventory.crumb_bait = 10; state.wallet.coins = 9_999_999_990;
  html = sale(); assert.match(html, /min="2" max="3"/); assert.match(html, /Продать · 10/);
});
