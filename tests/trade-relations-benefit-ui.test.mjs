import assert from "node:assert/strict";
import test, { after } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Dialog } from "radix-ui";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const cacheDir = await mkdtemp(join(tmpdir(), "zhiv-trade-benefit-ui-"));
const vite = await createServer({ appType: "custom", configFile: false, root, cacheDir, resolve: { alias: { "@": root } },
  server: { middlewareMode: true, hmr: false, ws: false } });
after(async () => { await vite.close(); await rm(cacheDir, { recursive: true, force: true }); });
const { economyCatalog } = await vite.ssrLoadModule("/features/economy/domain/model.ts");
const { newEconomyState, applyEconomyCommand, economyStorage } = await vite.ssrLoadModule("/features/economy/domain/rules.ts");
const { WorldUpgradeContent } = await vite.ssrLoadModule("/features/economy/ui/construction/world-upgrade-dialog.tsx");
const { WorldProductionCard } = await vite.ssrLoadModule("/features/economy/ui/production/world-production-card.tsx");
const { WorldExpeditionSector } = await vite.ssrLoadModule("/features/economy/ui/expeditions/world-expeditions-menu.tsx");
const { mealBoostSeconds } = await vite.ssrLoadModule("/features/economy/ui/food/world-meal-boost.tsx");
const { mealSpeedDescription } = await vite.ssrLoadModule("/features/economy/ui/food/meal-speed-description.ts");
const { worldDuration } = await vite.ssrLoadModule("/features/economy/ui/shared/world-stations.ts");
const { worldRecipeDuration } = await vite.ssrLoadModule("/features/economy/ui/stations/world-recipe-groups.ts");
const { miningDurationLabel } = await vite.ssrLoadModule("/features/economy/ui/expeditions/mining-resource-groups.ts");
const now = Date.parse("2026-10-23T12:00:00Z");

function fresh(reputation = {}) {
  const state = newEconomyState({ resources: { sparks: 0, wood: 0, stone: 0 }, houseLevel: 1, workshopLevel: 0 });
  state.buildings = { home: 3, warehouse: 2, garden: 1, workshop: 1, woodlot: 1, quarry: 1, dryer: 1 };
  state.wallet = { coins: 100_000, pearls: 0 };
  state.inventory = {};
  state.tradeRelations = { version: 1, reputation, dailyCycle: -1, dailyOrderXp: {}, dailyPurchaseXp: {}, weekly: null,
    weeklyAvailableAt: null, completedWeekly: 0 };
  return state;
}
function controller(state, at = now) {
  return { snapshot: { ...state, catalog: economyCatalog, storage: economyStorage(state), ownerPublicId: "benefit-owner", revision: 1,
    serverTime: new Date(at).toISOString() }, snapshotConfirmed: true, now: at, busy: false, uncertain: false, error: null,
    retryAt: 0, act() { return true; }, retry() {} };
}
function apply(state, action, targetId, at = now) {
  return applyEconomyCommand(state, { requestId: crypto.randomUUID(), ownerPublicId: "benefit-owner", expectedRevision: 1,
    action, targetId, quantity: 1, totalPrice: 0 }, at, () => crypto.randomUUID());
}
const elapsed = (job, startedAt = now) => (Date.parse(job.finishesAt) - startedAt) / 1000;
const render = (Component, props) => renderToStaticMarkup(createElement(Dialog.Root, { open: true }, createElement(Component, props)));

test("construction and meal previews agree with the actual new job including builder friendship", () => {
  const state = fresh({ builder: 4200, lopukh: 4200, kamneshmyg: 4200 });
  const target = economyCatalog.buildings.find(building => building.id === "warehouse").levels.find(level => level.level === 3);
  state.inventory = { ...target.cost.items };
  state.food = { heroMeal: null, builderMeal: "fish_soup" };
  const food = economyCatalog.food.meals.find(meal => meal.itemId === "fish_soup").builderSpeedBps;
  const expected = Math.ceil(target.seconds * 10_000 / (11_000 + food));
  const economy = controller(state), before = structuredClone(state);
  const html = render(WorldUpgradeContent, { stationId: "warehouse", economy, onClose() {} });
  assert.match(html, /data-construction-trade-bonus/);
  assert.match(html, /Шишколап: \+10% к скорости/);
  assert.ok(html.includes(worldDuration(expected)));
  assert.equal(mealBoostSeconds({ economy, consumer: "builder", seconds: target.seconds }, food), expected);
  assert.deepEqual(state, before, "opening either preview cannot spend a meal or change a saved timer");
  apply(state, "start_construction", "warehouse");
  assert.equal(elapsed(state.jobs[0]), expected);
  assert.equal(state.jobs[0].tradeSpeedBps, 1000);
  assert.equal(state.food.builderMeal, null);
});

