import { economyCatalog, economyTutorialOrderSchema, type EconomyCatalog, type EconomyState, type EconomyTutorialOrder } from "./model";
import type { ResidentOrderOffer } from "./food";

export const TUTORIAL_ORDER_ID = "tutorial_first_order";
type TutorialSource = Pick<EconomyState, "tutorialOrder"> & { catalog?: EconomyCatalog };
/** Saved progress without a version retains the original single-order course. */
export function tutorialOrderProgress(state: TutorialSource) {
  return economyTutorialOrderSchema.parse(state.tutorialOrder);
}
export function isTutorialOrderId(id: string, catalog = economyCatalog): boolean {
  return id === TUTORIAL_ORDER_ID || Boolean(catalog.onboarding?.residentOrders?.some(order => order.id === id));
}
/** New profiles pin their first request immediately; no ingredient grant is needed. */
export function newTutorialOrder(catalog = economyCatalog): EconomyTutorialOrder {
  const terms = catalog.onboarding?.residentOrders?.[0] ?? catalog.onboarding?.residentOrder;
  return { version: 2, step: 0, ingredientsClaimed: true, completed: false,
    terms: terms ? { ...terms, items: { ...terms.items } } : null };
}
/** A pre-claim quote or a frozen accepted request. This order never rotates or expires. */
export function tutorialResidentOrder(state: TutorialSource, catalog = state.catalog ?? economyCatalog): ResidentOrderOffer | null {
  const progress = tutorialOrderProgress(state);
  if (progress.completed) return null;
  const terms = progress.terms ?? (progress.version === 2 ? catalog.onboarding?.residentOrders?.[progress.step] : catalog.onboarding?.residentOrder);
  if (!terms) return null;
  const offerId = progress.version === 2 ? terms.id : TUTORIAL_ORDER_ID;
  return { ...terms, id: offerId, description: terms.description ?? undefined, items: { ...terms.items },
    slot: -1, templateId: offerId, availableAt: "1970-01-01T00:00:00.000Z" };
}
