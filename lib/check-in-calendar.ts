import type { CheckInCalendarResponse } from "@/lib/check-in-contract";
import { GAME_ITEMS, type GameItemId } from "@/lib/game-rewards";
import { formatLocalDate } from "@/lib/daily-streak";

export function isCalendarMonth(value: string): boolean {
  return /^(?!0000)[0-9]{4}-(0[1-9]|1[0-2])$/.test(value);
}

/** Calendar date strings are civil dates, not instants in the phone's timezone. */
export function calendarDate(value: string): Date {
  const [year, month, day = 1] = value.split("-").map(Number);
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(12, 0, 0, 0);
  return date;
}

export function calendarDateKey(date: Date): string {
  return `${String(date.getUTCFullYear()).padStart(4, "0")}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`;
}

export function calendarCountLabel(count: number): string {
  const lastTwo = count % 100;
  const last = count % 10;
  return `${count} ${lastTwo >= 11 && lastTwo <= 14 ? "отметок" : last === 1 ? "отметка" : last >= 2 && last <= 4 ? "отметки" : "отметок"}`;
}

/** Schedule from server instants: changing the device clock cannot move midnight. */
export function calendarRefreshDelay(serverTime: string, nextDayAt: string): number {
  const remaining = Date.parse(nextDayAt) - Date.parse(serverTime);
  return Number.isFinite(remaining) ? Math.max(250, Math.min(48 * 60 * 60_000, remaining + 150)) : 60_000;
}

/** Project elapsed 24-hour milestones into the viewer's civil dates, including DST. */
export function calendarRewardForecast(calendar: CheckInCalendarResponse, owned: readonly GameItemId[], longestDays: number) {
  // Older servers cannot provide an accurate anchor. Do not guess from the last tap.
  if (calendar.streakStartedAt === undefined) return [];
  const now = Date.parse(calendar.serverTime);
  const start = Date.parse(calendar.streakStartedAt ?? calendar.serverTime);
  return GAME_ITEMS.filter(item => !owned.includes(item.id) && longestDays < item.days).map(item => {
    const threshold = start + (item.days - 1) * 86_400_000;
    const at = Math.max(now, threshold);
    return { ...item, at: new Date(at).toISOString(), date: formatLocalDate(new Date(at), calendar.timeZone),
      due: threshold <= now, active: calendar.streakStartedAt !== null };
  });
}
