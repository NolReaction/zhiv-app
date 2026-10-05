import collectionCatalog from "@/apps/api/src/main/resources/world/collections-catalog.json";
import { ECONOMY_MAX_BALANCE, economyProgressionSchema, type EconomyJob, type EconomyProgression } from "./model";

const travelFinds: readonly string[] = collectionCatalog.travel.finds;
const quarryFinds = collectionCatalog.quarry.finds.map(find => find.id);
const knownFinds = new Set([...travelFinds, ...quarryFinds]);
const add = (first: number, second: number) => Math.min(ECONOMY_MAX_BALANCE, first + second);
export const newEconomyProgression = (): EconomyProgression => economyProgressionSchema.parse({});

/** Only known inherited forest finds participate; old river keepsakes stay in their original profile. */
export function inheritEconomyCollection(value: EconomyProgression | undefined, inherited: readonly string[]): EconomyProgression {
  const current = value ?? newEconomyProgression();
  return { ...current, collections: { ...current.collections,
    finds: [...new Set([...current.collections.finds.filter(id => knownFinds.has(id)), ...inherited.filter(id => travelFinds.includes(id))])].sort() } };
}

/** The atomic claim caller has already checked time, warehouse capacity and the receipt. */
export function advanceEconomyProgression(value: EconomyProgression | undefined, job: EconomyJob): EconomyProgression {
  const current = value ?? newEconomyProgression();
  const next = structuredClone(current);
  if (job.kind === "exploration") next.routes[job.targetId] = add(next.routes[job.targetId] ?? 0, 1);
  if (job.kind === "production" && job.recipeId) next.recipes[job.recipeId] = add(next.recipes[job.recipeId] ?? 0, 1);
  const seconds = Math.max(0, Math.floor((Date.parse(job.finishesAt) - Date.parse(job.startedAt)) / 1000));
  const travel = job.kind === "exploration" && collectionCatalog.travel.routes.includes(job.targetId);
  const quarry = job.kind === "exploration" && collectionCatalog.quarry.routes.includes(job.targetId)
    || job.kind === "production" && job.targetId === collectionCatalog.quarry.productionBuilding;
  const finds = new Set(next.collections.finds);
  for (const [eligible, field, ids, interval] of [
    [travel, "travelSeconds", travelFinds, collectionCatalog.travel.secondsPerFind],
    [quarry, "quarrySeconds", quarryFinds, collectionCatalog.quarry.secondsPerFind],
  ] as const) {
    if (!eligible) continue;
    const previous = next.collections[field], total = add(previous, seconds);
    next.collections[field] = total;
    const count = Math.min(ids.length, Math.floor(total / interval) - Math.floor(previous / interval));
    for (let index = 0; index < count; index++) {
      const missing = ids.find(id => !finds.has(id));
      if (missing) finds.add(missing);
    }
  }
  next.collections.finds = [...finds].sort();
  return next;
}

export function mergeEconomyProgression(left: EconomyProgression | undefined, right: EconomyProgression | undefined): EconomyProgression {
  const first = left ?? newEconomyProgression(), second = right ?? newEconomyProgression();
  const mergeCounts = (a: Record<string, number>, b: Record<string, number>) =>
    Object.fromEntries([...new Set([...Object.keys(a), ...Object.keys(b)])].map(id => [id, add(a[id] ?? 0, b[id] ?? 0)]));
  const finds = new Set([...first.collections.finds, ...second.collections.finds].filter(id => knownFinds.has(id)));
  const travelSeconds = add(first.collections.travelSeconds, second.collections.travelSeconds);
  const quarrySeconds = add(first.collections.quarrySeconds, second.collections.quarrySeconds);
  for (const [field, total, ids, interval] of [
    ["travelSeconds", travelSeconds, travelFinds, collectionCatalog.travel.secondsPerFind],
    ["quarrySeconds", quarrySeconds, quarryFinds, collectionCatalog.quarry.secondsPerFind],
  ] as const) {
    // Whole intervals have already been awarded in each profile. Combining only
    // their remainders can close one new interval, and later merges cannot repeat it.
    const newlyClosed = Math.max(0, Math.floor(total / interval) - Math.floor(first.collections[field] / interval) - Math.floor(second.collections[field] / interval));
    for (let index = 0; index < newlyClosed; index++) {
      const missing = ids.find(id => !finds.has(id));
      if (missing) finds.add(missing);
    }
  }
  return { routes: mergeCounts(first.routes, second.routes), recipes: mergeCounts(first.recipes, second.recipes),
    collections: { finds: [...finds].sort(), travelSeconds, quarrySeconds } };
}

export function personallyFoundBookCollection(value: EconomyProgression["collections"], inherited: readonly string[]): boolean {
  return value.travelSeconds >= collectionCatalog.travel.secondsPerFind && value.finds.some(id => travelFinds.includes(id) && !inherited.includes(id))
    || value.quarrySeconds >= collectionCatalog.quarry.secondsPerFind && value.finds.some(id => quarryFinds.includes(id) && !inherited.includes(id));
}
