/** Only confirmed construction jobs enter the forest. The resident owns neither
 * the construction timer nor the command that completes an upgrade. */
export type EconomySceneConstruction = {
  ownerPublicId: string;
  revision: number;
  jobs: readonly {
    id: string; stationId: string; targetLevel: number; startedAt: string; finishesAt: string;
  }[];
};
export type SceneConstructionJob = EconomySceneConstruction["jobs"][number];
type ConstructionHolder = { economyConstruction?: EconomySceneConstruction };

/** An empty newer snapshot matters: another camera must not resurrect a claimed
 * job. Copy the accepted data so later adapter/caller mutation cannot change it. */
export function syncForestConstruction(holder: ConstructionHolder,
  incoming: EconomySceneConstruction | null | undefined, expectedOwner?: string): boolean {
  if (!incoming || expectedOwner && incoming.ownerPublicId !== expectedOwner
    || !incoming.ownerPublicId || !Number.isSafeInteger(incoming.revision) || incoming.revision < 0
    || incoming.jobs.length > 100) return false;
  const current = holder.economyConstruction;
  if (current && (current.ownerPublicId !== incoming.ownerPublicId && !expectedOwner
    || current.ownerPublicId === incoming.ownerPublicId && current.revision >= incoming.revision)) return false;
  holder.economyConstruction = { ...incoming, jobs: incoming.jobs.map(job => ({ ...job })) };
  return true;
}

/** Legacy saves may contain simultaneous builds. Show one stable, oldest job,
 * including a ready job awaiting collection, without modifying the saved jobs. */
export function forestConstructionJob(snapshot: EconomySceneConstruction | null | undefined,
  now: number): SceneConstructionJob | null {
  if (!snapshot || !Number.isFinite(now)) return null;
  return snapshot.jobs.filter(job => job.id && job.stationId && Number.isSafeInteger(job.targetLevel) && job.targetLevel > 0
    && Number.isFinite(Date.parse(job.startedAt)) && Number.isFinite(Date.parse(job.finishesAt))
    && Date.parse(job.finishesAt) >= Date.parse(job.startedAt) && Date.parse(job.startedAt) <= now)
    .sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt) || a.id.localeCompare(b.id))[0] ?? null;
}
