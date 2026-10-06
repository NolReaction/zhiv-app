import type { EconomyView } from "./model";

/** A finished timer still reserves the builder until its paid job is claimed. */
export function economyBuilderStatus(state: Pick<EconomyView, "jobs" | "catalog">, now: number) {
  const job = state.jobs.find(entry => entry.kind === "construction");
  if (!job) return null;
  const end = Date.parse(job.finishesAt);
  const timed = Number.isFinite(end) && Number.isFinite(now);
  return {
    job,
    stationId: job.targetId,
    stationName: state.catalog.buildings.find(building => building.id === job.targetId)?.name ?? "Постройка",
    ready: timed && now >= end,
    seconds: timed ? Math.max(0, Math.ceil((end - now) / 1000)) : 0,
  };
}
