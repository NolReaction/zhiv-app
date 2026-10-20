"use client";

import { useLayoutEffect, useMemo, useSyncExternalStore } from "react";
import { createEarthLocationController } from "./location";

export function useEarthLocation({ ownerPublicId, enabled, autoStartWhenGranted = false }: {
  ownerPublicId: string; enabled: boolean; autoStartWhenGranted?: boolean | null;
}) {
  // A different owner gets a fresh, empty controller before rendering. Layout
  // cleanup retires the former owner's callbacks before the new screen is painted.
  const controller = useMemo(() => createEarthLocationController(ownerPublicId), [ownerPublicId]);
  useLayoutEffect(() => controller.activate(), [controller]);
  useLayoutEffect(() => { controller.setEnabled(enabled); }, [controller, enabled]);
  useLayoutEffect(() => { controller.setAutomaticStartPolicy(autoStartWhenGranted); }, [controller, autoStartWhenGranted]);
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getServerSnapshot);
  return { ...state, start: controller.start, locate: controller.locate, stop: controller.stop, freeze: controller.freeze };
}
