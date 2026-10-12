import type { EconomyView } from "./model";

export type ConstructionCompletion = { id: string; stationId: string; level: number };

/** A paid job disappearing is not enough: its promised level must be confirmed too. */
export function constructionCompletions(before: EconomyView | null, after: EconomyView): ConstructionCompletion[] {
  if (!before || before.ownerPublicId !== after.ownerPublicId || after.revision <= before.revision) return [];
  return before.jobs.flatMap(job => job.kind === "construction" && job.targetLevel !== null
    && job.targetLevel > (before.buildings[job.targetId] ?? 0)
    && after.buildings[job.targetId] === job.targetLevel && !after.jobs.some(current => current.id === job.id)
    ? [{ id: job.id, stationId: job.targetId, level: job.targetLevel }] : []);
}
