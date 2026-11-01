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
  grow_blueberries: "cook_strawberry_compote", grow_currants: "cook_blueberry_compote",
  grow_blackberries: "cook_currant_jelly", grow_cranberries: "cook_blackberry_preserve",
  grind_lens: "make_glass_bottle", assemble_field_kit: "make_research_gear",
};
const recipe = id => catalog.recipes.find(row => row.id === id);
const apply = (state, action, targetId, at = now) => rules.applyEconomyCommand(state, {
  requestId: crypto.randomUUID(), ownerPublicId: "0123-4567-89AB", expectedRevision: 0,
  action, targetId, quantity: 1, totalPrice: 0,
}, at, () => crypto.randomUUID());
const supplied = prerequisite => {
  const state = rules.newEconomyState({ resources: { sparks: 0, wood: 0, stone: 0 }, houseLevel: 1, workshopLevel: 0 });
  state.buildings = Object.fromEntries(catalog.buildings.map(building => [building.id, building.levels.at(-1).level]));
  state.inventory = Object.fromEntries(catalog.items.map(item => [item.id, 2]));
  state.wallet.coins = 100_000;
  // The previous cooking lesson can be learned, while this one remains unclaimed.
  state.progression.recipes = { ...recipe(prerequisite).requiredRecipes };
  return state;
};
const locked = (state, target, at = now) => {
  const before = structuredClone(state);
  assert.throws(() => apply(state, "start_production", target, at), { code: "ECONOMY_RECIPE_REQUIRED" });
  assert.deepEqual(state, before, "a locked recipe spends nothing and does not alter active jobs");
};

for (const [target, prerequisite] of Object.entries(unlocks)) {
  test(`${target} opens only after personally claiming ${prerequisite}`, () => {
    const state = supplied(prerequisite);
    assert.deepEqual(recipe(target).requiredRecipes, { [prerequisite]: 1 });
    // The inventory already contains every output: buying or receiving it is not mastery.
    locked(state, target);
    apply(state, "start_production", prerequisite);
    const job = state.jobs[0], readyAt = Date.parse(job.finishesAt);
    locked(state, target, readyAt);
    apply(state, "claim_job", job.id, readyAt);
    assert.equal(state.progression.recipes[prerequisite], 1);
    const restored = JSON.parse(JSON.stringify(state));
    apply(restored, "start_production", target, readyAt);
    assert.equal(restored.jobs[0].recipeId, target, "a claimed unlock survives persistence");
  });

  test(`cancelling ${prerequisite} does not open ${target}`, () => {
    const state = supplied(prerequisite);
    apply(state, "start_production", prerequisite);
    apply(state, "cancel_production", state.jobs[0].id, now + 1);
    assert.equal(state.progression.recipes[prerequisite] ?? 0, 0);
    locked(state, target, now + 1);
  });
}
