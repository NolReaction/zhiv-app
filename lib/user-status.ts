import type { UserStatus } from "./check-in-contract";

// Applies to new writes. Older saved statuses remain readable without truncation.
export const MAX_STATUS_LENGTH = 30;

export function normalizeUserStatus(value: string): string | null {
  if (/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u.test(value)) return null;
  const normalized = value.trim().replace(/[\s\p{Z}]+/gu, " ");
  return Array.from(normalized).length <= MAX_STATUS_LENGTH ? normalized : null;
}

export const STATUS_DURATIONS = [60, 120, 240, 480, 1440] as const;

export function validStatusDuration(value: unknown): value is number | null | undefined {
  return value === undefined || value === null || STATUS_DURATIONS.some(minutes => minutes === value);
}

export function activeUserStatus(status: UserStatus | null | undefined, nowMs: number): UserStatus | null {
  if (!status || (status.expiresAt != null && !(Date.parse(status.expiresAt) > nowMs))) return null;
  return status;
}

export function formatStatusUpdatedAt(updatedAt: string, nowMs: number): string {
  const minutes = Math.max(0, Math.floor((nowMs - Date.parse(updatedAt)) / 60_000));
  if (minutes < 1) return "обновлён только что";
  if (minutes < 60) return `обновлён ${minutes} мин назад`;
  if (minutes < 1440) return `обновлён ${Math.floor(minutes / 60)} ч назад`;
  return `обновлён ${new Date(updatedAt).toLocaleDateString("ru-RU", { day: "numeric", month: "short" })}`;
}
