const DAY_MS = 24 * 60 * 60 * 1_000;

export const CHECK_IN_COOLDOWN_MS = 30_000;
export const BURST_RESET_MS = 8_000;
export const PUBLIC_ID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){2}$/;

export const BURST_MESSAGES = [
  "Отметка сохранена · только что",
  "Всё ещё жив 😄",
  "Очень жив",
  "Подозрительно жив",
  "Бессмертие подтверждено",
] as const;

const CHECK_IN_MILESTONES = new Map<number, string>([
  [10, "Первая десятка. Полёт нормальный."],
  [20, "20 отметок. Уже входит в привычку."],
  [50, "Полтинник. Стабильно живой."],
  [100, "Сотая отметка. Это уже традиция."],
  [200, "200 отметок. Бессмертие набирает стаж."],
  [500, "500 отметок. Железно на связи."],
  [1_000, "Тысячная. Бессмертие подтверждено документально."],
]);

export function normalizeDisplayName(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

export function isValidDisplayName(value: string): boolean {
  const length = Array.from(normalizeDisplayName(value)).length;
  return length >= 1 && length <= 50;
}

export function normalizePublicId(value: string): string {
  const compact = value.toUpperCase().replace(/[^0-9A-Z]/g, "");
  return compact.match(/.{1,4}/g)?.join("-") ?? "";
}

export function formatPublicIdInput(value: string): string {
  const compact = value.toUpperCase().replace(/[^0-9A-Z]/g, "");
  const formatted = compact.match(/.{1,4}/g)?.join("-") ?? "";
  const manuallyTypedSeparator =
    /[-\s]$/.test(value) && (compact.length === 4 || compact.length === 8);

  return manuallyTypedSeparator ? `${formatted}-` : formatted;
}

export function isValidPublicId(value: string): boolean {
  return PUBLIC_ID_PATTERN.test(value);
}

export function getBurstMessage(tapCount: number): string {
  const index = Math.max(0, Math.min(tapCount, BURST_MESSAGES.length) - 1);
  return BURST_MESSAGES[index];
}

export function getCheckInMilestone(checkInCount: number): string | null {
  if (!Number.isSafeInteger(checkInCount) || checkInCount < 1) return null;
  return CHECK_IN_MILESTONES.get(checkInCount)
    ?? (checkInCount > 1_000 && checkInCount % 1_000 === 0
      ? `${checkInCount} отметок. Легендарная стабильность.`
      : null);
}

export function getCheckInAgeMs(
  checkedAt: string | null,
  serverOffsetMs: number,
  clientNowMs: number,
): number | null {
  if (!checkedAt) return null;
  return Math.max(0, clientNowMs + serverOffsetMs - Date.parse(checkedAt));
}

export function getCheckInColor(ageMs: number | null): string {
  if (ageMs === null) return "#4a4e45";

  const ratio = Math.max(0, Math.min(ageMs / DAY_MS, 1));
  const hue = ratio <= 0.5
    ? 140 + (45 - 140) * ratio * 2
    : 45 + (0 - 45) * (ratio - 0.5) * 2;

  return `hsl(${hue.toFixed(1)} 68% 34%)`;
}

export function formatLastCheckIn(checkedAt: string | null, nowMs: number): string {
  if (!checkedAt) return "Ещё не отмечались";

  const checkedAtMs = Date.parse(checkedAt);
  const ageMs = Math.max(0, nowMs - checkedAtMs);
  const minutes = Math.floor(ageMs / 60_000);
  const time = new Intl.DateTimeFormat("ru-RU", {
    hour: "2-digit",
    minute: "2-digit",
  }).format(checkedAtMs);

  if (minutes < 1) return "Последняя отметка · только что";
  if (minutes < 60) return `Последняя отметка · ${minutes} мин назад`;

  const sameDay = new Date(checkedAtMs).toDateString() === new Date(nowMs).toDateString();
  if (sameDay) return `Последняя отметка · сегодня в ${time}`;

  const date = new Intl.DateTimeFormat("ru-RU", {
    day: "numeric",
    month: "short",
  }).format(checkedAtMs);
  return `Последняя отметка · ${date}, ${time}`;
}

export function formatPersonCheckIn(
  checkedAt: string | null,
  nowMs: number,
  sharingEnabled: boolean,
): string {
  if (!sharingEnabled) return "Отметки недоступны";
  if (!checkedAt) return "После добавления ещё не отмечался";

  const checkedAtMs = Date.parse(checkedAt);
  const ageMs = Math.max(0, nowMs - checkedAtMs);
  const minutes = Math.floor(ageMs / 60_000);

  if (minutes < 1) return "Только что";
  if (minutes < 60) return `${minutes} мин назад`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} ч назад`;

  const time = new Intl.DateTimeFormat("ru-RU", {
    hour: "2-digit",
    minute: "2-digit",
  }).format(checkedAtMs);
  const date = new Intl.DateTimeFormat("ru-RU", {
    day: "numeric",
    month: "short",
  }).format(checkedAtMs);
  return `${date}, ${time}`;
}
