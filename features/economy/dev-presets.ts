import { economyCatalog, type EconomyCatalog } from "./model";

/** Highest reachable building levels at a fixed home tier; no prices or timers. */
export function economyDevSettlement(homeLevel: number, catalog: EconomyCatalog = economyCatalog): Record<string, number> {
  if (!catalog.buildings.find(building => building.id === "home")?.levels.some(level => level.level === homeLevel))
    throw new RangeError("Unknown home level");
  const levels: Record<string, number> = Object.fromEntries(catalog.buildings.map(building => [building.id, building.id === "home" ? homeLevel : 0]));
  // Iterate one level at a time, so cross-building requirements stay satisfied.
  let changed = true;
  while (changed) {
    changed = false;
    for (const building of catalog.buildings) {
      if (building.id === "home") continue;
      const next = building.levels.find(level => level.level === levels[building.id] + 1);
      if (!next || next.requiredHomeLevel > homeLevel
        || Object.entries(next.requiredBuildings).some(([id, minimum]) => (levels[id] ?? 0) < minimum)) continue;
      levels[building.id] = next.level;
      changed = true;
    }
  }
  return levels;
}
