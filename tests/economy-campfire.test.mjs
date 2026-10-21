import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { z } from "zod";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false } });
const { economyCatalog: catalog, economyCatalogSchema, recipeBuildingLevel } = await vite.ssrLoadModule("/features/economy/domain/model.ts");
const identities = await vite.ssrLoadModule("/lib/dev/api-store.ts");
const api = await vite.ssrLoadModule("/lib/dev/economy-store.ts");
const { newEconomyState, applyEconomyCommand } = await vite.ssrLoadModule("/features/economy/domain/rules.ts");
const { productionSlotCount } = await vite.ssrLoadModule("/features/economy/domain/production-slots.ts");
const { obtainableResidentOrderItems } = await vite.ssrLoadModule("/features/economy/domain/food.ts");
const now = Date.parse("2026-10-18T16:00:00.000Z");
const fresh = () => newEconomyState({ resources: { sparks: 0, wood: 0, stone: 0 }, houseLevel: 1, workshopLevel: 0 });
const recipe = catalog.recipes.find(recipe => recipe.id === "cook_grilled_fish");
const upgrade = catalog.buildings.find(building => building.id === "dryer").levels[0];
const apply = (state, action, targetId, at = now, quantity = 1) => applyEconomyCommand(state, {
  requestId: crypto.randomUUID(), ownerPublicId: "0123-4567-89AB", expectedRevision: 0, action, targetId, quantity, totalPrice: 0,
}, at, () => crypto.randomUUID(), {}, () => 0);
const reject = (state, action, targetId, code, at = now, quantity = 1) => {
  const before = structuredClone(state);
  assert.throws(() => apply(state, action, targetId, at, quantity), { code });
  assert.deepEqual(state, before);
};
after(() => vite.close());

test("the existing level-zero campfire cooks one fish without awarding an upgrade or supplies", () => {
  const state = fresh();
  assert.equal(state.buildings.dryer, 0);
  assert.equal(recipeBuildingLevel(recipe), 0);
  state.inventory = { fish_common: 2, wood: 3 };
  const wallet = structuredClone(state.wallet);
  apply(state, "start_production", recipe.id);
  const job = structuredClone(state.jobs[0]);
  assert.equal(state.buildings.dryer, 0);
  assert.equal(productionSlotCount(state, "dryer"), 1);
  assert.deepEqual(state.wallet, wallet);
  assert.deepEqual(state.inventory, { fish_common: 1, wood: 3 });
  assert.deepEqual(job.cost, recipe.cost);
  assert.deepEqual(job.rewards, recipe.rewards);
  assert.equal(Date.parse(job.finishesAt) - now, recipe.seconds * 1000);
  reject(state, "start_construction", "dryer", "ECONOMY_BUILDING_BUSY");
  reject(state, "start_construction", "dryer", "ECONOMY_BUILDING_BUSY", Date.parse(job.finishesAt));
  reject(state, "start_production", recipe.id, "ECONOMY_BUILDING_BUSY", Date.parse(job.finishesAt));
  apply(state, "claim_job", job.id, Date.parse(job.finishesAt));
  assert.deepEqual(state.inventory, { fish_common: 1, wood: 3, grilled_fish: 1 });
  assert.equal(state.progression.recipes.cook_grilled_fish, 1);
  assert.equal(state.buildings.dryer, 0);
});

test("food reachability uses the recipe level and keeps the other kitchen sources locked", () => {
  const state = fresh(), before = structuredClone(state);
  const reachable = obtainableResidentOrderItems(state);
  assert.equal(reachable.has("grilled_fish"), true);
  for (const id of ["fish_soup", "berry_compote", "berry_fish"]) assert.equal(reachable.has(id), false);
  assert.deepEqual(state, before);
  state.buildings.dryer = 1;
  assert.equal(obtainableResidentOrderItems(state).has("berry_compote"), true);
});

test("all other campfire recipes remain locked at zero even with a high house and full recipe history", () => {
  const state = fresh();
  state.buildings.home = 5;
  state.inventory = Object.fromEntries(catalog.items.map(item => [item.id, 1]));
  state.progression.recipes = Object.fromEntries(catalog.recipes.map(recipe => [recipe.id, 100]));
  for (const other of catalog.recipes.filter(recipe => recipe.buildingId === "dryer" && recipe.id !== "cook_grilled_fish")) {
    assert.ok(other.buildingLevel >= 1);
    reject(state, "start_production", other.id, "ECONOMY_BUILDING_REQUIRED");
  }
  reject(state, "start_production", "make_planks", "ECONOMY_BUILDING_REQUIRED");
  reject(state, "buy_production_slot", "dryer", "ECONOMY_BUILDING_REQUIRED");
});

