"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { marketUnlockOnboardingCanOpen, type MarketUnlockOnboardingCourse } from "@/features/world/domain/market-unlock-onboarding";
import { createMarketUnlockOnboardingStore } from "./market-unlock-onboarding-storage";

function browserStorage() {
  try { return typeof window === "undefined" ? undefined : window.localStorage; } catch { return undefined; }
}

/** Discovery persists independently; completing it never restarts a finished initial course. */
export function useMarketUnlockOnboarding(owner: string, { unlocked, confirmed, enabled, onboarding }: {
  unlocked: boolean;
  confirmed: boolean;
  enabled: boolean;
  onboarding: MarketUnlockOnboardingCourse;
}) {
  const store = useMemo(() => createMarketUnlockOnboardingStore(owner, browserStorage()), [owner]);
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getServerSnapshot);
  const current = useRef({ store, confirmed, unlocked });
  useLayoutEffect(() => { current.current = { store, confirmed, unlocked }; }, [store, confirmed, unlocked]);
  useEffect(() => {
    store.restore();
    const restore = (event: StorageEvent) => { if (event.key === store.storageKey || event.key === null) store.restore(); };
    window.addEventListener("storage", restore);
    return () => window.removeEventListener("storage", restore);
  }, [store]);
  useEffect(() => {
    if (confirmed && state.loaded && !state.prepared) store.prepare(unlocked);
  }, [store, state.loaded, state.prepared, confirmed, unlocked]);
  const finish = useCallback((status: "completed" | "dismissed") => {
    if (current.current.store === store && current.current.confirmed && current.current.unlocked && store.getSnapshot().prepared) store.finish(status);
  }, [store]);
  const complete = useCallback(() => finish("completed"), [finish]);
  const dismiss = useCallback(() => finish("dismissed"), [finish]);
  return {
    loaded: state.loaded && state.prepared,
    open: marketUnlockOnboardingCanOpen({ ...state, unlocked: confirmed && unlocked, enabled, onboarding }),
    complete,
    dismiss,
  };
}
