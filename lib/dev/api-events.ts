import type { ClickerSeriesEvent } from "@/lib/check-in-contract";

type EventSink = (line: string) => void;
const recentEventIds = new Set<string>();
const MAX_RECENT_EVENT_IDS = 2_048;

export function logDevClickerSeries(
  event: ClickerSeriesEvent,
  sink: EventSink = console.info,
): void {
  if (
    process.env.NODE_ENV === "production"
    && process.env.DEV_API_EVENT_LOGS !== "true"
  ) return;
  if (recentEventIds.has(event.eventId)) return;
  recentEventIds.add(event.eventId);
  if (recentEventIds.size > MAX_RECENT_EVENT_IDS) {
    const oldest = recentEventIds.values().next().value;
    if (oldest) recentEventIds.delete(oldest);
  }
  sink(JSON.stringify({
    schema_version: event.lifetimeTaps === undefined ? 1 : 2,
    event: "clicker_series_finished",
    source: "next_dev",
    client_reported: true,
    tap_count: event.tapCount,
    best_series: event.bestSeries,
    ...(event.lifetimeTaps === undefined ? {} : { lifetime_taps: event.lifetimeTaps }),
    level: event.level,
    story_id: event.storyId,
    duration_ms: event.durationMs,
    reason: event.reason,
  }));
}
