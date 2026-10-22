"use client";

import { useEffect, useMemo, useSyncExternalStore } from "react";
import { advanceAppOnboarding, observeAppOnboarding, previousAppOnboarding, startAppOnboarding,
  type AppOnboardingEvidence } from "./app-onboarding-model";
import { createAppOnboardingStore } from "./app-onboarding-storage";

import { createOnboardingAccountSync } from "@/features/onboarding/account-sync";
import { requestOnboardingAccount } from "@/features/onboarding/account-api";
import { useOnboardingAccountSync } from "@/features/onboarding/use-account-sync";

function browserStorage() {
  try { return typeof window === "undefined" ? undefined : window.localStorage; } catch { return undefined; }
}

export function useAppOnboarding(owner: string, ready: boolean, evidence: AppOnboardingEvidence) {
  const store = useMemo(() => createAppOnboardingStore(owner, browserStorage()), [owner]);
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getServerSnapshot);
  const account = useMemo(() => createOnboardingAccountSync({ owner, course: "app", local: store,
    storage: browserStorage(), request: requestOnboardingAccount, adopt: status => store.save({ version: 2, status }) }), [owner, store]);
  const accountReady = useOnboardingAccountSync(account);
  const { paused } = state;
  useEffect(() => {
    store.restore();
    const restore = (event: StorageEvent) => { if (event.key === store.storageKey || event.key === store.pauseStorageKey
      || event.key === store.notificationStorageKey || event.key === null) store.restore(); };
    window.addEventListener("storage", restore);
    return () => window.removeEventListener("storage", restore);
  }, [store]);
  const { activeView, lastCheckInAt, nextAllowedAt, nowMs, unconfirmed, isSending, calendarOpen, worldOpen } = evidence;
  useEffect(() => {
    const current = store.getSnapshot();
    if (!ready || !accountReady || current.paused || !current.loaded) return;
    const next = observeAppOnboarding(current.progress,
      { activeView, lastCheckInAt, nextAllowedAt, nowMs, unconfirmed, isSending, calendarOpen, worldOpen });
    if (next !== current.progress) store.save(next);
  }, [store, state.loaded, state.progress, ready, accountReady, paused, activeView, lastCheckInAt, nextAllowedAt, nowMs,
    unconfirmed, isSending, calendarOpen, worldOpen]);
  const running = state.loaded && accountReady && (state.progress === null || state.progress.status === "started");
  return {
    progress: state.progress,
    open: running && !paused,
    paused: running && paused,
    notificationOffer: state.loaded && state.progress === null && !state.notificationOfferSeen,
    acknowledgeNotifications: store.acknowledgeNotifications,
    start: () => { store.save(startAppOnboarding(lastCheckInAt)); store.setPaused(false); },
    next: () => store.save(advanceAppOnboarding(store.getSnapshot().progress)),
    back: () => store.save(previousAppOnboarding(store.getSnapshot().progress)),
    skip: () => store.save({ version: 2, status: "skipped" }),
    pause: () => store.setPaused(true),
    resume: () => store.setPaused(false),
    replay: () => { account.replay(); store.save(null); store.setPaused(false); },
  };
}