test("the base campfire retains fish, batch and construction locks", () => {
  const state = fresh();
  reject(state, "start_production", recipe.id, "ECONOMY_RESOURCES");
  state.inventory.fish_common = 2;
  reject(state, "start_production", recipe.id, "INVALID_ECONOMY_COMMAND", now, 2);
  apply(state, "start_construction", "dryer");
  assert.equal(state.buildings.dryer, 0);
  const job = state.jobs[0];
  assert.equal(job.targetLevel, 1);
  assert.deepEqual(job.cost, upgrade.cost);
  assert.equal(Date.parse(job.finishesAt) - now, upgrade.seconds * 1000);
  reject(state, "start_production", recipe.id, "ECONOMY_BUILDING_BUSY");
  apply(state, "claim_job", job.id, Date.parse(job.finishesAt));
  assert.equal(state.buildings.dryer, 1);
  state.inventory.berries = 3;
  apply(state, "start_production", "cook_compote", Date.parse(job.finishesAt));
  assert.equal(state.jobs[0].recipeId, "cook_compote");
});

test("existing paid campfire results and levels are retained without grants or refunds", () => {
  const state = fresh();
  state.inventory = { fish_common: 1 };
  apply(state, "start_production", recipe.id);
  state.jobs[0].catalogVersion = 10;
  const job = structuredClone(state.jobs[0]), wallet = structuredClone(state.wallet);
  apply(state, "claim_job", job.id, Date.parse(job.finishesAt));
  assert.deepEqual(state.wallet, wallet);
  assert.equal(state.buildings.dryer, 0);
  assert.deepEqual(state.inventory, { grilled_fish: 1 });
  state.buildings.dryer = 3;
  state.productionSlots = { dryer: 2 };
  assert.equal(productionSlotCount(state, "dryer"), 2);
  state.inventory.fish_common = 2;
  apply(state, "start_production", recipe.id);
  apply(state, "start_production", recipe.id);
  assert.equal(state.buildings.dryer, 3);
  assert.equal(state.jobs.length, 2);
});

test("positive wire levels remain readable by old clients and only the explicit grilled-fish flag opens the base fire", () => {
  assert.equal(economyCatalogSchema.safeParse(catalog).success, true);
  const player = identities.createDevIdentity("Костёр", crypto.randomUUID());
  const wire = JSON.parse(JSON.stringify(api.getDevEconomy(player.token, now).catalog));
  const legacyPositiveLevels = z.object({ recipes: z.array(z.object({ buildingLevel: z.number().int().positive() })) });
  assert.equal(legacyPositiveLevels.safeParse(wire).success, true, "actual local API output keeps the legacy positive contract");
  const wireRecipe = wire.recipes.find(recipe => recipe.id === "cook_grilled_fish");
  assert.equal(wireRecipe.buildingLevel, 1);
  assert.equal(wireRecipe.baseCampfire, true);
  assert.equal(recipeBuildingLevel(wireRecipe), 0);
  for (const change of [
    recipe => { recipe.buildingLevel = 0; },
    recipe => { recipe.buildingLevel = -1; },
    recipe => { recipe.buildingLevel = 2; },
    recipe => { recipe.id = "cook_compote"; },
    recipe => { recipe.buildingId = "workshop"; },
    recipe => { recipe.baseCampfire = false; },
  ]) {
    const changed = structuredClone(catalog);
    change(changed.recipes.find(recipe => recipe.id === "cook_grilled_fish"));
    assert.equal(economyCatalogSchema.safeParse(changed).success, false);
  }
  const previous = structuredClone(catalog);
  delete previous.recipes.find(recipe => recipe.id === "cook_grilled_fish").baseCampfire;
  assert.equal(economyCatalogSchema.safeParse(previous).success, true);
  assert.equal(recipeBuildingLevel(previous.recipes.find(recipe => recipe.id === "cook_grilled_fish")), 1);
  assert.equal(recipeBuildingLevel({ ...wireRecipe, id: "cook_compote" }), 1);
});
