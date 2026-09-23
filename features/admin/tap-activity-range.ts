import type { AdminTapActivity, AdminTapRange } from "./admin-api";

export const TAP_ACTIVITY_RANGES: { minutes: AdminTapRange; label: string }[] = [
  { minutes: 30, label: "30 минут" }, { minutes: 1440, label: "24 часа" }, { minutes: 10080, label: "7 дней" },
];

export function currentTapReport(report: AdminTapActivity | null, publicId: string | undefined, range: AdminTapRange) {
  return report?.publicId === publicId && report?.history.rangeMinutes === range ? report : null;
}

export function formatTapBucket(value: string, range: AdminTapRange) {
  return new Date(value).toLocaleString("ru-RU", { timeZone: "UTC", hour: "2-digit", minute: "2-digit",
    ...(range === 30 ? {} : { day: "2-digit", month: "2-digit" }) });
}
