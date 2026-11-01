import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root,
  resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false } });
after(() => vite.close());
const { economyCatalog: catalog } = await vite.ssrLoadModule("/features/economy/domain/model.ts");
const rules = await vite.ssrLoadModule("/features/economy/domain/rules.ts");
const now = Date.parse("2026-11-01T12:00:00Z");
const unlocks = {
  grow_strawberries: { cook_compote: 1 },
  make_trade_crate: { make_planks: 3, make_rope: 1 }, make_tools: { make_metal_parts: 2 },
  make_ceramic_jar: { fire_bricks: 2 }, make_glass_bottle: { make_glass: 2 },
  grind_lens: { make_glass_bottle: 1 }, assemble_field_kit: { make_research_gear: 1 },
};
const recipe = id => catalog.recipes.find(row => row.id === id);
const apply = (state, action, targetId, at = now) => rules.applyEconomyCommand(state, {
  requestId: crypto.randomUUID(), ownerPublicId: "0123-4567-89AB", expectedRevision: 0,
  action, targetId, quantity: 1, totalPrice: 0,
}, at, () => crypto.randomUUID());
const supplied = (target, prerequisite, count) => {
  const state = rules.newEconomyState({ resources: { sparks: 0, wood: 0, stone: 0 }, houseLevel: 1, workshopLevel: 0 });
  state.buildings = Object.fromEntries(catalog.buildings.map(building => [building.id, building.levels.at(-1).level]));
  state.inventory = Object.fromEntries(catalog.items.map(item => [item.id, 4]));
  state.wallet.coins = 100_000;
  // Every other condition is met; this particular skill still needs one claimed result.
  state.progression.recipes = { ...recipe(prerequisite).requiredRecipes, ...recipe(target).requiredRecipes, [prerequisite]: count - 1 };
  return state;
};
const locked = (state, target, at = now) => {
  const before = structuredClone(state);
  assert.throws(() => apply(state, "start_production", target, at), { code: "ECONOMY_RECIPE_REQUIRED" });
  assert.deepEqual(state, before, "a locked recipe spends nothing and does not alter active jobs");
};

for (const [target, required] of Object.entries(unlocks)) for (const [prerequisite, count] of Object.entries(required)) {
  test(`${target} opens only after personally claiming ${prerequisite}`, () => {
    const state = supplied(target, prerequisite, count);
    assert.deepEqual(recipe(target).requiredRecipes, required);
    // The inventory already contains every output: buying or receiving it is not mastery.
    locked(state, target);
    apply(state, "start_production", prerequisite);
    const job = state.jobs[0], readyAt = Date.parse(job.finishesAt);
    locked(state, target, readyAt);
    apply(state, "claim_job", job.id, readyAt);
    assert.equal(state.progression.recipes[prerequisite], count);
    const restored = JSON.parse(JSON.stringify(state));
    apply(restored, "start_production", target, readyAt);
    assert.equal(restored.jobs[0].recipeId, target, "a claimed unlock survives persistence");
  });

  test(`cancelling ${prerequisite} does not open ${target}`, () => {
    const state = supplied(target, prerequisite, count);
    apply(state, "start_production", prerequisite);
    apply(state, "cancel_production", state.jobs[0].id, now + 1);
    assert.equal(state.progression.recipes[prerequisite] ?? 0, count - 1);
    locked(state, target, now + 1);
  });
}

test("only strawberries require compote while all other berries open at their level", () => {
  for (const crop of catalog.recipes.filter(row => row.buildingId === "garden" && row.id !== "grow_strawberries")) assert.deepEqual(crop.requiredRecipes, {}, crop.id);
  assert.deepEqual(recipe("cook_strawberry_compote").requiredRecipes, {});
  for (const crop of catalog.recipes.filter(row => row.buildingId === "garden" && row.collection && !row.retired && row.id !== "grow_strawberries")) {
    const state = rules.newEconomyState({ resources: { sparks: 0, wood: 0, stone: 0 }, houseLevel: 1, workshopLevel: 0 });
    state.buildings.home = crop.requiredHomeLevel;
    state.buildings.garden = crop.buildingLevel;
    assert.deepEqual(state.progression.recipes, {});
    apply(state, "start_production", crop.id);
    assert.equal(state.jobs[0].recipeId, crop.id, "the advertised crop level is sufficient without a kitchen");
  }
});
