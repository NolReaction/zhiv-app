"use client";

import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";
import type { EarthAtlasEntry } from "./earth-atlas";
import { createEarthAtlasDiscoveryFeedback } from "./earth-atlas-discovery-feedback";

export function useEarthAtlasDiscovery(owner: string | null, visible: boolean) {
  const feedback = useMemo(() => createEarthAtlasDiscoveryFeedback(owner), [owner]);
  const snapshot = useSyncExternalStore(feedback.subscribe, feedback.getSnapshot, feedback.getServerSnapshot);
  useEffect(() => {
    if (!visible) return;
    let deactivate: (() => void) | undefined;
    const update = () => {
      deactivate?.();
      deactivate = document.hidden ? undefined : feedback.activate();
    };
    update();
    document.addEventListener("visibilitychange", update);
    return () => { document.removeEventListener("visibilitychange", update); deactivate?.(); };
  }, [feedback, visible]);
  const show = useCallback((entry: EarthAtlasEntry, openedCount: number) => {
    if (!visible || typeof document === "undefined" || document.hidden) return false;
    return feedback.show(entry, openedCount);
  }, [feedback, visible]);
  return { discovery: visible ? snapshot : null, show, clear: feedback.clear };
}
