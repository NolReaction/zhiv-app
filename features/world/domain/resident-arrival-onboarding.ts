import type { MarketUnlockOnboardingCourse } from "./market-unlock-onboarding";

export type ResidentArrivalProgress = { version: 1; arrived: boolean; dismissed: boolean };
export function parseResidentArrivalProgress(raw: string | null): ResidentArrivalProgress | null {
  if (!raw) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const item = value as Record<string, unknown>;
      if (item.version === 1 && typeof item.arrived === "boolean" && typeof item.dismissed === "boolean")
        return { version: 1, arrived: item.arrived, dismissed: item.dismissed };
    }
  } catch { /* A damaged local presentation preference does not unlock a resident. */ }
  return null;
}

/** The resident’s building must already be claimed in a confirmed snapshot of this account. */
export function residentArrivalCanStart({ loaded, unlocked, enabled, onboarding }: {
  loaded: boolean; unlocked: boolean; enabled: boolean; onboarding: MarketUnlockOnboardingCourse;
}) {
  return loaded && unlocked && enabled && onboarding.loaded
    && (onboarding.isPaused || Boolean(onboarding.progress && onboarding.progress.status !== "started"));
}
