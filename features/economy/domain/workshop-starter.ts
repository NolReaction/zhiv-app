import { economyCatalog, type EconomyCatalog, type EconomyCost, type EconomyState } from "./model";

/** Historical quote retained for saved clients; the gift is no longer claimable. */
export function workshopStarterCost(catalog: Pick<EconomyCatalog, "buildings"> = economyCatalog): EconomyCost {
  const cost = catalog.buildings.find(building => building.id === "workshop")?.levels.find(level => level.level === 1)?.cost;
  if (!cost) throw new Error("Workshop starter cost is missing from the economy catalog");
  return { coins: cost.coins, items: { ...cost.items } };
}

/** Construction is funded from production and orders, including older profiles. */
export function canClaimWorkshopStarter(_state: Pick<EconomyState, "buildings" | "jobs" | "workshopStarterClaimed">): boolean {
  void _state;
  return false;
}
