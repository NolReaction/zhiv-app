import { economyCatalog, economyStageOrderProgressSchema, economyStageOrdersSchema,
  type EconomyCatalog, type EconomyStageOrders, type EconomyState } from "./model";
import { firstStageState, LEGACY_FIRST_STAGE_IDS, normalizeFirstStage, tutorialOrderProgress } from "./tutorial-order";
import type { ResidentOrderOffer } from "./food";

type StageSource = Pick<EconomyState, "stageOrders" | "tutorialOrder" | "buildings"> & { catalog?: EconomyCatalog; serverTime?: string };
const copyTerms = (terms: NonNullable<ReturnType<typeof economyStageOrderProgressSchema.parse>["terms"]>) =>
  ({ ...terms, items: { ...terms.items }, ...(terms.requiredBuildings ? { requiredBuildings: { ...terms.requiredBuildings } } : {}),
    ...(terms.requiredExplorations ? { requiredExplorations: { ...terms.requiredExplorations } } : {}) });

export function stageOrdersProgress(state: Pick<EconomyState, "stageOrders">): EconomyStageOrders {
  return economyStageOrdersSchema.parse(state.stageOrders);
}
export function stageOrderProgress(state: StageSource, homeLevel = state.buildings.home ?? 1) {
  return economyStageOrderProgressSchema.parse(stageOrdersProgress(firstStageState(state, state.catalog ?? economyCatalog)).stages[String(homeLevel)] ?? {});
}
export function isStageOrderId(id: string, catalog = economyCatalog): boolean {
  return /^stage[1234]_/.test(id) || LEGACY_FIRST_STAGE_IDS.includes(id) || Boolean(catalog.stageOrders?.some(stage => stage.orders.some(order => order.id === id)));
}
function currentCourse(state: StageSource, catalog: EconomyCatalog) {
  const tutorial = tutorialOrderProgress(state);
  const home = state.buildings.home ?? 1;
  if (home === 1 && (tutorial.version !== 3 || !tutorial.completed)) return null;
  if (home === 2 && tutorial.version !== 1 && !tutorial.completed) return null;
  return catalog.stageOrders?.find(stage => stage.homeLevel === (state.buildings.home ?? 1)) ?? null;
}
/** The caller persists this only with an accepted command; GET quotes use a clone. */
export function ensureStageOrders(state: StageSource, catalog = state.catalog ?? economyCatalog, now = 0): boolean {
  const migrated = normalizeFirstStage(state, catalog);
  const course = currentCourse(state, catalog);
  if (!course) return migrated;
  const progress = stageOrderProgress(state, course.homeLevel);
  if (progress.completed) return migrated;
  const terms = progress.terms ?? course.orders[progress.step];
  if (!terms) return migrated;
  if (progress.terms && progress.availableAt !== null && progress.intervalSeconds !== null && progress.completionRewards !== null) return migrated;
  const current = stageOrdersProgress(state);
  state.stageOrders = { ...current, stages: { ...current.stages,
    [String(course.homeLevel)]: { ...progress, terms: copyTerms(terms),
      availableAt: progress.availableAt ?? new Date(now).toISOString(), intervalSeconds: progress.intervalSeconds ?? course.intervalSeconds,
      completionRewards: { ...(progress.completionRewards ?? course.completionRewards) } } } };
  return true;
}
/** Stable accepted conditions override subsequent catalog edits and never expire. */
export function stageResidentOrder(state: StageSource, catalog = state.catalog ?? economyCatalog):
  (ResidentOrderOffer & { intervalSeconds: number; completionRewards: Record<string, number>;
    requiredBuildings?: Record<string, number> | null; requiredExplorations?: Record<string, number> | null }) | null {
  state = firstStageState(state, catalog);
  const course = currentCourse(state, catalog);
  if (!course) return null;
  const progress = stageOrderProgress(state, course.homeLevel);
  if (progress.completed || progress.step >= course.orders.length) return null;
  const terms = progress.terms ?? course.orders[progress.step];
  if (!terms) return null;
  return { ...copyTerms(terms), description: terms.description ?? undefined, slot: -2,
    templateId: terms.id, availableAt: progress.availableAt ?? state.serverTime ?? "1970-01-01T00:00:00.000Z",
    intervalSeconds: progress.intervalSeconds ?? course.intervalSeconds,
    completionRewards: progress.step === course.orders.length - 1 ? { ...(progress.completionRewards ?? course.completionRewards) } : {} };
}
export function stageCourseRequired(state: StageSource, targetHomeLevel: number, catalog = state.catalog ?? economyCatalog): boolean {
  state = firstStageState(state, catalog);
  const home = state.buildings.home ?? 1;
  const version = tutorialOrderProgress(state).version;
  if (home === 1 && version !== 3 || home === 2 && version === 1 || targetHomeLevel !== home + 1) return false;
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
    const availableAt = a && b && a.step === b.step && a.availableAt && b.availableAt
      ? Date.parse(a.availableAt) >= Date.parse(b.availableAt) ? a.availableAt : b.availableAt : selected.availableAt;
    stages[key] = { ...selected, step: Math.max(a?.step ?? 0, b?.step ?? 0), completed: Boolean(a?.completed || b?.completed),
      terms: selected.terms ? copyTerms(selected.terms) : null, availableAt,
      completionRewards: selected.completionRewards ? { ...selected.completionRewards } : null };
  }
  return { version: 1, stages };
}
