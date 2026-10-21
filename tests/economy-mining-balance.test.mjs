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
const { productionStationSupported, productionSlotOffer } = await vite.ssrLoadModule("/features/economy/domain/production-slots.ts");
after(() => vite.close());
const book = JSON.parse(readFileSync(new URL("../apps/api/src/main/resources/world/collections-catalog.json", import.meta.url), "utf8"));
const achievements = JSON.parse(readFileSync(new URL("../apps/api/src/main/resources/world/achievements-catalog.json", import.meta.url), "utf8"));
const mines = catalog.explorations.filter(route => route.activity === "mining");
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

test("each mine resource has a bounded choice of short, hourly and overnight extraction", () => {
  for (const [item, shortSeconds, expectedCount] of [["stone", 180, 3], ["ore", 540, 4], ["clay", 180, 3], ["sand", 270, 3]]) {
    const choices = focused(item);
    assert.equal(choices.length, expectedCount, `${item}: keep the catalog concise`);
    assert.equal(choices[0].seconds, shortSeconds); assert.equal(choices[0].rewards[item], 1);
    assert.ok(choices.some(entry => entry.seconds === 3600), `${item}: an hourly return must be available`);
    assert.ok(choices.some(entry => entry.seconds === 28800), `${item}: an overnight return must be available`);
    for (let index = 1; index < choices.length; index++) {
      const previous = choices[index - 1], current = choices[index];
      assert.ok(current.seconds > previous.seconds, `${item}: no duplicate timer choice`);
      assert.ok(current.rewards[item] > previous.rewards[item], `${item}: staying away longer must bring a larger stack`);
      assert.ok(net(current) > net(previous), `${item}: a longer single visit must not pay less in total`);
      assert.ok(net(current) / current.seconds <= net(previous) / previous.seconds,
        `${item}: frequent returns retain their production advantage`);
    }
  }
  assert.equal(mines.length, 18, "thirteen focused choices and five existing mixed routes");
});

test("all mining batches fit the original warehouse even when a relic is due", () => {
  const capacity = catalog.buildings.find(building => building.id === "warehouse").levels[0].warehouseCapacity;
  for (const entry of mines) {
    assert.ok(total(entry.rewards) + 1 <= capacity, entry.id);
    assert.equal(entry.requiredBuildings.warehouse, undefined, entry.id);
    assert.ok(net(entry) > 0, entry.id);
    assert.ok(Object.keys(entry.rewards).every(id => ["stone", "ore", "clay", "sand"].includes(id)), entry.id);
  }
});

test("early free stone and clay survive while upgrades open longer targeted choices", () => {
  for (const [id, quarry] of [["quarry_stone", 1], ["quarry_clay", 2]]) {
    const entry = route(id);
    assert.equal(entry.requiredHomeLevel, 2); assert.deepEqual(entry.requiredBuildings, { quarry });
    assert.deepEqual(entry.cost, { coins: 0, items: {} });
  }
  for (const id of ["quarry_stone_hour", "quarry_clay_hour"]) {
    assert.equal(route(id).requiredHomeLevel, 2); assert.deepEqual(route(id).requiredBuildings, { quarry: 2 });
  }
  for (const id of ["quarry_ore_hour", "quarry_clay_overnight", "quarry_sand_hour"])
    assert.deepEqual(route(id).requiredBuildings, { quarry: 3 });
  for (const id of ["quarry_ore_overnight", "quarry_sand_overnight"])
    assert.deepEqual(route(id).requiredBuildings, { quarry: 4 });
  assert.equal(route("abandoned_quarry").requiredBuildings.quarry, 5);
  assert.deepEqual(route("abandoned_quarry").cost, { coins: 0, items: {} }, "the longest ore stack requires time, not a consumed tool");
});

test("successive mixed shifts give substantially more ore and a visible total-value improvement", () => {
  const shifts = ["quarry_shift", "quarry_deep_face", "quarry_supply"].map(route);
  assert.deepEqual(shifts.map(entry => net(entry)), [1920, 2140, 2360]);
  assert.deepEqual(shifts.map(entry => entry.rewards.ore), [12, 20, 28]);
  for (let index = 0; index < shifts.length; index++) {
    const current = shifts[index];
    assert.equal(current.seconds, 28800); assert.equal(current.requiredBuildings.quarry, index + 3);
    assert.equal(total(current.rewards), 48); assert.deepEqual(current.cost, { coins: 0, items: {} });
    if (!index) continue;
    assert.ok(net(current) >= net(shifts[index - 1]) * 1.09);
    assert.ok(current.rewards.ore >= shifts[index - 1].rewards.ore * 1.3);
  }
});

test("ore prices, processing margins and mandatory project timing remain intact", () => {
  const ingot = catalog.recipes.find(recipe => recipe.id === "smelt_iron");
  const late = catalog.recipes.find(recipe => recipe.id === "smelt_tempered_iron");
  const part = catalog.recipes.find(recipe => recipe.id === "make_metal_parts");
  assert.equal(catalog.items.find(item => item.id === "ore").baseSellPrice, 60);
  assert.equal(catalog.localBuyer.unitPrices.ore, 60);
  assert.equal(catalog.localBuyer.unitPrices.iron_ingot, 340);
  assert.deepEqual(ingot.cost.items, { ore: 3, charcoal: 1 }); assert.equal(ingot.seconds, 1800);
  assert.deepEqual(late.cost.items, ingot.cost.items); assert.equal(late.seconds, 1200);
  assert.equal(cash(ingot.rewards) - cash(ingot.cost.items), 110);
  assert.equal(cash(part.rewards) - cash(part.cost.items), 90);
  const report = auditEconomyProgression(readEconomyCatalog());
  assert.equal(report.projects.find(stage => stage.homeLevel === 3).minimumWaitSeconds, 7 * 23 * 3600);
  assert.equal(report.projects.find(stage => stage.homeLevel === 4).minimumWaitSeconds, 11 * 23 * 3600);
  assert.equal(report.fourthStage.constructionSeconds, 96 * 3600);
});

test("every new mining choice contributes to the same collection and achievement biome", () => {
  const biomes = Object.values(achievements.biomes).flat();
  for (const entry of mines) {
    assert.ok(book.quarry.routes.includes(entry.id), entry.id);
    assert.ok(achievements.biomes.caves.includes(entry.id), entry.id);
    assert.equal(biomes.filter(id => id === entry.id).length, 1, entry.id);
    if (entry.id.endsWith("_hour") || ["quarry_ore_overnight", "quarry_clay_overnight", "quarry_sand_overnight"].includes(entry.id))
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
