"use client";

import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";
import { marketUnlockOnboardingCanOpen, type MarketUnlockOnboardingCourse } from "@/features/world/domain/market-unlock-onboarding";
import { createMarketUnlockOnboardingStore } from "./market-unlock-onboarding-storage";

function browserStorage() {
  try { return typeof window === "undefined" ? undefined : window.localStorage; } catch { return undefined; }
}

/** Discovery persists independently; completing it never restarts a finished initial course. */
export function useMarketUnlockOnboarding(owner: string, { unlocked, enabled, onboarding }: {
  unlocked: boolean;
  enabled: boolean;
  onboarding: MarketUnlockOnboardingCourse;
}) {
  const store = useMemo(() => createMarketUnlockOnboardingStore(owner, browserStorage()), [owner]);
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getServerSnapshot);
  useEffect(() => {
    store.restore();
    const restore = (event: StorageEvent) => { if (event.key === store.storageKey || event.key === null) store.restore(); };
    window.addEventListener("storage", restore);
    return () => window.removeEventListener("storage", restore);
  }, [store]);
  const complete = useCallback(() => store.finish("completed"), [store]);
  const dismiss = useCallback(() => store.finish("dismissed"), [store]);
  return {
    loaded: state.loaded,
    open: marketUnlockOnboardingCanOpen({ ...state, unlocked, enabled, onboarding }),
    complete,
    dismiss,
  };
}
