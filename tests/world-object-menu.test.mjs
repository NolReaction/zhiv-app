import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { createElement } from "react";
import { Dialog } from "radix-ui";
import { renderToStaticMarkup } from "react-dom/server";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false } });
const helpers = await vite.ssrLoadModule("/features/economy/world-stations.ts");
const { WorldObjectMenu } = await vite.ssrLoadModule("/features/economy/world-object-menu.tsx");
const { WorldUpgradeContent } = await vite.ssrLoadModule("/features/economy/world-upgrade-dialog.tsx");
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
  const target = { level: 1, requiredHomeLevel: 4, requiredBuildings: { kiln: 4 }, seconds: 90, cost: { coins: 174, items: { glass: 7 } } };
  assert.deepEqual(helpers.worldRequirements(target), { kiln: 4, home: 4 });
  assert.match(helpers.worldConstructionReason(state, "quarry", target), /уровень 4/);
  state.buildings.home = 4; state.buildings.kiln = 4; state.wallet.coins = 174; state.inventory.glass = 6;
  assert.deepEqual(helpers.worldCostShortfalls(state, target.cost), [{ id: "glass", required: 7, available: 6 }]);
  assert.match(helpers.worldConstructionReason(state, "quarry", target), /материалов/);
  state.inventory.glass = 7;
  assert.equal(helpers.worldConstructionReason(state, "quarry", target), null);
  state.jobs = [job({ kind: "construction", targetId: "home", recipeId: null, targetLevel: 5, rewards: {}, finishesAt: new Date(now).toISOString() })];
  assert.match(helpers.worldConstructionReason(state, "quarry", target), /текущую стройку/);
});

test("batches use full capacity; unclaimed work still occupies the station", () => {
  const state = snapshot({ storage: { capacity: 200, used: 195, reserved: 0, available: 5, overflow: 0 } });
  const recipe = { ...state.catalog.recipes.find(entry => entry.id === "grow_berries"), rewards: { berries: 70, fiber: 20 } };
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
  assert.match(html, /aria-label="Где получить: Камень, В путь"/);
  state.buildings.home = 2; state.buildings.quarry = 1;
  assert.equal(helpers.worldMaterialSource(state, "stone").stationId, "quarry");
});

test("claim uses the server clock and construction can finish with a full pantry", () => {
  const state = snapshot({ storage: { capacity: 200, used: 197, reserved: 0, available: 3, overflow: 0 } });
  assert.equal(helpers.worldJobProgress(state, job(), now).ready, false);
  const ready = job({ finishesAt: new Date(now).toISOString() });
  assert.deepEqual(helpers.worldJobProgress(state, ready, now), { ready: true, progress: 1, seconds: 0, storageShortfall: 3 });
  assert.equal(helpers.worldJobProgress(state, { ...ready, kind: "construction", rewards: {} }, now).storageShortfall, 0);
  let html = render("garden", controller({ snapshot: { ...state, jobs: [ready] } }));
  assert.equal(disabled(button(html, "Забрать")), true);
  assert.match(html, /освободить 3 мест/);
  html = render("garden", controller({ snapshot: snapshot({ jobs: [ready] }) }));
  assert.equal(disabled(button(html, "Забрать")), false);
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
