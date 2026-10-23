import assert from "node:assert/strict";
import { recipeBuildingLevel } from "./economy-math.mjs";

// Quotes use early production, so later technology remains a player advantage.
// Never let array order or an inaccessible future recipe reduce the time premium.
export const residentOrderBaseRecipes = Object.freeze({ iron_ingot: "smelt_iron", glass: "make_glass", reinforced_parts: "make_reinforced_parts" });

/** Offline catalogue policy only. Raw acquisition is already valued by NPC sale;
 * this adds occupied station time for processing, including crafted inputs.
 * Slot-minutes may overlap in real time and do not depend on bought extra slots. */
export function residentOrderPricing(catalog) {
  const items = new Map(catalog.items.map(item => [item.id, item]));
  const allRecipes = new Map(catalog.recipes.map(recipe => [recipe.id, recipe]));
  const recipes = new Map();
  for (const recipe of catalog.recipes.filter(recipe => Object.keys(recipe.cost.items).length > 0)) {
    assert.equal(Object.keys(recipe.rewards).length, 1, `${recipe.id}: pricing needs an explicit allocation for joint outputs`);
    const itemId = Object.keys(recipe.rewards)[0];
    recipes.set(itemId, [...(recipes.get(itemId) ?? []), recipe]);
  }
  return template => {
    const levels = { home: template.requiredHomeLevel, garden: 1, warehouse: 1, ...template.requiredBuildings };
    const cache = new Map();
    function assertAvailable(recipe, path = []) {
      assert(recipe, `${template.id}: unknown manufacturing prerequisite`);
      assert(!path.includes(recipe.id), `Order recipe prerequisite cycle: ${[...path, recipe.id].join(" -> ")}`);
      assert(levels.home >= recipe.requiredHomeLevel && (levels[recipe.buildingId] ?? 0) >= recipeBuildingLevel(recipe)
        && Object.entries(recipe.requiredBuildings ?? {}).every(([id, level]) => (levels[id] ?? 0) >= level),
      `${template.id}: baseline recipe ${recipe.id} is unavailable at the template's starting buildings`);
      for (const id of Object.keys(recipe.requiredRecipes ?? {})) assertAvailable(allRecipes.get(id), [...path, recipe.id]);
    }
    function manufacturingSeconds(itemId, path = []) {
      assert(items.has(itemId), `Unknown order item ${itemId}`);
      assert(!path.includes(itemId), `Order manufacturing cycle: ${[...path, itemId].join(" -> ")}`);
      if (cache.has(itemId)) return cache.get(itemId);
      const candidates = recipes.get(itemId) ?? [], baselineId = residentOrderBaseRecipes[itemId];
      assert(baselineId || candidates.length <= 1, `${itemId}: alternative manufacturing needs an explicit baseline recipe`);
      const recipe = baselineId ? candidates.find(recipe => recipe.id === baselineId) : candidates[0];
      if (baselineId) assert(recipe, `${itemId}: missing baseline recipe ${baselineId}`);
      let seconds = 0;
      if (recipe) {
        assertAvailable(recipe);
        const inputs = Object.entries(recipe.cost.items).reduce((total, [input, quantity]) =>
          total + quantity * manufacturingSeconds(input, [...path, itemId]), 0);
        seconds = (recipe.seconds + inputs) / recipe.rewards[itemId];
      }
      assert(Number.isSafeInteger(seconds) && seconds >= 0, `${itemId}: manufacturing policy requires whole seconds per output`);
      cache.set(itemId, seconds);
      return seconds;
    }
    const npcValue = Object.entries(template.items).reduce((total, [itemId, quantity]) => {
      assert(items.has(itemId), `Unknown order item ${itemId}`);
      return total + items.get(itemId).baseSellPrice * quantity;
    }, 0);
    const seconds = Object.entries(template.items).reduce((total, [itemId, quantity]) => total + manufacturingSeconds(itemId) * quantity, 0);
    // 1.5 × NPC value + one coin per manufacturing minute, rounded ONCE to 10.
    const coins = Math.ceil((npcValue * 90 + seconds) / 600) * 10;
    return { npcValue, manufacturingSeconds: seconds, coins };
  };
}
