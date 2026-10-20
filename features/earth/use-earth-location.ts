"use client";

import { useCallback, useLayoutEffect, useMemo, useSyncExternalStore } from "react";
import { createEarthLocationController } from "./location";
import { getEarthLocationPreferenceStore } from "./location-preferences";

export function useEarthLocation({ ownerPublicId, enabled, autoStartWhenGranted = false }: {
  ownerPublicId: string; enabled: boolean; autoStartWhenGranted?: boolean | null;
}) {
  // A different owner gets a fresh, empty controller before rendering. Layout
  // cleanup retires the former owner's callbacks before the new screen is painted.
  const controller = useMemo(() => createEarthLocationController(ownerPublicId), [ownerPublicId]);
  const preference = useMemo(() => getEarthLocationPreferenceStore(ownerPublicId), [ownerPublicId]);
  const choice = useSyncExternalStore(preference.subscribe, preference.getSnapshot, preference.getServerSnapshot);
  // Read the current preference before activation, including the hydration pass.
  // This subscription also halts watches synchronously when another control in
  // this tab switches OFF, before React has painted its next state.
  useLayoutEffect(() => {
    const changed = () => controller.setAllowed(preference.getSnapshot().enabled);
    changed();
    return preference.subscribe(changed);
  }, [controller, preference]);
  useLayoutEffect(() => controller.activate(), [controller]);
  useLayoutEffect(() => { controller.setEnabled(enabled); }, [controller, enabled]);
  useLayoutEffect(() => {
    controller.setAutomaticStartPolicy(preference.getSnapshot().automaticStartAllowed ? autoStartWhenGranted : false);
  }, [controller, preference, autoStartWhenGranted, choice.automaticStartAllowed]);
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getServerSnapshot);
  const start = useCallback(() => { if (preference.allowAutomaticStart()) controller.start(); }, [controller, preference]);
  const locate = useCallback(() => { if (preference.allowAutomaticStart()) controller.locate(); }, [controller, preference]);
  return { ...state, allowed: choice.enabled, start, locate, stop: controller.stop, freeze: controller.freeze };
}
