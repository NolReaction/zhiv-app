import assert from "node:assert/strict";

/** Normative prices use one explicitly selected technology, never player buffs
 * or an arbitrary slow recipe. Random fish and shop-only goods are named external
 * valuations rather than a fabricated deterministic acquisition deadline. */
export function timeEconomyPricing(catalog) {
  const policy = catalog.timeEconomy;
  assert(policy?.version === 1, "The time economy policy is required");
  const items = new Map(catalog.items.map(item => [item.id, item]));
  const recipes = new Map(catalog.recipes.map(recipe => [recipe.id, recipe]));
  const routes = new Map(catalog.explorations.map(route => [route.id, route]));
  const cache = new Map();
  function price(itemId, path = []) {
    assert(items.has(itemId), `Unknown economic item: ${itemId}`);
    if (cache.has(itemId)) return cache.get(itemId);
    assert(!path.includes(itemId), `Price cycle: ${[...path, itemId].join(" -> ")}`);
    if (!items.get(itemId).tradable) return 0;
    const recipeId = policy.baselineRecipes[itemId], routeId = policy.baselineExplorations[itemId];
    const external = policy.externalPrices[itemId];
    assert.equal(Number(Boolean(recipeId)) + Number(Boolean(routeId)) + Number(external !== undefined), 1,
      `${itemId}: exactly one price basis is required`);
    if (external !== undefined) {
      assert(Number.isSafeInteger(external) && external > 0, `${itemId}: invalid external valuation`);
      cache.set(itemId, external); return external;
    }
    const source = recipeId ? recipes.get(recipeId) : routes.get(routeId);
    assert(source && !source.retired, `${itemId}: missing or retired baseline`);
    assert.equal(Object.keys(source.rewards).length, 1, `${itemId}: joint outputs need a separate allocation policy`);
    assert.equal(source.rewards[itemId], 1, `${itemId}: current normal technology must produce one item`);
    const inputs = Object.entries(source.cost.items).reduce((sum, [id, count]) => sum + price(id, [...path, itemId]) * count, 0);
    const value = Math.ceil(inputs + source.cost.coins + source.seconds * policy.coinsPerMinute / 60);
    assert(Number.isSafeInteger(value) && value > 0, `${itemId}: invalid derived value`);
    cache.set(itemId, value); return value;
  }
  const basket = quantities => Object.entries(quantities).reduce((sum, [id, count]) => sum + price(id) * count, 0);
  const order = quantities => Math.ceil(basket(quantities) * (10000 + policy.orderBonusBps) / 10000);
  return { price, basket, order };
}
