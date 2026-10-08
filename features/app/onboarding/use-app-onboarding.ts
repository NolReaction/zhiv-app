"use client";

import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { advanceAppOnboarding, observeAppOnboarding, previousAppOnboarding, startAppOnboarding,
  type AppOnboardingEvidence } from "./app-onboarding-model";
import { createAppOnboardingStore } from "./app-onboarding-storage";

function browserStorage() {
  try { return typeof window === "undefined" ? undefined : window.localStorage; } catch { return undefined; }
}

export function useAppOnboarding(owner: string, ready: boolean, evidence: AppOnboardingEvidence) {
  const store = useMemo(() => createAppOnboardingStore(owner, browserStorage()), [owner]);
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getServerSnapshot);
  const [paused, setPaused] = useState(false);
  useEffect(() => {
    store.restore();
    const restore = (event: StorageEvent) => { if (event.key === store.storageKey || event.key === null) store.restore(); };
    window.addEventListener("storage", restore);
    return () => window.removeEventListener("storage", restore);
  }, [store]);
  const { activeView, lastCheckInAt, nextAllowedAt, nowMs, unconfirmed, isSending, calendarOpen, worldOpen } = evidence;
  useEffect(() => {
    if (!ready || paused || !state.loaded) return;
    const next = observeAppOnboarding(state.progress,
      { activeView, lastCheckInAt, nextAllowedAt, nowMs, unconfirmed, isSending, calendarOpen, worldOpen });
    if (next !== state.progress) store.save(next);
  }, [store, state.loaded, state.progress, ready, paused, activeView, lastCheckInAt, nextAllowedAt, nowMs,
    unconfirmed, isSending, calendarOpen, worldOpen]);
  const running = state.loaded && (state.progress === null || state.progress.status === "started");
  return {
    progress: state.progress,
    open: running && !paused,
    paused: running && paused,
    start: () => { store.save(startAppOnboarding(lastCheckInAt)); setPaused(false); },
    next: () => store.save(advanceAppOnboarding(state.progress)),
    back: () => store.save(previousAppOnboarding(state.progress)),
    skip: () => store.save({ version: 2, status: "skipped" }),
    pause: () => setPaused(true),
    resume: () => setPaused(false),
    replay: () => { store.save(null); setPaused(false); },
  };
}
