import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { auditEconomyProgression, readEconomyCatalog } from "../scripts/audit-economy-progression.mjs";
import { createLiquidation } from "../scripts/lib/economy-math.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, cacheDir: "/tmp/zhiv-mining-balance-vite",
  resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false } });
const { economyCatalog: catalog, economyJobSchema } = await vite.ssrLoadModule("/features/economy/domain/model.ts");
const { applyEconomyCommand, newEconomyState } = await vite.ssrLoadModule("/features/economy/domain/rules.ts");
const { economyAchievementProgress } = await vite.ssrLoadModule("/features/game/achievement-progress.ts");
const { productionStationSupported, productionSlotOffer } = await vite.ssrLoadModule("/features/economy/domain/production-slots.ts");
after(() => vite.close());
const book = JSON.parse(readFileSync(new URL("../apps/api/src/main/resources/world/collections-catalog.json", import.meta.url), "utf8"));
const achievements = JSON.parse(readFileSync(new URL("../apps/api/src/main/resources/world/achievements-catalog.json", import.meta.url), "utf8"));
const mines = catalog.explorations.filter(route => route.activity === "mining" && !route.retired);
const cash = createLiquidation(catalog);
const net = route => cash(route.rewards) - cash(route.cost.items) - route.cost.coins;
const now = Date.parse("2026-10-15T09:00:00Z");
const route = id => mines.find(entry => entry.id === id);
const total = items => Object.values(items).reduce((sum, count) => sum + count, 0);
const focused = item => mines.filter(entry => Object.keys(entry.rewards).length === 1 && entry.rewards[item] > 0)
  .sort((a, b) => a.seconds - b.seconds);
const player = () => {
  const state = newEconomyState({ resources: { sparks: 0, wood: 0, stone: 0 }, houseLevel: 1, workshopLevel: 0 });
  Object.assign(state.buildings, Object.fromEntries(catalog.buildings.map(building => [building.id, building.id === "warehouse" ? 1 : 5])));
  state.inventory = {}; state.jobs = []; state.wallet = { coins: 10000, pearls: 0 };
  state.food = { heroMeal: "legendary_fish", builderMeal: null };
  state.tutorialOrder = { version: 2, step: 4, completed: true, ingredientsClaimed: true, terms: null };
  return state;
};
const command = (action, targetId) => ({ requestId: crypto.randomUUID(), action, targetId, quantity: 1, totalPrice: 0 });
const apply = (state, action, targetId, time = now) => applyEconomyCommand(state, command(action, targetId), time,
  () => crypto.randomUUID(), {}, maximum => maximum - 1);

test("each mine resource has one fixed unit timer with no unattended bulk choices", () => {
  for (const [item, seconds] of [["stone", 180], ["ore", 600], ["clay", 180], ["sand", 300], ["quartz", 900], ["limestone", 1200]]) {
    const choices = focused(item);
    assert.equal(choices.length, 1, `${item}: exactly one active extraction method`);
    assert.equal(choices[0].seconds, seconds); assert.deepEqual(choices[0].rewards, { [item]: 1 });
    assert.equal(net(choices[0]), seconds / 60 * 10, `${item}: each productive minute has the common value`);
  }
  assert.equal(mines.length, 6);
});

test("one mineral and an optional relic fit the original warehouse", () => {
  const capacity = catalog.buildings.find(building => building.id === "warehouse").levels[0].warehouseCapacity;
  for (const entry of mines) {
    assert.equal(total(entry.rewards), 1, entry.id);
    assert.ok(total(entry.rewards) + 1 <= capacity, entry.id);
    assert.equal(entry.requiredBuildings.warehouse, undefined, entry.id);
    assert.ok(net(entry) > 0, entry.id);
    assert.ok(Object.keys(entry.rewards).every(id => ["stone", "ore", "clay", "sand", "quartz", "limestone"].includes(id)), entry.id);
  }
});

test("every quarry level opens an additional usable resource", () => {
  for (const [id, quarry, home] of [["quarry_stone", 1, 2], ["quarry_clay", 2, 2], ["quarry_ore", 2, 3],
    ["quarry_sand", 3, 3], ["quarry_quartz", 4, 4], ["quarry_limestone", 5, 5]]) {
    const entry = route(id);
    assert.equal(entry.requiredHomeLevel, home); assert.deepEqual(entry.requiredBuildings, { quarry });
    assert.deepEqual(entry.cost, { coins: 0, items: {} });
    const item = Object.keys(entry.rewards)[0];
    assert(catalog.recipes.some(recipe => !recipe.retired && recipe.cost.items[item]), `${item}: has a downstream recipe`);
  }
});

