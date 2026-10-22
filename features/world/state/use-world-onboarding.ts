"use client";

import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";
import { transitionWorldOnboarding, type WorldOnboardingEvent, type WorldOnboardingStepId } from "@/features/world/domain/world-onboarding";
import { createWorldOnboardingStore } from "./world-onboarding-storage";

import { createOnboardingAccountSync } from "@/features/onboarding/account-sync";
import { requestOnboardingAccount } from "@/features/onboarding/account-api";
import { useOnboardingAccountSync } from "@/features/onboarding/use-account-sync";

function browserStorage() {
  try { return typeof window === "undefined" ? undefined : window.localStorage; } catch { return undefined; }
}

export function useWorldOnboarding(owner: string) {
  const store = useMemo(() => createWorldOnboardingStore(owner, browserStorage()), [owner]);
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getServerSnapshot);
  const account = useMemo(() => createOnboardingAccountSync({ owner, course: "world", local: store,
    storage: browserStorage(), request: requestOnboardingAccount, adopt: status => store.save({ version: 2, status }) }), [owner, store]);
  const accountReady = useOnboardingAccountSync(account);
  const isPaused = state.paused;
  useEffect(() => {
    store.restore();
    const restore = (event: StorageEvent) => { if (event.key === store.storageKey || event.key === store.pauseStorageKey || event.key === null) store.restore(); };
    window.addEventListener("storage", restore);
    return () => window.removeEventListener("storage", restore);
  }, [store]);
  const apply = useCallback((event: WorldOnboardingEvent) => {
    // Read the latest store value: an observed crop and a step change can share a render.
    const progress = transitionWorldOnboarding(store.getSnapshot().progress, event);
    if (progress) store.save(progress);
  }, [store]);
  return useMemo(() => ({
    progress: state.progress,
    loaded: state.loaded && accountReady,
    isPaused,
    open: state.loaded && accountReady && !isPaused && (state.progress === null || state.progress.status === "started"),
    start: () => { apply({ type: "start" }); store.setPaused(false); },
    step: (stepId: WorldOnboardingStepId, completeCurrent = false) => apply({ type: "step", stepId, completeCurrent }),
    setCrop: (jobId: string | undefined) => apply({ type: "crop", jobId }),
    confirmHarvest: (jobId: string) => apply({ type: "harvest", jobId }),
    skip: () => apply({ type: "skip", now: Date.now() }),
    complete: () => apply({ type: "complete", now: Date.now() }),
    acknowledgeReward: () => apply({ type: "reward-acknowledged" }),
    pause: () => store.setPaused(true),
    resume: () => store.setPaused(false),
    replay: () => { account.replay(); apply({ type: "replay" }); store.setPaused(false); },
  }), [state.progress, state.loaded, accountReady, isPaused, apply, store, account]);
}
