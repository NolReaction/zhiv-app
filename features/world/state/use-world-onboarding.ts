"use client";

import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import type { WorldOnboardingStepId } from "@/features/world/domain/world-onboarding";
import { createWorldOnboardingStore } from "./world-onboarding-storage";

function browserStorage() {
  try { return typeof window === "undefined" ? undefined : window.localStorage; } catch { return undefined; }
}

export function useWorldOnboarding(owner: string) {
  const store = useMemo(() => createWorldOnboardingStore(owner, browserStorage()), [owner]);
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getServerSnapshot);
  const [paused, setPaused] = useState(false);
  useEffect(() => {
    store.restore();
    const restore = (event: StorageEvent) => { if (event.key === store.storageKey || event.key === null) store.restore(); };
    window.addEventListener("storage", restore);
    return () => window.removeEventListener("storage", restore);
  }, [store]);
  const step = (stepId: WorldOnboardingStepId) => store.save({ version: 1, status: "started", stepId });
  return {
    progress: state.progress,
    open: state.loaded && !paused && (state.progress === null || state.progress.status === "started"),
    start: () => step("clearing"),
    step,
    skip: () => store.save({ version: 1, status: "skipped" }),
    complete: () => store.save({ version: 1, status: "completed" }),
    pause: () => setPaused(true),
    replay: () => { step("clearing"); setPaused(false); },
  };
}
