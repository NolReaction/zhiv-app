import { economyCatalog, economyStageOrderProgressSchema, economyStageOrdersSchema, economyTutorialOrderSchema,
  type EconomyCatalog, type EconomyState, type EconomyTutorialOrder } from "./model";
import type { ResidentOrderOffer } from "./food";

export const TUTORIAL_ORDER_ID = "tutorial_first_order";
export const LEGACY_FIRST_STAGE_IDS = ["tutorial_wood_order", "tutorial_compote_order", "tutorial_planks_order"];
type TutorialSource = Pick<EconomyState, "tutorialOrder"> & { catalog?: EconomyCatalog };
type FirstStageSource = Pick<EconomyState, "tutorialOrder" | "stageOrders">;
const copyTerms = (terms: NonNullable<EconomyTutorialOrder["terms"]>) => ({ ...terms, items: { ...terms.items } });

/** Reclassify old paid steps without replaying rewards or changing the active quote. */
export function normalizeFirstStage(state: FirstStageSource, catalog = economyCatalog): boolean {
  const previous = economyTutorialOrderSchema.parse(state.tutorialOrder);
  if (previous.version !== 2) return false;
  if (previous.step === 0 && !previous.completed) {
    const terms = previous.terms ?? catalog.onboarding?.residentOrder ?? null;
    // This one requested reduction also applies to an already accepted first order.
    const reduced = terms && terms.id === TUTORIAL_ORDER_ID && Object.keys(terms.items).length === 1 && terms.items.berries === 2
      ? { ...copyTerms(terms), description: terms.description?.replace("две малины", "одну малину"), items: { berries: 1 } } : terms;
    state.tutorialOrder = { ...previous, version: 3, terms: reduced ? copyTerms(reduced) : null };
    return true;
  }
  const course = catalog.stageOrders?.find(entry => entry.homeLevel === 1);
  const completed = previous.completed || previous.step >= 4;
  const step = completed ? course?.orders.length ?? 3 : Math.max(0, previous.step - 1);
  const current = economyStageOrdersSchema.parse(state.stageOrders);
  const saved = economyStageOrderProgressSchema.parse(current.stages["1"] ?? {});
  const projected = { ...saved, step, completed, terms: previous.terms ? copyTerms(previous.terms) : course?.orders[step] ?? null,
    availableAt: completed ? null : saved.availableAt ?? "1970-01-01T00:00:00.000Z",
    intervalSeconds: saved.intervalSeconds ?? course?.intervalSeconds ?? 0,
    completionRewards: saved.completionRewards ?? course?.completionRewards ?? {} };
  if (!saved.completed && (step > saved.step || step === saved.step && !saved.terms || completed))
    state.stageOrders = { ...current, stages: { ...current.stages, "1": projected } };
  state.tutorialOrder = { ...previous, version: 3, step: 1, completed: true,
    terms: catalog.onboarding?.residentOrder ? copyTerms(catalog.onboarding.residentOrder) : null };
  return true;
}
/** Projection only. A successful command persists this alongside its normal revision. */
export function firstStageState<T extends FirstStageSource>(state: T, catalog = economyCatalog): T {
  if (state.tutorialOrder?.version !== 2) return state;
  const next = { ...state };
  normalizeFirstStage(next, catalog);
  return next;
}
/** Saved progress without a version retains the original single-order course. */
export function tutorialOrderProgress(state: TutorialSource) {
  const projected = firstStageState(state, state.catalog ?? economyCatalog);
  return economyTutorialOrderSchema.parse(projected.tutorialOrder);
}
export function isTutorialOrderId(id: string, catalog = economyCatalog): boolean {
  return id === TUTORIAL_ORDER_ID || Boolean(catalog.onboarding?.residentOrders?.some(order => order.id === id));
}
/** New profiles pin their only teaching request immediately; no ingredient grant is needed. */
export function newTutorialOrder(catalog = economyCatalog): EconomyTutorialOrder {
  const terms = catalog.onboarding?.residentOrder;
  return { version: 3, step: 0, ingredientsClaimed: true, completed: false,
    firstHarvestPrepared: false,
    terms: terms ? copyTerms(terms) : null };
}
/** Account-owned first harvest aid, independent of the local lesson or its replay.
 * The start command consumes it before cancellation or another request can reuse it.
 * Old profiles with harvested berries or an existing crop keep their ordinary jobs. */
export function canPrepareTutorialHarvest(state: Pick<EconomyState, "tutorialOrder" | "buildings" | "inventory" | "jobs" | "progression">,
  recipeId: string, quantity = 1): boolean {
  const progress = tutorialOrderProgress(state);
  return recipeId === "grow_berries" && quantity === 1 && progress.version === 3 && progress.ingredientsClaimed
    && !progress.completed && progress.step === 0 && !progress.firstHarvestPrepared
    && progress.terms?.id === TUTORIAL_ORDER_ID && progress.terms.items.berries === 1 && Object.keys(progress.terms.items).length === 1
    && state.buildings.home === 1 && !(state.inventory.berries > 0) && !(state.progression?.recipes?.grow_berries > 0)
    && !state.jobs.some(job => job.kind === "production" && job.targetId === "garden");
}
/** A pre-claim quote or a frozen accepted request. This order never rotates or expires. */
export function tutorialResidentOrder(state: TutorialSource, catalog = state.catalog ?? economyCatalog): ResidentOrderOffer | null {
  const progress = tutorialOrderProgress(state);
  if (progress.completed || progress.version === 3 && progress.step > 0) return null;
  const terms = progress.terms ?? catalog.onboarding?.residentOrder;
  if (!terms) return null;
  return { ...copyTerms(terms), id: TUTORIAL_ORDER_ID, description: terms.description ?? undefined,
    slot: -1, templateId: TUTORIAL_ORDER_ID, availableAt: "1970-01-01T00:00:00.000Z" };
}
