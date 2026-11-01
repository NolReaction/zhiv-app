import type { EconomySceneActivity } from "@/features/world/state/economy/economy-scene-state";
import type { WorldState } from "@/features/world/domain/model";
import { sceneJourney } from "@/features/world/activities/journeys/journey-timeline";
import { worldCountdown } from "@/features/economy/ui/shared/world-stations";
import type { EconomyView } from "@/features/economy/domain/model";
import { isMinerJob } from "@/features/economy/domain/actor-availability";
import { miningBatchProgress } from "@/features/economy/domain/mining-batch";

export type WorldActivity = {
  id: string; label: string; kind: "forest" | "fishing" | "cave" | "production" | "mining";
  progress: number; remainingSeconds: number; ready: boolean; itemId?: string;
  collectionPhase?: "ripe" | "harvesting";
  readyCount?: number;
};

export function activityRouteKind(routeId = ""): WorldActivity["kind"] {
  if (/fishing|shore|coastal|brook/.test(routeId)) return "fishing";
  if (/cave|quarry/.test(routeId)) return "cave";
  return "forest";
}

/** Only confirmed timestamps determine progress. Completing the clock never claims a reward. */
export function worldActivity(activity: EconomySceneActivity | null | undefined, state: WorldState | undefined,
  now: number): WorldActivity | null {
  const legacy = activity ? undefined : sceneJourney(state, now);
  const source = activity ?? legacy;
  if (!source || !Number.isFinite(now)) return null;
  const start = Date.parse(source.startedAt), finish = Date.parse(source.finishesAt);
  if (!Number.isFinite(start) || !Number.isFinite(finish) || finish <= start) return null;
  const kind = activity?.kind === "production" ? "production" : activityRouteKind(source.routeId);
  const label = activity?.label || (kind === "fishing" ? "Рыбалка" : kind === "cave" ? "Пещеры" : "Лесная прогулка");
  const collection = activity?.collection;
  if (kind === "production" && collection?.kind === "berry_harvest" && collection.startedAt && collection.finishesAt) {
    const harvestStart = Date.parse(collection.startedAt), harvestFinish = Date.parse(collection.finishesAt);
    if (Number.isFinite(harvestStart) && Number.isFinite(harvestFinish) && harvestFinish > harvestStart) {
      // The scene may still be walking back after the minimum server duration.
      // Keep the activity visible until the confirmed claim actually removes it.
      return { id: source.id, label: "Ягодный куст", kind, itemId: activity?.itemId, collectionPhase: "harvesting", ready: false,
        progress: 1,
        remainingSeconds: Math.max(0, Math.ceil((harvestFinish - now) / 1000)) };
    }
  }
  return { id: source.id, label: label.replace(/ · \d+ ч$/, ""), kind, itemId: activity?.itemId,
    collectionPhase: collection?.kind === "berry_harvest" && now >= finish ? "ripe" : undefined,
    progress: Math.max(0, Math.min(1, (now - start) / (finish - start))),
    remainingSeconds: Math.max(0, Math.ceil((finish - now) / 1000)), ready: now >= finish };
}

/** The miner has a separate clock and never replaces the hero's current activity.
 * Show the next unit and retain the completed count until a confirmed collection. */
export function worldMiningActivity(state: EconomyView | null | undefined, now: number): WorldActivity | null {
  if (!state || !Number.isFinite(now)) return null;
  const job = state.jobs.find(isMinerJob);
  if (!job) return null;
  const start = Date.parse(job.startedAt), finish = Date.parse(job.finishesAt);
  if (!Number.isFinite(start) || !Number.isFinite(finish) || finish <= start || now < start) return null;
  const progress = miningBatchProgress(job, now);
  if (!progress.remaining && !progress.ready) return null;
  return {
    id: job.id, label: "Шахта", kind: "mining", ready: progress.remaining === 0,
    readyCount: progress.ready, progress: progress.unitRatio,
    remainingSeconds: Math.max(0, Math.ceil((progress.nextAt - now) / 1000)),
  };
}

export function activityTime(seconds: number) {
  return worldCountdown(seconds);
}

export function activityStatus(activity: WorldActivity) {
  if (activity.kind === "mining") {
    if (activity.ready) return `Добыча готова: ${activity.readyCount ?? 1}`;
    const nextUnit = `Следующая единица через ${activityTime(activity.remainingSeconds)}`;
    return activity.readyCount ? `Готово ${activity.readyCount}. ${nextUnit}` : nextUnit;
  }
  if (activity.collectionPhase === "harvesting") return "Собирает ягоды";
  if (activity.collectionPhase === "ripe") return "Ягоды созрели";
  return activity.ready ? activity.kind === "production" ? "Можно забрать" : "Находки ждут" : activityTime(activity.remainingSeconds);
}
