import type { EconomyView } from "@/features/economy/domain/model";
import { residentOrderBoard, type ResidentOrderOffer } from "@/features/economy/domain/food";
import { tutorialOrderProgress, tutorialResidentOrder } from "@/features/economy/domain/tutorial-order";
import { stageResidentOrder } from "@/features/economy/domain/stage-orders";
import { ECONOMY_MAX_BALANCE } from "@/features/economy/domain/money";

export type OrderJournalOffer = ResidentOrderOffer & {
  completionRewards?: Record<string, number>;
  requiredBuildings?: Record<string, number> | null;
  requiredExplorations?: Record<string, number> | null;
};

/** Transport locks do not change whether the saved goods and reward can be handed over. */
export function orderOfferReady(state: EconomyView, offer: OrderJournalOffer, now: number): boolean {
  if (Date.parse(offer.availableAt) > now || state.wallet.coins > ECONOMY_MAX_BALANCE - offer.coins
    || Object.entries(offer.items).some(([id, quantity]) => (state.inventory[id] ?? 0) < quantity)
    || Object.entries(offer.requiredBuildings ?? {}).some(([id, level]) => (state.buildings[id] ?? 0) < level)
    || Object.entries(offer.requiredExplorations ?? {}).some(([id, count]) => (state.progression?.routes[id] ?? 0) < count)) return false;
  const rewards = Object.values(offer.completionRewards ?? {}).reduce((total, quantity) => total + quantity, 0);
  const consumed = Object.values(offer.items).reduce((total, quantity) => total + quantity, 0);
  return rewards === 0 || state.storage.used + state.storage.reserved - consumed + rewards <= state.storage.capacity;
}

/** One readiness definition serves the journal heading, card markers and dock badge. */
export function orderJournalSummary(state: EconomyView, now: number, residentId?: "plesk" | "builder", tutorialOnly = false): { total: number; ready: number } {
  if (!state.catalog.food) return { total: 0, ready: 0 };
  const tutorial = tutorialOrderProgress(state).ingredientsClaimed ? tutorialResidentOrder(state) : null;
  const offers = tutorialOnly ? [tutorial] : [tutorial, stageResidentOrder(state), ...residentOrderBoard(state, now, state.catalog).offers];
  const matching = offers
    .filter((offer): offer is OrderJournalOffer => Boolean(offer && (!residentId || offer.residentId === residentId)));
  return { total: matching.length, ready: matching.filter(offer => orderOfferReady(state, offer, now)).length };
}
