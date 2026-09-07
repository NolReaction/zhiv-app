/** A timezone changes civil dates, never the server timestamps used by a streak. */
export function isTimeZone(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 64 || !/^[A-Za-z][A-Za-z0-9_+\-/]*$/.test(value)) return false;
  if (value !== "UTC" && (!value.includes("/") || value.startsWith("SystemV/"))) return false;
  try { new Intl.DateTimeFormat("en", { timeZone: value }).format(0); return true; }
  catch { return false; }
}

export function deviceTimeZone(): string {
  try {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return isTimeZone(zone) ? zone : "Europe/Moscow";
  } catch { return "Europe/Moscow"; }
}

export function timeZoneOptions(current: string): string[] {
  const zones = typeof Intl.supportedValuesOf === "function"
    ? Intl.supportedValuesOf("timeZone")
    : ["Europe/Moscow", "Europe/Berlin", "Asia/Yekaterinburg", "Asia/Vladivostok"];
  return [...new Set([current, deviceTimeZone(), "UTC", ...zones])].sort();
}

/** Local API only: find the next civil day boundary, including 23/25-hour DST days. */
export function nextLocalDay(now: Date, timeZone: string): string {
  const formatter = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" });
  const today = formatter.format(now);
  let left = now.getTime();
  let right = left + 48 * 60 * 60_000;
  while (right - left > 1) {
    const middle = Math.floor((left + right) / 2);
    if (formatter.format(middle) === today) left = middle; else right = middle;
  }
  return new Date(right).toISOString();
}
