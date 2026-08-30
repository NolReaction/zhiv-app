import type { DailyStreak } from "@/lib/check-in-contract";

const DAY_MS = 24 * 60 * 60 * 1_000;

export function formatLocalDate(at: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(at);
  const value = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? "";
  return `${value("year")}-${value("month")}-${value("day")}`;
}

export function calculateRollingStreak(
  checkInTimes: readonly string[],
  serverTime: Date,
): DailyStreak {
  const nowMs = serverTime.getTime();
  const events = [...new Set(checkInTimes
    .map((value) => Date.parse(value))
    .filter((value) => Number.isFinite(value) && value <= nowMs))]
    .sort((first, second) => first - second);

  if (events.length === 0) {
    return { currentDays: 0, longestDays: 0, isActive: false, renewBy: null };
  }

  let runStartedAt = events[0];
  let previousAt = events[0];
  let longestDays = 1;
  let latestRunDays = 1;

  for (let index = 1; index < events.length; index += 1) {
    const checkedAt = events[index];
    if (checkedAt - previousAt > DAY_MS) runStartedAt = checkedAt;
    previousAt = checkedAt;
    latestRunDays = 1 + Math.floor((checkedAt - runStartedAt) / DAY_MS);
    longestDays = Math.max(longestDays, latestRunDays);
  }

  const latestAt = events.at(-1)!;
  const renewByMs = latestAt + DAY_MS;
  const isActive = nowMs <= renewByMs;
  return {
    currentDays: isActive ? latestRunDays : 0,
    longestDays,
    isActive,
    renewBy: isActive ? new Date(renewByMs).toISOString() : null,
  };
}

export function formatDayCount(days: number): string {
  const normalized = Math.max(0, Math.trunc(days));
  const lastTwo = normalized % 100;
  const last = normalized % 10;
  const word = lastTwo >= 11 && lastTwo <= 14
    ? "дней"
    : last === 1
      ? "день"
      : last >= 2 && last <= 4
        ? "дня"
        : "дней";
  return `${normalized} ${word}`;
}

export function getDailyStreakMessage(streak: DailyStreak): string {
  if (!streak.isActive || streak.currentDays === 0) return "Начните новую серию";
  return "Следующая серверная отметка продлит серию";
}
