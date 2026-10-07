import type { EconomyView } from "@/features/economy/model";
import { berryCollectionStatus, type GardenCollectionView } from "@/features/economy/garden-collection";
import { CONSTRUCTION_MARKER, constructionMapPlace, type MapObjectScreenAnchor } from "./construction-map-anchor";
import type { MapObjectPlace } from "./site-interactions";

export type MapProductionPhase = "working" | "awaiting-gather" | "collecting" | "paused" | "ready" | "storage-blocked";
export type MapProduction = {
  jobId: string; kind: "production" | "construction"; stationId: string; place: MapObjectPlace; recipeName: string; itemId?: string;
  phase: MapProductionPhase; label: string; remaining: number; progress: number;
};
export type MapProductionGroup = { place: MapObjectPlace; entries: readonly MapProduction[]; construction?: MapProduction; primary: MapProduction };
const priority: Record<MapProductionPhase, number> = { ready: 0, "awaiting-gather": 1, paused: 2, "storage-blocked": 3, collecting: 4, working: 5 };
const workPriority = (entry: MapProduction) => entry.kind === "construction" && entry.phase === "ready" ? -1 : priority[entry.phase];
const compareWork = (a: MapProduction, b: MapProduction) => workPriority(a) - workPriority(b) || a.remaining - b.remaining || a.jobId.localeCompare(b.jobId);

/** Read-only presentation of confirmed work. A ripe bush still needs its real
 * gathering step; reaching zero never manufactures inventory or a claim. */
export function mapProductionGroups(state: EconomyView | null, now: number, collection: GardenCollectionView | null = null): MapProductionGroup[] {
  if (!state || !Number.isFinite(now)) return [];
  const groups = new Map<MapObjectPlace, MapProduction[]>();
  for (const job of state.jobs) {
    if (job.kind !== "production") continue;
    const recipe = state.catalog.recipes.find(entry => entry.id === job.recipeId && entry.buildingId === job.targetId);
    // Already paid quarry orders outlive the retired production catalog.
    // Keep their badge based on the saved clock/reward, including unknown old recipes.
    const recipeName = recipe?.name ?? (job.targetId === "quarry"
      ? state.catalog.explorations.find(route => route.id === job.recipeId)?.name ?? "Сохранённая добыча" : null);
    const place = constructionMapPlace(job.targetId), start = Date.parse(job.startedAt), finish = Date.parse(job.finishesAt);
    if (!recipeName || !place || !Number.isFinite(start) || !Number.isFinite(finish) || finish <= start || now < start) continue;
    const berry = berryCollectionStatus(job, state, now, collection);
    const blocked = Object.values(job.rewards).reduce((sum, amount) => sum + amount, 0) > state.storage.available;
    let phase: MapProductionPhase = "working", label = job.targetId === "garden" ? "Растёт"
      : job.targetId === "quarry" ? "Добыча" : job.targetId === "woodlot" ? "Заготовка"
        : job.targetId === "workshop" || job.targetId === "kiln" ? "Изготовление" : "Готовится";
    let clockStart = start, clockFinish = finish;
    if (now >= finish) {
      if (berry?.collecting) {
        phase = "collecting"; label = "Сбор урожая";
        const gatherStart = Date.parse(job.collection?.startedAt ?? ""), gatherFinish = Date.parse(job.collection?.finishesAt ?? "");
        if (Number.isFinite(gatherStart) && Number.isFinite(gatherFinish) && gatherFinish > gatherStart) {
          clockStart = gatherStart; clockFinish = gatherFinish;
        }
      } else if (blocked) { phase = "storage-blocked"; label = "Нет места"; }
      else if (berry && collection?.jobId === job.id && collection.phase === "paused") { phase = "paused"; label = "Сбор прерван"; }
      else if (berry && !berry.started) { phase = "awaiting-gather"; label = berry.away ? "Ждёт Мохлика" : "Созрело"; }
      else { phase = "ready"; label = "Можно забрать"; }
    }
    const entry: MapProduction = { jobId: job.id, kind: "production", stationId: job.targetId, place, recipeName,
      itemId: Object.keys(job.rewards).find(id => (job.rewards[id] ?? 0) > 0), phase, label,
      remaining: Math.max(0, Math.ceil((clockFinish - now) / 1000)),
      progress: Math.min(1, Math.max(0, (now - clockStart) / (clockFinish - clockStart))) };
    groups.set(place, [...(groups.get(place) ?? []), entry]);
  }
  return [...groups].map(([place, entries]) => {
    const job = state.jobs.find(job => job.kind === "construction" && constructionMapPlace(job.targetId) === place);
    const start = Date.parse(job?.startedAt ?? ""), finish = Date.parse(job?.finishesAt ?? "");
    const construction: MapProduction | undefined = job && Number.isFinite(start) && Number.isFinite(finish) && finish > start && now >= start
      ? { jobId: job.id, kind: "construction", stationId: job.targetId, place, recipeName: `Уровень ${job.targetLevel}`,
        phase: now >= finish ? "ready" : "working", label: now >= finish ? "Строительство завершено" : "Строительство",
        remaining: Math.max(0, Math.ceil((finish - now) / 1000)), progress: Math.min(1, Math.max(0, (now - start) / (finish - start))) } : undefined;
    entries.sort(compareWork);
    const primary = construction && compareWork(construction, entries[0]) < 0 ? construction : entries[0];
    return { place, entries, construction, primary };
  });
}

/** Keep each host to one badge and avoid covering a neighbouring host on a
 * narrow/zoomed-out map. Available work wins; no offscreen badge is pinned. */
export function layoutProductionMarkers(groups: readonly MapProductionGroup[], anchors: readonly MapObjectScreenAnchor[],
  reserved: readonly MapObjectScreenAnchor[] = []) {
  const occupied = [...reserved];
  return [...groups].sort((a, b) => compareWork(a.primary, b.primary) || a.place.localeCompare(b.place))
    .flatMap(group => {
      const anchor = anchors.find(entry => entry.place === group.place);
      if (!anchor || occupied.some(other => Math.abs(other.x - anchor.x) < CONSTRUCTION_MARKER.width + 6
        && Math.abs(other.y - anchor.y) < CONSTRUCTION_MARKER.height + 6)) return [];
      occupied.push(anchor);
      return [{ group, anchor }];
    });
}
