import type { ClickerSeriesEvent } from "@/lib/check-in-contract";
import { CLICKER_STORIES, getClickerLevel } from "@/lib/clicker-story";

const EVENT_KEYS = [
  "bestSeries",
  "durationMs",
  "eventId",
  "level",
  "reason",
  "storyId",
  "tapCount",
  "type",
] as const;
const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const STORY_IDS = new Set(CLICKER_STORIES.map((story) => story.id));
const MAX_SERIES_DURATION_MS = 7 * 24 * 60 * 60_000;

export function parseClickerSeriesEvent(value: unknown): ClickerSeriesEvent | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (keys.length !== EVENT_KEYS.length || keys.some((key, index) => key !== [...EVENT_KEYS].sort()[index])) {
    return null;
  }
  if (
    typeof record.eventId !== "string" || !UUID_V4.test(record.eventId)
    || record.type !== "CLICKER_SERIES_FINISHED"
    || typeof record.tapCount !== "number" || !Number.isSafeInteger(record.tapCount)
    || record.tapCount < 1 || record.tapCount > 100_000
    || typeof record.bestSeries !== "number" || !Number.isSafeInteger(record.bestSeries)
    || record.bestSeries < record.tapCount || record.bestSeries > 100_000
    || typeof record.level !== "number" || !Number.isSafeInteger(record.level)
    || record.level !== getClickerLevel(record.bestSeries).level
    || typeof record.storyId !== "string" || !STORY_IDS.has(record.storyId)
    || typeof record.durationMs !== "number" || !Number.isSafeInteger(record.durationMs)
    || record.durationMs < 0 || record.durationMs > MAX_SERIES_DURATION_MS
    || record.reason !== "IDLE_TIMEOUT"
  ) return null;

  return {
    eventId: record.eventId,
    type: record.type,
    tapCount: record.tapCount,
    bestSeries: record.bestSeries,
    level: record.level,
    storyId: record.storyId,
    durationMs: record.durationMs,
    reason: record.reason,
  };
}