test("a later meal uses the job's frozen friendship rather than the player's newly raised rank", () => {
  const state = fresh({ builder: 150 });
  const target = economyCatalog.buildings.find(building => building.id === "warehouse").levels.find(level => level.level === 3);
  state.inventory = { ...target.cost.items, fish_soup: 1 };
  apply(state, "start_construction", "warehouse");
  const job = state.jobs[0], savedDeadline = job.finishesAt;
  assert.equal(job.tradeSpeedBps, 200);
  state.tradeRelations.reputation.builder = 4200;
  const at = now + 1_234_567, economy = controller(state, at);
  const speed = economyCatalog.food.meals.find(meal => meal.itemId === "fish_soup").builderSpeedBps;
  const expectedMilliseconds = Math.ceil((Date.parse(savedDeadline) - at) * 10_200 / (10_200 + speed));
  const preview = mealBoostSeconds({ economy, consumer: "builder", jobId: job.id }, speed);
  assert.equal(preview, Math.ceil(expectedMilliseconds / 1000));
  assert.equal(job.finishesAt, savedDeadline, "rank changes and previews leave already accepted work untouched");
  apply(state, "feed_builder", "fish_soup", at);
  assert.equal(Date.parse(state.jobs[0].finishesAt) - at, expectedMilliseconds);
  assert.equal(state.jobs[0].tradeSpeedBps, 200);
});

test("woodlot production displays the same role-specific shortened duration as its saved job", () => {
  const state = fresh({ builder: 4200, lopukh: 4200, kamneshmyg: 4200 });
  const recipe = economyCatalog.recipes.find(recipe => recipe.id === "gather_wood");
  const expected = Math.ceil(recipe.seconds / 1.1), economy = controller(state);
  const html = render(WorldProductionCard, { economy, recipe });
  assert.match(html, /data-production-trade-bonus/);
  assert.match(html, /Лопоух: \+10% к скорости/);
  assert.ok(html.includes(worldRecipeDuration(expected)));
  apply(state, "start_production", recipe.id);
  assert.equal(elapsed(state.jobs[0]), expected);
  assert.equal(state.jobs[0].tradeSpeedBps, 1000);
});

test("mine list, preparation and saved extraction agree without consuming hero food", () => {
  const state = fresh({ builder: 4200, lopukh: 4200, kamneshmyg: 4200 });
  const route = economyCatalog.explorations.find(route => route.id === "cave");
  const expected = Math.ceil(route.seconds / 1.1), economy = controller(state);
  state.food = { heroMeal: "fish_soup", builderMeal: null };
  economy.snapshot.food = state.food;
  const shared = { sectorId: "caves", economy, state: economy.snapshot, exploring: false, onSelectRoute() {}, onOpenPantry() {} };
  const listing = render(WorldExpeditionSector, { ...shared, selectedRoute: null });
  const preparation = render(WorldExpeditionSector, { ...shared, selectedRoute: route.id });
  assert.ok(listing.includes(miningDurationLabel(expected)));
  assert.ok(preparation.includes(miningDurationLabel(expected)));
  assert.match(preparation, /data-mining-trade-bonus/);
  assert.match(preparation, /Камнешмыг: \+10%/);
  apply(state, "start_exploration", route.id);
  assert.equal(elapsed(state.jobs[0]), expected);
  assert.equal(state.jobs[0].tradeSpeedBps, 1000);
  assert.equal(state.food.heroMeal, "fish_soup");
});

test("meal saving text compares against existing friendship speed instead of promising the old reduction", () => {
  assert.equal(mealSpeedDescription(2500), "+25% скорости · время −20%");
  assert.equal(mealSpeedDescription(2500, 1000), "+25% скорости · время ≈ −18,5%");
});
