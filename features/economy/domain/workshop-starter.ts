import { economyCatalog, type EconomyCatalog, type EconomyCost, type EconomyState } from "./model";

/** The server grants the full first-level cost once; existing savings are kept. */
export function workshopStarterCost(catalog: Pick<EconomyCatalog, "buildings"> = economyCatalog): EconomyCost {
  const cost = catalog.buildings.find(building => building.id === "workshop")?.levels.find(level => level.level === 1)?.cost;
  if (!cost) throw new Error("Workshop starter cost is missing from the economy catalog");
  return { coins: cost.coins, items: { ...cost.items } };
}

/** This is an eligibility quote; the command checks balances and storage again. */
export function canClaimWorkshopStarter(state: Pick<EconomyState, "buildings" | "jobs" | "workshopStarterClaimed">): boolean {
  return !state.workshopStarterClaimed && (state.buildings.workshop ?? 0) === 0
    && !state.jobs.some(job => job.kind === "construction" && job.targetId === "workshop");
}