test("saved bulk mining definitions remain readable but all new starts are rejected atomically", () => {
  const retired = catalog.explorations.filter(entry => entry.activity === "mining" && entry.retired);
  assert(retired.length > 0);
  assert(retired.some(entry => entry.id === "quarry_shift"));
  for (const entry of retired) {
    const state = player(); state.inventory = { ...entry.cost.items }; const before = structuredClone(state);
    assert.throws(() => apply(state, "start_exploration", entry.id), { code: "ECONOMY_SOURCE_RETIRED" });
    assert.deepEqual(state, before, entry.id);
  }
});

test("reference processing pays for inputs plus time while new projects remove daily waits", () => {
  assert.equal(catalog.localBuyer.unitPrices.ore, 100);
  for (const id of ["smelt_iron", "make_metal_parts"]) {
    const recipe = catalog.recipes.find(entry => entry.id === id);
    assert.equal(cash(recipe.rewards) - cash(recipe.cost.items) - recipe.cost.coins, recipe.seconds / 60 * 10, id);
  }
  const report = auditEconomyProgression(readEconomyCatalog());
  assert.equal(report.projects.find(stage => stage.homeLevel === 3).minimumWaitSeconds, 0);
  assert.equal(report.projects.find(stage => stage.homeLevel === 4).minimumWaitSeconds, 0);
  assert.equal(report.fourthStage.constructionSeconds, 32 * 3600);
});

test("every new mining choice contributes to the quarry collection and a distinct completed route", () => {
  for (const entry of mines) {
    assert.ok(book.quarry.routes.includes(entry.id), entry.id);
    const state = player(); state.progression.routes = { [entry.id]: 10 };
    assert.equal(economyAchievementProgress(state).familiar_trails, 1, entry.id);
    if (["quarry_quartz", "quarry_limestone"].includes(entry.id))
      assert.ok(!achievements.legacyRecipeIds.includes(entry.id), "new exploration IDs cannot become legacy production achievements");
  }
});

test("all mining choices use one independent worker, retain food and claim their saved batch into fifty places", () => {
  for (const entry of mines) {
    const state = player(); state.inventory = { ...entry.cost.items };
    state.minerRareDropState = { version: 1, remainingSeconds: 1, itemId: "ancient_core" };
    apply(state, "start_exploration", entry.id);
    const job = state.jobs[0], deadline = Date.parse(job.finishesAt);
    assert.equal(job.actorId, "miner"); assert.equal(deadline - now, entry.seconds * 1000);
    assert.deepEqual(job.cost, entry.cost); assert.deepEqual(job.rewards, { ...entry.rewards, ancient_core: 1 });
    assert.equal(job.meal, undefined); assert.equal(state.food.heroMeal, "legendary_fish");
    assert.equal(productionStationSupported("quarry"), false); assert.equal(productionSlotOffer(state, "quarry"), null);
    assert.throws(() => apply(state, "start_exploration", "quarry_stone", deadline), { code: "ECONOMY_MINER_BUSY" });
    assert.throws(() => apply(state, "claim_job", job.id, deadline - 1), { code: "ECONOMY_JOB_NOT_READY" });
    apply(state, "claim_job", job.id, deadline);
    assert.deepEqual(state.inventory, job.rewards, entry.id); assert.equal(state.jobs.length, 0);
    assert.equal(state.progression.routes[entry.id], 1);
    assert.equal(state.progression.collections.quarrySeconds, Math.min(entry.seconds, book.quarry.secondsPerFind));
    assert.equal(state.completedExplorations, 0); assert.equal(state.food.heroMeal, "legendary_fish");
  }
});

test("the revised distant ore route never rewrites a paid historical mixed job's claim or refund", () => {
  const old = economyJobSchema.parse({ id: crypto.randomUUID(), kind: "exploration", actorId: "miner", targetId: "abandoned_quarry",
    recipeId: null, targetLevel: null, startedAt: new Date(now).toISOString(), finishesAt: new Date(now + 57600000).toISOString(),
    rewards: { stone: 17, ore: 11, sand: 8, clay: 7 }, cost: { coins: 0, items: { tools: 1, rope: 1, dried_berries: 1, smoked_fish: 1 } }, catalogVersion: 10 });
  for (const action of ["claim_job", "cancel_exploration"]) {
    const state = player(); state.buildings.quarry = 4; state.jobs = [structuredClone(old)];
    apply(state, action, old.id, Date.parse(old.finishesAt));
    assert.deepEqual(state.inventory, action === "claim_job" ? old.rewards : old.cost.items);
    assert.equal(state.jobs.length, 0);
    assert.equal(state.progression.routes[old.targetId] ?? 0, action === "claim_job" ? 1 : 0);
  }
});
