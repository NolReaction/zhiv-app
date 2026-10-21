import { economyCatalog, type EconomyCatalog, type EconomyCost, type EconomyState } from "./model";

/** Quote for the materials supplied directly to the first tutorial construction. */
export function workshopStarterCost(catalog: Pick<EconomyCatalog, "buildings"> = economyCatalog): EconomyCost {
  const cost = catalog.buildings.find(building => building.id === "workshop")?.levels.find(level => level.level === 1)?.cost;
  if (!cost) throw new Error("Workshop starter cost is missing from the economy catalog");
  return { coins: cost.coins, items: { ...cost.items } };
}

/** Keep the retired loose-material command unavailable for older clients. */
export function canClaimWorkshopStarter(_state: Pick<EconomyState, "buildings" | "jobs" | "workshopStarterClaimed">): boolean {
  void _state;
  return false;
}

/** Earmarked assistance never enters inventory and cannot be claimed a second time. */
export function canStartTutorialWorkshop(state: Pick<EconomyState, "buildings" | "jobs" | "workshopStarterClaimed">): boolean {
  return !state.workshopStarterClaimed && (state.buildings.workshop ?? 0) === 0
    && !state.jobs.some(job => job.kind === "construction" && job.targetId === "workshop");
}
