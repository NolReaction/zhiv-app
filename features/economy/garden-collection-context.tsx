"use client";

import { createContext, useContext, useEffect, useMemo, useSyncExternalStore } from "react";
import type { EconomyController } from "./use-economy";
import { createGardenCollectionController, economyGardenCrop } from "./garden-collection";

export function useGardenCollectionController(economy: EconomyController, owner: string | null, sceneAvailable: boolean) {
  const controller = useMemo(() => createGardenCollectionController(owner), [owner]);
  const view = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  const crop = useMemo(() => economyGardenCrop(economy.snapshot, view.jobId), [economy.snapshot, view.jobId]);
  useEffect(() => () => controller.deactivate(), [controller]);
  useEffect(() => {
    const update = () => controller.update({ snapshot: economy.snapshot, now: economy.now, busy: economy.busy,
      uncertain: economy.uncertain, retryAt: economy.retryAt, error: economy.error, sceneAvailable: sceneAvailable && !document.hidden }, economy.act);
    update(); document.addEventListener("visibilitychange", update);
    return () => document.removeEventListener("visibilitychange", update);
  }, [controller, economy.snapshot, economy.now, economy.busy, economy.uncertain, economy.retryAt, economy.error, economy.act, sceneAvailable]);
  return useMemo(() => ({ ...view, crop, start: controller.start, sceneEvent: controller.sceneEvent }), [view, crop, controller]);
}

export const GardenCollectionContext = createContext<ReturnType<typeof useGardenCollectionController> | null>(null);
export const useGardenCollection = () => useContext(GardenCollectionContext);
