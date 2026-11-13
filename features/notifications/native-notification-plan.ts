import type { EconomyView } from "@/features/economy/domain/model";
import type { NotificationPreferences } from "./notification-contract";

export type LocalGameReminder = {
  id: number; at: number; title: string; body: string;
  extra: { source: "mochlik-game"; ownerPublicId: string; target: "activities" | "mine" | "production" | "construction"; jobIds: string[] };
};
type Clock = { hour: number; minute: number; day: string };
const formatters = new Map<string, Intl.DateTimeFormat>();
function localClock(at: number, zone: string): Clock {
  let formatter = formatters.get(zone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
    if (formatters.size >= 8) formatters.delete(formatters.keys().next().value!);
    formatters.set(zone, formatter);
  }
  const parts = formatter.formatToParts(at);
  const get = (type: string) => parts.find(part => part.type === type)?.value ?? "0";
  return { hour: Number(get("hour")), minute: Number(get("minute")), day: `${get("year")}-${get("month")}-${get("day")}` };
}
function clockMinutes(value: string) { const [hours, minutes] = value.split(":").map(Number); return hours * 60 + minutes; }
function outsideQuietHours(at: number, preferences: NotificationPreferences): number | null {
  if (!preferences.quietHoursEnabled) return at;
  const start = clockMinutes(preferences.quietStart), end = clockMinutes(preferences.quietEnd);
  // Walk actual instants, not wall-clock additions, so DST gaps/repeated hours remain valid.
  for (let minute = 0; minute <= 27 * 60; minute++) {
    const candidate = at + minute * 60_000;
    const local = localClock(candidate, preferences.timeZone), time = local.hour * 60 + local.minute;
    if (!(start < end ? time >= start && time < end : time >= start || time < end)) return candidate;
  }
  return null;
}
function reminderId(key: string) {
  let hash = 2166136261;
  for (let index = 0; index < key.length; index++) { hash ^= key.charCodeAt(index); hash = Math.imul(hash, 16777619); }
  return (hash >>> 1) || 1;
}

/** A reminder is a prediction from a confirmed server snapshot, never a reward command. */
export function planNativeGameReminders(snapshot: Pick<EconomyView, "ownerPublicId" | "jobs">, preferences: NotificationPreferences,
  serverNow: number, deviceNow: number, previousDeliveries: readonly number[] = []): LocalGameReminder[] {
  if (![serverNow, deviceNow].every(Number.isFinite)) return [];
  const groups = new Map<number, LocalGameReminder>();
  const limitByDay = new Map<string, number>();
  let previousAt = -Infinity;
  for (const at of previousDeliveries) {
    if (!Number.isFinite(at) || at > deviceNow || at < deviceNow - 7 * 86400_000) continue;
    const day = localClock(at, preferences.timeZone).day;
    limitByDay.set(day, (limitByDay.get(day) ?? 0) + 1);
    previousAt = Math.max(previousAt, at);
  }
  for (const job of [...snapshot.jobs].sort((left, right) => Date.parse(left.finishesAt) - Date.parse(right.finishesAt) || left.id.localeCompare(right.id))) {
    if (job.kind === "construction" && !preferences.constructionCompleted || job.kind === "exploration" && !preferences.explorationCompleted
      || job.kind === "production" && !preferences.productionCompleted) continue;
    // Garden readiness also depends on the character's availability/collection state.
    if (job.kind === "production" && job.targetId === "garden") continue;
    const remaining = Date.parse(job.finishesAt) - serverNow;
    if (!Number.isFinite(remaining) || remaining <= 0 || remaining > 366 * 86400_000) continue;
    const dueAt = deviceNow + remaining;
    let at = outsideQuietHours(Math.ceil(dueAt / 60_000) * 60_000, preferences);
    if (at === null) continue;
    if (preferences.rateLimitsEnabled && Number.isFinite(previousAt)) {
      at = outsideQuietHours(Math.max(at, previousAt + preferences.minIntervalMinutes * 60_000), preferences);
      if (at === null) continue;
    }
    const target = job.kind === "exploration" ? job.actorId === "miner" ? "mine" : "activities" : job.kind;
    const key = Math.floor(at / 60_000);
    const grouped = groups.get(key);
    if (grouped) { grouped.extra.jobIds.push(job.id); grouped.body = "В лесу могли завершиться несколько дел. Загляни к Мохлику."; continue; }
    const day = localClock(at, preferences.timeZone).day;
    const dailyCount = limitByDay.get(day) ?? 0;
    if (preferences.rateLimitsEnabled && dailyCount >= preferences.maxPerDay) continue;
    groups.set(key, { id: reminderId(`${snapshot.ownerPublicId}:${job.id}`), at, title: "Мохлик ждёт тебя",
      body: job.kind === "construction" ? "По последним данным стройка должна завершиться. Проверь свой лес."
        : job.kind === "exploration" ? "Путешествие должно завершиться. Загляни за результатами."
          : "Производство должно завершиться. Проверь готовые ресурсы.",
      extra: { source: "mochlik-game", ownerPublicId: snapshot.ownerPublicId, target, jobIds: [job.id] } });
    previousAt = at; limitByDay.set(day, dailyCount + 1);
    // iOS has a finite pending queue. Leave room for future notification features.
    if (groups.size >= 32) break;
  }
  const used = new Set<number>();
  return [...groups.values()].map(value => {
    while (used.has(value.id)) value.id = value.id % 2147483647 + 1;
    used.add(value.id); return value;
  });
}
