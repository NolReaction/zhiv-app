import type { DailyStreak } from "@/lib/check-in-contract";

const LOCAL_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

function localDateNumber(value: string): number | null {
  const match = LOCAL_DATE_PATTERN.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const timestamp = Date.UTC(year, month - 1, day);
  const date = new Date(timestamp);
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) return null;
  return Math.floor(timestamp / 86_400_000);
}

function localDateParts(atMs: number, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(atMs));
  const value = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((part) => part.type === type)?.value);
  return {
    year: value("year"),
    month: value("month"),
    day: value("day"),
    hour: value("hour"),
    minute: value("minute"),
    second: value("second"),
  };
}

function timeZoneOffsetMs(atMs: number, timeZone: string): number {
  const parts = localDateParts(atMs, timeZone);
  const representedAsUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  );
  return representedAsUtc - Math.floor(atMs / 1_000) * 1_000;
}

export function formatLocalDate(at: Date, timeZone: string): string {
  const { year, month, day } = localDateParts(at.getTime(), timeZone);
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

export function nextLocalDayAt(at: Date, timeZone: string): string {
  const { year, month, day } = localDateParts(at.getTime(), timeZone);
  const nextDate = new Date(Date.UTC(year, month - 1, day + 1));
  const localMidnightAsUtc = Date.UTC(
    nextDate.getUTCFullYear(),
    nextDate.getUTCMonth(),
    nextDate.getUTCDate(),
  );
  let candidate = localMidnightAsUtc - timeZoneOffsetMs(localMidnightAsUtc, timeZone);
  candidate = localMidnightAsUtc - timeZoneOffsetMs(candidate, timeZone);
  return new Date(candidate).toISOString();
}

export function calculateDailyStreak(
  localDates: readonly string[],
  todayLocalDate: string,
  nextDayAt: string,
): DailyStreak {
  const today = localDateNumber(todayLocalDate);
  if (today === null) {
    return { currentDays: 0, longestDays: 0, checkedInToday: false, nextDayAt };
  }

  const days = [...new Set(localDates.map(localDateNumber).filter(
    (day): day is number => day !== null && day <= today,
  ))].sort((first, second) => first - second);

  let longestDays = 0;
  let runLength = 0;
  let previous: number | null = null;
  for (const day of days) {
    runLength = previous !== null && day === previous + 1 ? runLength + 1 : 1;
    longestDays = Math.max(longestDays, runLength);
    previous = day;
  }

  const latest = days.at(-1);
  const checkedInToday = latest === today;
  let currentDays = 0;
  if (latest === today || latest === today - 1) {
    currentDays = 1;
    for (let index = days.length - 2; index >= 0; index -= 1) {
      if (days[index] !== days[index + 1] - 1) break;
      currentDays += 1;
    }
  }

  return { currentDays, longestDays, checkedInToday, nextDayAt };
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
  if (streak.currentDays === 0) return "Начните серию сегодня";
  if (streak.checkedInToday) return "Сегодня серия продолжена";
  return "Отметьтесь сегодня, чтобы сохранить серию";
}
