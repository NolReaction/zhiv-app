"use client";

import { useLayoutEffect, useMemo, useSyncExternalStore } from "react";
import { createEarthLocationController } from "./location";

export function useEarthLocation({ ownerPublicId, enabled }: { ownerPublicId: string; enabled: boolean }) {
  // A different owner gets a fresh, empty controller before rendering. Layout
  // cleanup retires the former owner's callbacks before the new screen is painted.
  const controller = useMemo(() => createEarthLocationController(ownerPublicId), [ownerPublicId]);
  useLayoutEffect(() => controller.activate(), [controller]);
  useLayoutEffect(() => { controller.setEnabled(enabled); }, [controller, enabled]);
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getServerSnapshot);
  return { ...state, start: controller.start, stop: controller.stop };
}
