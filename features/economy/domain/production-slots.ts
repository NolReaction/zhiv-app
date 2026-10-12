import { economyCatalog, type EconomyState } from "./model";

type SlotState = Pick<EconomyState, "productionSlots">;
export type ProductionSlotOffer = typeof economyCatalog.productionSlots.upgrades[number];

/** The quarry is a single actor activity, never an unattended production station. */
export function productionStationSupported(stationId: string): boolean {
  return stationId !== "quarry" && economyCatalog.recipes.some(recipe => recipe.buildingId === stationId);
}

/** Unclaimed results continue to occupy their slot; only claim_job releases it. */
export function productionSlotCount(state: SlotState, stationId: string): number {
  if (!productionStationSupported(stationId)) return 1;
  const count = state.productionSlots?.[stationId];
  return Number.isInteger(count) ? Math.max(1, Math.min(3, count!)) : 1;
}

/** Quotes a single next tier, independently of whether it is unlocked or affordable. */
export function productionSlotOffer(state: SlotState, stationId: string): ProductionSlotOffer | null {
  if (!productionStationSupported(stationId)) return null;
  const next = productionSlotCount(state, stationId) + 1;
  return economyCatalog.productionSlots.upgrades.find(offer => offer.slots === next) ?? null;
}
