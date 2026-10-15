import type { EconomyView } from "@/features/economy/domain/model";
import type { NotificationTarget } from "@/features/notifications/notification-browser";

export type WorldNotificationEntry = { ownerPublicId: string; request: number; target: Exclude<NotificationTarget, "checkin"> };
export type WorldNotificationDestination = { kind: "activities" } | { kind: "pantry" } | { kind: "builder" }
  | { kind: "station"; stationId: string; recipeId?: string };

/** Notifications can outlive a claimed/cancelled job. Explicit mine links retain
 * their station; generic categories use confirmed current state without guessing actors. */
export function worldNotificationDestination(target: WorldNotificationEntry["target"], economy: EconomyView, now: number): WorldNotificationDestination {
  if (target === "mine") return { kind: "station", stationId: "quarry" };
  if (target === "activities") return { kind: "activities" };
  const job = economy.jobs.filter(job => job.kind === target).map(job => ({ job,
    readyAt: Date.parse(job.kind === "production" && job.targetId === "garden" ? job.collection?.finishesAt ?? "" : job.finishesAt),
  })).filter(({ readyAt }) => readyAt <= now)
    .sort((left, right) => left.readyAt - right.readyAt || left.job.id.localeCompare(right.job.id))[0]?.job;
  if (job) return { kind: "station", stationId: job.targetId, ...(job.recipeId ? { recipeId: job.recipeId } : {}) };
  return { kind: target === "construction" ? "builder" : "pantry" };
}
