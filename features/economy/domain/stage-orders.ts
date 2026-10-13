import { economyCatalog, economyStageOrderProgressSchema, economyStageOrdersSchema,
  type EconomyCatalog, type EconomyStageOrders, type EconomyState } from "./model";
import { tutorialOrderProgress } from "./tutorial-order";
import type { ResidentOrderOffer } from "./food";

type StageSource = Pick<EconomyState, "stageOrders" | "tutorialOrder" | "buildings"> & { catalog?: EconomyCatalog };
const copyTerms = (terms: NonNullable<ReturnType<typeof economyStageOrderProgressSchema.parse>["terms"]>) =>
  ({ ...terms, items: { ...terms.items } });

export function stageOrdersProgress(state: Pick<EconomyState, "stageOrders">): EconomyStageOrders {
  return economyStageOrdersSchema.parse(state.stageOrders);
}
export function stageOrderProgress(state: StageSource, homeLevel = state.buildings.home ?? 1) {
  return economyStageOrderProgressSchema.parse(stageOrdersProgress(state).stages[String(homeLevel)] ?? {});
}
export function isStageOrderId(id: string, catalog = economyCatalog): boolean {
  return /^stage[234]_/.test(id) || Boolean(catalog.stageOrders?.some(stage => stage.orders.some(order => order.id === id)));
}
function currentCourse(state: StageSource, catalog: EconomyCatalog) {
  const tutorial = tutorialOrderProgress(state);
  if (tutorial.version === 2 && !tutorial.completed) return null;
  return catalog.stageOrders?.find(stage => stage.homeLevel === (state.buildings.home ?? 1)) ?? null;
}
/** The caller persists this only with an accepted command; GET quotes use a clone. */
export function ensureStageOrders(state: StageSource, catalog = state.catalog ?? economyCatalog): boolean {
  const course = currentCourse(state, catalog);
  if (!course) return false;
  const progress = stageOrderProgress(state, course.homeLevel);
  if (progress.completed || progress.terms) return false;
  const terms = course.orders[progress.step];
  if (!terms) return false;
  const current = stageOrdersProgress(state);
  state.stageOrders = { ...current, stages: { ...current.stages,
    [String(course.homeLevel)]: { ...progress, terms: copyTerms(terms) } } };
  return true;
}
/** Stable accepted conditions override subsequent catalog edits and never expire. */
export function stageResidentOrder(state: StageSource, catalog = state.catalog ?? economyCatalog): ResidentOrderOffer | null {
  const course = currentCourse(state, catalog);
  if (!course) return null;
  const progress = stageOrderProgress(state, course.homeLevel);
  if (progress.completed || progress.step >= course.orders.length) return null;
  const terms = progress.terms ?? course.orders[progress.step];
  if (!terms) return null;
  return { ...copyTerms(terms), description: terms.description ?? undefined, slot: -2,
    templateId: terms.id, availableAt: "1970-01-01T00:00:00.000Z" };
}
export function stageCourseRequired(state: StageSource, targetHomeLevel: number, catalog = state.catalog ?? economyCatalog): boolean {
  const home = state.buildings.home ?? 1;
  if (tutorialOrderProgress(state).version !== 2 || targetHomeLevel !== home + 1) return false;
  const course = catalog.stageOrders?.find(stage => stage.homeLevel === home);
  return Boolean(course && !stageOrderProgress(state, home).completed);
}
/** The furthest accepted step supplies frozen terms; completed courses cannot reopen. */
export function mergeStageOrders(first?: EconomyStageOrders | null, second?: EconomyStageOrders | null): EconomyStageOrders {
  const left = economyStageOrdersSchema.parse(first ?? undefined), right = economyStageOrdersSchema.parse(second ?? undefined);
  const stages: EconomyStageOrders["stages"] = {};
  for (const key of new Set([...Object.keys(left.stages), ...Object.keys(right.stages)])) {
    const a = left.stages[key], b = right.stages[key];
    const selected = !a ? b : !b ? a : a.step !== b.step ? a.step > b.step ? a : b
      : a.completed !== b.completed ? a.completed ? a : b : a.terms || !b.terms ? a : b;
    if (!selected) continue;
    stages[key] = { ...selected, step: Math.max(a?.step ?? 0, b?.step ?? 0), completed: Boolean(a?.completed || b?.completed),
      terms: selected.terms ? copyTerms(selected.terms) : null };
  }
  return { version: 1, stages };
}
