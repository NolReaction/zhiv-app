import type { ClickerSeriesEvent } from "@/lib/check-in-contract";
import { CLICKER_STORIES, getClickerLevel } from "@/lib/clicker-story";

const EVENT_KEYS = [
  "bestSeries",
  "durationMs",
  "eventId",
  "level",
  "lifetimeTaps",
  "reason",
  "storyId",
  "tapCount",
  "type",
] as const;
const LEGACY_EVENT_KEYS = EVENT_KEYS.filter((key) => key !== "lifetimeTaps");
const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const STORY_IDS = new Set(CLICKER_STORIES.map((story) => story.id));
const MAX_SERIES_DURATION_MS = 7 * 24 * 60 * 60_000;

export function parseClickerSeriesEvent(value: unknown): ClickerSeriesEvent | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  const isCurrentShape = sameKeys(keys, EVENT_KEYS);
  const isLegacyShape = sameKeys(keys, LEGACY_EVENT_KEYS);
  if (!isCurrentShape && !isLegacyShape) {
    return null;
  }
  const lifetimeTaps = isCurrentShape ? record.lifetimeTaps : undefined;
  if (
    typeof record.eventId !== "string" || !UUID_V4.test(record.eventId)
    || record.type !== "CLICKER_SERIES_FINISHED"
    || typeof record.tapCount !== "number" || !Number.isSafeInteger(record.tapCount)
    || record.tapCount < 1 || record.tapCount > 100_000
    || typeof record.bestSeries !== "number" || !Number.isSafeInteger(record.bestSeries)
    || record.bestSeries < record.tapCount || record.bestSeries > 100_000
    || (isCurrentShape && (typeof lifetimeTaps !== "number"
      || !Number.isSafeInteger(lifetimeTaps) || lifetimeTaps < record.bestSeries))
    || typeof record.level !== "number" || !Number.isSafeInteger(record.level)
    || record.level !== (isCurrentShape
      ? getClickerLevel(lifetimeTaps as number).level
      : legacyLevel(record.bestSeries))
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
    ...(isCurrentShape ? { lifetimeTaps: lifetimeTaps as number } : {}),
    level: record.level,
    storyId: record.storyId,
    durationMs: record.durationMs,
    reason: record.reason,
  };
}

function sameKeys(
  keys: readonly string[],
  expected: readonly string[],
): boolean {
  const sorted = [...expected].sort();
  return keys.length === sorted.length && keys.every((key, index) => key === sorted[index]);
}

function legacyLevel(bestSeries: number): number {
  if (bestSeries >= 100_000) return 10;
  if (bestSeries >= 10_000) return 9;
  if (bestSeries >= 1_000) return 8;
  if (bestSeries >= 500) return 7;
  if (bestSeries >= 100) return 6;
  if (bestSeries >= 50) return 5;
  if (bestSeries >= 20) return 4;
  if (bestSeries >= 10) return 3;
  if (bestSeries >= 5) return 2;
  return 1;
}
