"use client";

import { useEffect, useMemo, useSyncExternalStore } from "react";
import { advanceAppOnboarding, observeAppOnboarding, previousAppOnboarding, startAppOnboarding,
  type AppOnboardingEvidence } from "./app-onboarding-model";
import { createAppOnboardingStore } from "./app-onboarding-storage";

function browserStorage() {
  try { return typeof window === "undefined" ? undefined : window.localStorage; } catch { return undefined; }
}

export function useAppOnboarding(owner: string, ready: boolean, evidence: AppOnboardingEvidence) {
  const store = useMemo(() => createAppOnboardingStore(owner, browserStorage()), [owner]);
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getServerSnapshot);
  const { paused } = state;
  useEffect(() => {
    store.restore();
    const restore = (event: StorageEvent) => { if (event.key === store.storageKey || event.key === store.pauseStorageKey || event.key === null) store.restore(); };
    window.addEventListener("storage", restore);
    return () => window.removeEventListener("storage", restore);
  }, [store]);
  const { activeView, lastCheckInAt, nextAllowedAt, nowMs, unconfirmed, isSending, calendarOpen, worldOpen } = evidence;
  useEffect(() => {
    const current = store.getSnapshot();
    if (!ready || current.paused || !current.loaded) return;
    const next = observeAppOnboarding(current.progress,
      { activeView, lastCheckInAt, nextAllowedAt, nowMs, unconfirmed, isSending, calendarOpen, worldOpen });
    if (next !== current.progress) store.save(next);
  }, [store, state.loaded, state.progress, ready, paused, activeView, lastCheckInAt, nextAllowedAt, nowMs,
    unconfirmed, isSending, calendarOpen, worldOpen]);
  const running = state.loaded && (state.progress === null || state.progress.status === "started");
  return {
    progress: state.progress,
    open: running && !paused,
    paused: running && paused,
    start: () => { store.save(startAppOnboarding(lastCheckInAt)); store.setPaused(false); },
    next: () => store.save(advanceAppOnboarding(store.getSnapshot().progress)),
    back: () => store.save(previousAppOnboarding(store.getSnapshot().progress)),
    skip: () => store.save({ version: 2, status: "skipped" }),
    pause: () => store.setPaused(true),
    resume: () => store.setPaused(false),
    replay: () => { store.save(null); store.setPaused(false); },
  };
}
