import type { AdminTapHistory } from "./admin-api";

export function tapHistoryDays(history: AdminTapHistory) {
  const days = new Map<string, { day: string; received: number; events: number; rejected: number; signals: number; watched: number }>();
  for (const minute of history.minutes) {
    const day = minute.at.slice(0, 10);
    const value = days.get(day) ?? { day, received: 0, events: 0, rejected: 0, signals: 0, watched: 0 };
    value.received += minute.receivedTaps; value.events += minute.eventTaps; value.rejected += minute.rejectedTaps;
    value.signals += Number(minute.reviewSignal); value.watched += Number(minute.watchlisted); days.set(day, value);
  }
  return [...days.values()].sort((a, b) => a.day.localeCompare(b.day));
}

/** Only validated IDs, UTC instants, booleans and numbers. No user text/formulas. */
export function tapHistoryCsv(history: AdminTapHistory): string {
  const header = "public_id,minute_utc,received_taps,event_taps,rejected_taps,delayed_taps,legacy_taps,interval_count,interval_sum_ms,interval_squared_sum_ms,review_signal,watchlisted,complete";
  const rows = history.minutes.map(row => [history.publicId, row.at, row.receivedTaps, row.eventTaps,
    row.rejectedTaps, row.delayedTaps, row.legacyTaps, row.intervalCount, row.intervalSumMs,
    row.intervalSquaredSumMs, Number(row.reviewSignal), Number(row.watchlisted), Number(row.complete)].join(","));
  return "\uFEFF" + [header, ...rows].join("\r\n") + "\r\n";
}
