export const APP_ONBOARDING_VERSION = 2;
export const APP_ONBOARDING_STEPS = ["check-in", "calendar", "people", "profile", "world"] as const;
export type AppOnboardingStep = typeof APP_ONBOARDING_STEPS[number];
export type AppOnboardingProgress =
  | { version: 2; status: "started"; stepId: AppOnboardingStep; completedSteps: AppOnboardingStep[]; baselineCheckInAt: string | null }
  | { version: 2; status: "completed" | "skipped" };

export type AppOnboardingEvidence = {
  activeView: "check-in" | "people" | "profile";
  lastCheckInAt: string | null;
  nextAllowedAt: string | null;
  nowMs: number;
  unconfirmed: boolean;
  isSending: boolean;
  calendarOpen: boolean;
  worldOpen: boolean;
};

function isStep(value: unknown): value is AppOnboardingStep {
  return APP_ONBOARDING_STEPS.some(step => step === value);
}

export function parseAppOnboarding(raw: string | null): AppOnboardingProgress | null {
  if (!raw) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const state = value as Record<string, unknown>;
    if (state.version !== APP_ONBOARDING_VERSION) return null;
    if (state.status === "completed" || state.status === "skipped") return { version: 2, status: state.status };
    if (state.status !== "started" || !isStep(state.stepId) || !Array.isArray(state.completedSteps)
      || !state.completedSteps.every(isStep)) return null;
    if (state.baselineCheckInAt !== null && (typeof state.baselineCheckInAt !== "string"
      || !Number.isFinite(Date.parse(state.baselineCheckInAt)))) return null;
    return { version: 2, status: "started", stepId: state.stepId,
      completedSteps: [...new Set(state.completedSteps)], baselineCheckInAt: state.baselineCheckInAt as string | null };
  } catch { return null; }
}

export function startAppOnboarding(lastCheckInAt: string | null): AppOnboardingProgress {
  return { version: 2, status: "started", stepId: "check-in", completedSteps: [], baselineCheckInAt: lastCheckInAt };
}

/** Only confirmed application state can satisfy an exercise; navigation never sends an API command. */
export function observeAppOnboarding(progress: AppOnboardingProgress | null, evidence: AppOnboardingEvidence): AppOnboardingProgress | null {
  if (progress?.status !== "started") return progress;
  const { stepId } = progress;
  if (stepId === "world" && evidence.worldOpen) return { version: 2, status: "completed" };
  if (progress.completedSteps.includes(stepId)) return progress;
  const confirmedCheckIn = Boolean(evidence.lastCheckInAt && Number.isFinite(Date.parse(evidence.lastCheckInAt))
    && !evidence.unconfirmed && !evidence.isSending
    && (evidence.lastCheckInAt !== progress.baselineCheckInAt
      || Boolean(evidence.nextAllowedAt && Date.parse(evidence.nextAllowedAt) > evidence.nowMs)));
  const done = stepId === "check-in" ? confirmedCheckIn
    : stepId === "calendar" ? evidence.calendarOpen
      : stepId === "people" ? evidence.activeView === "people"
        : stepId === "profile" ? evidence.activeView === "profile" : false;
  return done ? { ...progress, completedSteps: [...progress.completedSteps, stepId] } : progress;
}

/** Skipping one exercise moves forward without claiming its action was performed. */
export function advanceAppOnboarding(progress: AppOnboardingProgress | null): AppOnboardingProgress | null {
  if (progress?.status !== "started") return progress;
  const index = APP_ONBOARDING_STEPS.indexOf(progress.stepId);
  const stepId = APP_ONBOARDING_STEPS[index + 1];
  return stepId ? { ...progress, stepId } : { version: 2, status: "completed" };
}

export function previousAppOnboarding(progress: AppOnboardingProgress | null): AppOnboardingProgress | null {
  if (progress?.status !== "started") return progress;
  const index = APP_ONBOARDING_STEPS.indexOf(progress.stepId);
  return index > 0 ? { ...progress, stepId: APP_ONBOARDING_STEPS[index - 1] } : progress;
}
