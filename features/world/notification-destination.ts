import type { EconomyView } from "@/features/economy/domain/model";
import type { NotificationTarget } from "@/features/notifications/notification-browser";

export type WorldNotificationEntry = { ownerPublicId: string; request: number; target: Exclude<NotificationTarget, "checkin"> };
export type WorldNotificationDestination = { kind: "activities" } | { kind: "pantry" } | { kind: "builder" }
  | { kind: "station"; stationId: string; recipeId?: string };

/** Notifications can outlive a claimed/cancelled job. Navigate from confirmed current state. */
export function worldNotificationDestination(target: WorldNotificationEntry["target"], economy: EconomyView, now: number): WorldNotificationDestination {
  if (target === "activities") return { kind: "activities" };
  const job = economy.jobs.filter(job => job.kind === target && Date.parse(job.finishesAt) <= now)
    .sort((left, right) => Date.parse(left.finishesAt) - Date.parse(right.finishesAt) || left.id.localeCompare(right.id))[0];
  if (job) return { kind: "station", stationId: job.targetId, ...(job.recipeId ? { recipeId: job.recipeId } : {}) };
  return { kind: target === "construction" ? "builder" : "pantry" };
}
