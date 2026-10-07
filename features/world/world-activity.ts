import type { EconomySceneActivity } from "./economy-scene-state";
import type { WorldState } from "./model";
import { sceneJourney } from "./journey-timeline";

export type WorldActivity = {
  id: string; label: string; kind: "forest" | "fishing" | "cave" | "production";
  progress: number; remainingSeconds: number; ready: boolean; itemId?: string;
  collectionPhase?: "ripe" | "harvesting";
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

export function activityTime(seconds: number) {
  const value = Math.max(0, Math.ceil(seconds));
  if (value < 60) return `${value} с`;
  const minutes = Math.ceil(value / 60);
  if (minutes < 60) return `${minutes} мин`;
  const hours = Math.floor(minutes / 60), rest = minutes % 60;
  if (hours < 24) return `${hours} ч${rest ? ` ${rest} мин` : ""}`;
  return `${Math.floor(hours / 24)} д${hours % 24 ? ` ${hours % 24} ч` : ""}`;
}

export function activityStatus(activity: WorldActivity) {
  if (activity.collectionPhase === "harvesting") return "Собирает ягоды";
  if (activity.collectionPhase === "ripe") return "Ягоды созрели";
  return activity.ready ? activity.kind === "production" ? "Можно забрать" : "Находки ждут" : `Ещё ${activityTime(activity.remainingSeconds)}`;
}
