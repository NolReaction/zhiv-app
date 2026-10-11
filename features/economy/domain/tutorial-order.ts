import { economyCatalog, economyTutorialOrderSchema, type EconomyCatalog, type EconomyState } from "./model";
import type { ResidentOrderOffer } from "./food";

export const TUTORIAL_ORDER_ID = "tutorial_first_order";
type TutorialSource = Pick<EconomyState, "tutorialOrder"> & { catalog?: EconomyCatalog };
/** Browser course progress never controls this server-owned, one-time grant. */
export function tutorialOrderProgress(state: TutorialSource) {
  return economyTutorialOrderSchema.parse(state.tutorialOrder);
}
/** A pre-claim quote or a frozen accepted request. This order never rotates or expires. */
export function tutorialResidentOrder(state: TutorialSource, catalog = state.catalog ?? economyCatalog): ResidentOrderOffer | null {
  const progress = tutorialOrderProgress(state);
  if (progress.completed) return null;
  const terms = progress.terms ?? catalog.onboarding?.residentOrder;
  if (!terms) return null;
  return { ...terms, id: TUTORIAL_ORDER_ID, description: terms.description ?? undefined, items: { ...terms.items },
    slot: -1, templateId: TUTORIAL_ORDER_ID, availableAt: "1970-01-01T00:00:00.000Z" };
}
