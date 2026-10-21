import type { WorldOnboardingProgress } from "./world-onboarding";

/** One small discovery after unlocking the player market, separate from the initial course. */
export type MarketUnlockOnboardingProgress = { version: 1; status: "completed" | "dismissed" };
export type MarketUnlockOnboardingCourse = {
  loaded: boolean;
  isPaused: boolean;
  progress: WorldOnboardingProgress | null;
};

export function parseMarketUnlockOnboarding(raw: string | null): MarketUnlockOnboardingProgress | null {
  if (!raw) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const record = value as Record<string, unknown>;
    if (record.version === 1 && (record.status === "completed" || record.status === "dismissed")) {
      return { version: 1, status: record.status };
    }
  } catch { /* A damaged local preference must never block the map. */ }
  return null;
}

export function marketUnlockOnboardingCanOpen({ loaded, progress, unlocked, enabled, onboarding }: {
  loaded: boolean;
  progress: MarketUnlockOnboardingProgress | null;
  /** Confirmed building access, never a ready but unclaimed construction job. */
  unlocked: boolean;
  enabled: boolean;
  onboarding: MarketUnlockOnboardingCourse;
}) {
  return loaded && progress === null && unlocked && enabled && onboarding.loaded
    && (onboarding.isPaused || Boolean(onboarding.progress && onboarding.progress.status !== "started"));
}
