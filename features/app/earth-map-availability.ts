import type { ActivityMode } from "@/features/activity/session";

/** The public map does not depend on a live gameplay lease. Hidden documents
 * pause rendering/GPS in Earth itself without destroying its loading session. */
export function earthMapAvailable({ mode, startupActive, covered }: {
  mode: ActivityMode;
  startupActive: boolean;
  covered: boolean;
}): boolean {
  return !startupActive && !covered && mode !== "away";
}
