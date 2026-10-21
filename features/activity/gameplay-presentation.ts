import type { ActivityView } from "./session";

/** Delivery, local production intents and a deliberate AFK pause have separate gates. */
export function gameplayPresentation(activity: Pick<ActivityView, "mode" | "resumeRequired">, retained: boolean) {
  const active = activity.mode === "active";
  const paused = Boolean(activity.resumeRequired || activity.mode === "away" || activity.mode === "hidden");
  return {
    showGate: !active && activity.mode !== "hidden" && (paused || !retained),
    suspended: paused,
    localActions: retained && !paused,
    directActions: active && !paused,
  };
}
