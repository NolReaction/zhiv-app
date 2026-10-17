import type { EconomyCommand, EconomyResult, EconomyView } from "./model";

export type LocalExplorationReceipt = Readonly<{
  id: string; ownerPublicId: string; revision: number; jobId: string;
}>;

/** An exact accepted start must add its own real job. Call only for a start
 * initiated in this session, never for a restored pending command or a GET. */
export function localExplorationFromReceipt(before: EconomyView, result: EconomyResult,
  command: EconomyCommand): LocalExplorationReceipt | null {
  const after = result.state;
  if (!["start_exploration", "start_fishing"].includes(command.action)
    || before.ownerPublicId !== after.ownerPublicId || command.ownerPublicId !== after.ownerPublicId
    || command.expectedRevision !== before.revision || result.acceptedRevision !== before.revision + 1
    || after.revision < result.acceptedRevision) return null;
  const previous = new Set(before.jobs.map(job => job.id));
  const additions = after.jobs.filter(job => job.kind === "exploration" && job.targetId === command.targetId && !previous.has(job.id));
  const job = additions.length === 1 ? additions[0] : null;
  if (!job || command.action === "start_fishing" && !job.fishing) return null;
  return Object.freeze({ id: command.requestId, ownerPublicId: after.ownerPublicId,
    revision: result.acceptedRevision, jobId: job.id });
}
