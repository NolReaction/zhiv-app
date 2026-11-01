/** Script-side interpretation of earned recipe access; inventory is never evidence. */
export function personallyCaughtFish(catalog, state) {
  // Match the domain's lifetime item-counter saturation.
  return (catalog.fishing?.fish ?? []).reduce((sum, fish) => Math.min(1_000_000_000,
    sum + (state.fishing?.catches?.[fish.itemId] ?? 0)), 0);
}

export function recipeMasteryMet(catalog, state, source) {
  return Object.entries(source.requiredRecipes ?? {}).every(([id, count]) => (state.progression?.recipes?.[id] ?? 0) >= count)
    && Object.entries(source.requiredExplorations ?? {}).every(([id, count]) => (state.progression?.routes?.[id] ?? 0) >= count)
    && personallyCaughtFish(catalog, state) >= (source.requiredFishCaught ?? 0);
}

/** A reachable repeatable source can supply every finite positive count. */
export function recipeMasteryReachable(catalog, source, recipes, routes, home) {
  return Object.keys(source.requiredRecipes ?? {}).every(id => recipes.has(id))
    && Object.keys(source.requiredExplorations ?? {}).every(id => routes.has(id))
    && (!(source.requiredFishCaught > 0) || fishingMasteryReachable(catalog, routes, home));
}

export function fishingMasteryReachable(catalog, routes, home) {
  const fishing = catalog.fishing;
  return Boolean(fishing && fishing.routeIds.some(id => routes.has(id))
    && fishing.rods.some(rod => (rod.requiredHomeLevel ?? 1) <= home && fishing.classes.some(group =>
      (!rod.classOddsBps || rod.classOddsBps[group.rarity] > 0) && (group.rarity !== "legendary" || rod.rarity === "legendary")))
    && fishing.hooks.some(hook => (hook.requiredHomeLevel ?? 1) <= home));
}
