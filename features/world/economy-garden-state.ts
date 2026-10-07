/** Confirmed crop dates; the scene owns presentation, never stock or job completion. */
export type EconomySceneGarden = {
  jobId: string;
  startedAt: string;
  finishesAt: string;
  collection?: { startedAt: string | null; finishesAt: string | null };
};
export type GardenHarvestRequest = { requestId: number; jobId: string };
export type GardenHarvestEvent = GardenHarvestRequest & {
  status: "started" | "completed" | "interrupted" | "unavailable";
  reason?: string;
};

/** Uses server wall time, including time spent off-screen. Rain cannot change a job deadline. */
export function economyGardenGrowth(crop: EconomySceneGarden | null, now: number): number {
  if (!crop || !Number.isFinite(now)) return 0;
  const start = Date.parse(crop.startedAt), finish = Date.parse(crop.finishesAt);
  if (!Number.isFinite(start) || !Number.isFinite(finish) || finish <= start) return 0;
  if (now >= finish) return 1;
  // The old visual renderer treats .98 as ripe. Keep the fruit just below that
  // threshold until the authoritative deadline, without an early harvest cue.
  return Math.max(0, Math.min(1, (now - start) / (finish - start))) * .98;
}
