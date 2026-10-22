"use client";

import { useCallback, useLayoutEffect, useMemo, useSyncExternalStore } from "react";
import { createEarthLocationController } from "./location";
import { getEarthLocationPreferenceStore } from "./location-preferences";

export function useEarthLocation({ ownerPublicId, enabled, autoStart = false }: {
  ownerPublicId: string | null; enabled: boolean; autoStart?: boolean | null;
}) {
  // A different owner gets a fresh, empty controller before rendering. Layout
  // cleanup retires the former owner's callbacks before the new screen is painted.
  const preference = useMemo(() => getEarthLocationPreferenceStore(ownerPublicId), [ownerPublicId]);
  const controller = useMemo(() => createEarthLocationController(ownerPublicId ?? "", undefined, preference.suppressAutomaticStart), [ownerPublicId, preference]);
  const choice = useSyncExternalStore(preference.subscribe, preference.getSnapshot, preference.getServerSnapshot);
  // Read the current preference before activation, including the hydration pass.
  // Apply every gate before activation, including Strict Mode effect replay.
  // Preference notifications also halt OFF/denied watches before React rerenders.
  useLayoutEffect(() => {
    const changed = () => {
      const current = preference.getSnapshot();
      // Close a hidden screen first, then set privacy before opening a screen.
      if (!enabled) controller.setEnabled(false);
      controller.setAllowed(current.enabled);
      controller.setAutomaticStartPolicy(current.automaticStartAllowed ? autoStart : false);
      if (enabled) controller.setEnabled(true);
    };
    changed();
    return preference.subscribe(changed);
  }, [controller, preference, enabled, autoStart]);
  useLayoutEffect(() => controller.activate(), [controller]);
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getServerSnapshot);
  const start = useCallback(() => { if (preference.allowAutomaticStart()) controller.start(); }, [controller, preference]);
  const locate = useCallback((options?: { fresh?: boolean }) => { if (preference.allowAutomaticStart()) controller.locate(options); }, [controller, preference]);
  // An automatic lease effect may have been queued before a native denial.
  // Recheck the live preference without granting permission on the user's behalf.
  const locateForPublication = useCallback(() => {
    if (preference.getSnapshot().automaticStartAllowed) controller.locate({ fresh: true });
  }, [controller, preference]);
  return { ...state, allowed: choice.enabled, start, locate, locateForPublication, stop: controller.stop, freeze: controller.freeze };
}

export type EarthLocationHandle = ReturnType<typeof useEarthLocation>;
