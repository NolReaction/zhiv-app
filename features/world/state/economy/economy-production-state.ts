import type { EconomySceneJourney } from "./economy-scene-state";
import type { FixedWorldScene, SiteVisual } from "@/features/world/tiled/types";

/** Confirmed server jobs only. No costs, output goods or command callbacks enter the scene. */
export type EconomySceneProduction = { ownerPublicId: string; revision: number; jobs: readonly {
  id: string; stationId: string; stationLevel: number; recipeId: string; startedAt: string; finishesAt: string;
}[] };
export type ForestProductionFrame = {
  jobId: string; recipeId: string; stationId: "dryer" | "workshop" | "woodlot" | "quarry";
  phase: "working" | "ready"; x: number; y: number; size: number; elapsed: number; fireId?: string;
};
type ProductionHolder = { economyProduction?: EconomySceneProduction };

/** Shared cameras retain the highest observed revision, including an empty job list. */
export function syncForestProduction(holder: ProductionHolder, incoming: EconomySceneProduction | null | undefined,
  expectedOwner?: string): boolean {
  if (!incoming || expectedOwner && incoming.ownerPublicId !== expectedOwner
    || !Number.isSafeInteger(incoming.revision) || incoming.revision < 0 || incoming.jobs.length > 100) return false;
  const current = holder.economyProduction;
  if (current && (current.ownerPublicId !== incoming.ownerPublicId && !expectedOwner
    || current.ownerPublicId === incoming.ownerPublicId && current.revision >= incoming.revision)) return false;
  holder.economyProduction = { ...incoming, jobs: incoming.jobs.map(job => ({ ...job })) };
  return true;
}

/** Dates select busy/ready; shared cosmetic time animates the bounded marks.
 * Ready remains visible until the next confirmed snapshot removes the job. */
export function forestProductionFrames(snapshot: EconomySceneProduction | null | undefined, scene: FixedWorldScene,
  visuals: Readonly<Record<string, Pick<SiteVisual, "level">>>, now: number, elapsed: number,
  showBuildings = true): ForestProductionFrame[] {
  if (!snapshot || !showBuildings || !Number.isFinite(now)) return [];
  const time = Number.isFinite(elapsed) ? Math.max(0, elapsed) : 0;
  const result: ForestProductionFrame[] = [], used = new Set<string>();
  // A building keeps animating while any slot works. Ready orders remain in the
  // map badge and menu, but must not extinguish another slot's cooking/fire.
  const jobs = [...snapshot.jobs].sort((a, b) => Number(Date.parse(a.finishesAt) <= now) - Number(Date.parse(b.finishesAt) <= now)
    || Date.parse(a.finishesAt) - Date.parse(b.finishesAt) || a.id.localeCompare(b.id));
  for (const job of jobs) {
    const start = Date.parse(job.startedAt), finish = Date.parse(job.finishesAt);
    if (used.has(job.stationId) || !Number.isInteger(job.stationLevel) || job.stationLevel <= 0
      || !Number.isFinite(start) || !Number.isFinite(finish) || finish <= start || now < start) continue;
    const frame = { jobId: job.id, recipeId: job.recipeId, phase: now < finish ? "working" as const : "ready" as const, elapsed: time };
    if (job.stationId === "dryer") {
      const fire = scene.campfires?.find(fire => fire.id === "clearing-campfire") ?? scene.campfires?.[0];
      if (!fire || ![fire.position.x, fire.position.y, fire.radius].every(Number.isFinite) || fire.radius <= 0) continue;
      result.push({ ...frame, stationId: "dryer", ...fire.position, size: fire.radius * 4, fireId: fire.id });
    } else if (job.stationId === "workshop" || job.stationId === "woodlot" || job.stationId === "quarry") {
      const site = scene.sites.find(site => site.id === job.stationId);
      if (!site || (visuals[site.id]?.level ?? 0) <= 0
        || ![site.entry.x, site.entry.y, site.bounds.width].every(Number.isFinite) || site.bounds.width <= 0) continue;
      result.push({ ...frame, stationId: job.stationId, ...site.entry, size: Math.max(18, Math.min(32, site.bounds.width * .12)) });
    } else continue;
    used.add(job.stationId);
  }
  return result;
}

/** The quarry worker is a cosmetic use of an already confirmed production job.
 * The caller gives real expeditions precedence; this creates no extra work,
 * inventory or rewards and never extends the server-owned deadline. */
export function forestProductionJourney(snapshot: EconomySceneProduction | null | undefined, now: number): EconomySceneJourney | null {
  if (!snapshot || !Number.isFinite(now)) return null;
  const job = snapshot.jobs.filter(job => job.stationId === "quarry" && job.stationLevel > 0
    && Number.isInteger(job.stationLevel) && Date.parse(job.startedAt) <= now && Date.parse(job.finishesAt) > now)
    .sort((a, b) => Date.parse(a.finishesAt) - Date.parse(b.finishesAt) || a.id.localeCompare(b.id))[0];
  return job ? { id: `production:${job.id}`, routeId: "quarry_work", startedAt: job.startedAt,
    finishesAt: job.finishesAt, label: "Работает в шахте" } : null;
}
