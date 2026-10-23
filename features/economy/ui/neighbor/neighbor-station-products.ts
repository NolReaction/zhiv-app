import { economyCatalog, recipeBuildingLevel, type EconomyCatalog } from "@/features/economy/domain/model";

type StationWorld = { buildings: Record<string, number> };
export type NeighborStationProduct = { id: string; name: string; needsRecipeLearning: boolean;
  outputs: { itemId: string; name: string; quantity: number }[] };

/** Building capabilities are catalog previews, never an invented current job or a grant. */
export function neighborStationProducts(world: StationWorld, stationId: string, catalog: EconomyCatalog = economyCatalog): NeighborStationProduct[] {
  const buildings = world.buildings, home = buildings.home ?? 1, stationLevel = buildings[stationId] ?? 0;
  const requirementsMet = (requiredHome: number, requiredBuildings: Record<string, number>) => home >= requiredHome
    && Object.entries(requiredBuildings).every(([id, level]) => (buildings[id] ?? 0) >= level);
  const sources = stationId === "quarry" ? catalog.explorations.filter(route => route.activity === "mining" && stationLevel > 0
    && requirementsMet(route.requiredHomeLevel, route.requiredBuildings)).map(route => ({ ...route, requiredRecipes: {} }))
    : catalog.recipes.filter(recipe => recipe.buildingId === stationId && stationLevel >= recipeBuildingLevel(recipe)
      && requirementsMet(recipe.requiredHomeLevel, recipe.requiredBuildings));
  const products = new Map<string, NeighborStationProduct>();
  // Faster methods of the same output are a single capability, not extra items.
  for (const source of [...sources].sort((left, right) => left.seconds - right.seconds)) {
    const outputs = Object.entries(source.rewards).flatMap(([itemId, quantity]) => {
      const item = catalog.items.find(candidate => candidate.id === itemId);
      return item && quantity > 0 ? [{ itemId, name: item.name, quantity }] : [];
    });
    if (!outputs.length) continue;
    const key = outputs.map(output => `${output.itemId}:${output.quantity}`).sort().join("|");
    if (!products.has(key)) products.set(key, { id: source.id, name: source.name,
      needsRecipeLearning: Object.keys(source.requiredRecipes ?? {}).length > 0, outputs });
  }
  return [...products.values()];
}
