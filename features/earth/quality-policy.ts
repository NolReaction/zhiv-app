export type EarthQualityLevel = "full" | "calm";
export type EarthQualityProfile = Readonly<{ intervalMs: number; oceanIntervalMs: number; precipitationScale: number }>;

/** Only decorative work changes; raster sizes, geometry and map rendering stay intact. */
export const EARTH_QUALITY_PROFILES: Readonly<Record<EarthQualityLevel, EarthQualityProfile>> = {
  full: { intervalMs: 125, oceanIntervalMs: 250, precipitationScale: 1 },
  calm: { intervalMs: 250, oceanIntervalMs: 500, precipitationScale: .7 },
};

const WINDOW_MS = 1_000;
const MIN_SAMPLES = 8;
const MAX_FRAME_GAP_MS = 1_000;
const STALE_EVIDENCE_MS = 15_000;
const CHANGE_COOLDOWN_MS = 10_000;

/**
 * Samples must be completed frames of active user camera movement, never an idle
 * timer. Two slow windows ease decor; six healthy windows restore it. Evidence
 * lives only in memory and expires rather than surviving a long inactive spell.
 */
export function createEarthQualityPolicy(onChange: (level: EarthQualityLevel, profile: EarthQualityProfile) => void) {
  let level: EarthQualityLevel = "full";
  let previous: number | null = null;
  let lastSample: number | null = null;
  let changedAt = -Infinity;
  let duration = 0, samples = 0, slow = 0;
  let slowWindows = 0, healthyWindows = 0;

  function clearWindow() { duration = 0; samples = 0; slow = 0; }
  function reset() {
    previous = null; lastSample = null;
    slowWindows = 0; healthyWindows = 0; clearWindow();
  }

  return {
    getLevel: () => level,
    breakSequence() { previous = null; },
    reset,
    observeFrame(timestamp: number) {
      if (!Number.isFinite(timestamp) || timestamp < 0) return;
      if (lastSample !== null && (timestamp < lastSample || timestamp - lastSample > STALE_EVIDENCE_MS)) reset();
      lastSample = timestamp;
      const delta = previous === null ? 0 : timestamp - previous;
      previous = timestamp;
      // Long pauses, first frames and duplicate callbacks are not evidence.
      // Keep sustained 2–3 FPS: the sample count and slow-frame ratio already
      // prevent one isolated stall from switching the profile.
      if (delta <= 0 || delta > MAX_FRAME_GAP_MS) return;
      duration += delta; samples++;
      if (delta > 40) slow++;
      if (duration < WINDOW_MS || samples < MIN_SAMPLES) return;

      const average = duration / samples, slowRatio = slow / samples;
      slowWindows = average >= 32 && slowRatio >= .35 ? slowWindows + 1 : 0;
      healthyWindows = average <= 24 && slowRatio <= .1 ? healthyWindows + 1 : 0;
      clearWindow();
      if (timestamp - changedAt < CHANGE_COOLDOWN_MS) return;
      const next = level === "full" && slowWindows >= 2 ? "calm"
        : level === "calm" && healthyWindows >= 6 ? "full" : level;
      if (next === level) return;
      level = next; changedAt = timestamp;
      slowWindows = 0; healthyWindows = 0;
      onChange(level, EARTH_QUALITY_PROFILES[level]);
    },
  };
}
