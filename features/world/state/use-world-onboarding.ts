"use client";

import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { transitionWorldOnboarding, type WorldOnboardingEvent, type WorldOnboardingStepId } from "@/features/world/domain/world-onboarding";
import { createWorldOnboardingStore } from "./world-onboarding-storage";

function browserStorage() {
  try { return typeof window === "undefined" ? undefined : window.localStorage; } catch { return undefined; }
}

export function useWorldOnboarding(owner: string) {
  const store = useMemo(() => createWorldOnboardingStore(owner, browserStorage()), [owner]);
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getServerSnapshot);
  const [pausedOwner, setPausedOwner] = useState<string | null>(null);
  const isPaused = pausedOwner === owner;
  useEffect(() => {
    store.restore();
    const restore = (event: StorageEvent) => { if (event.key === store.storageKey || event.key === null) store.restore(); };
    window.addEventListener("storage", restore);
    return () => window.removeEventListener("storage", restore);
  }, [store]);
  const apply = (event: WorldOnboardingEvent) => {
    // Read the latest store value: an observed crop and a step change can share a render.
    const progress = transitionWorldOnboarding(store.getSnapshot().progress, event);
    if (progress) store.save(progress);
  };
  return {
    progress: state.progress,
    loaded: state.loaded,
    isPaused,
    open: state.loaded && !isPaused && (state.progress === null || state.progress.status === "started"),
    start: () => apply({ type: "start" }),
    step: (stepId: WorldOnboardingStepId) => apply({ type: "step", stepId }),
    setCrop: (jobId: string | undefined) => apply({ type: "crop", jobId }),
    skip: () => apply({ type: "skip" }),
    complete: () => apply({ type: "complete" }),
    pause: () => setPausedOwner(owner),
    resume: () => setPausedOwner(null),
    replay: () => { apply({ type: "replay" }); setPausedOwner(null); },
  };
}
