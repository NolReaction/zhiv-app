"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { leaftailArrivalCanStart } from "@/features/world/domain/leaftail-arrival-onboarding";
import type { MarketUnlockOnboardingCourse } from "@/features/world/domain/market-unlock-onboarding";
import { createLeaftailArrivalStore } from "./leaftail-arrival-storage";

function browserStorage() {
  try { return typeof window === "undefined" ? undefined : window.localStorage; } catch { return undefined; }
}

export function useLeaftailArrival(owner: string, options: { unlocked: boolean; enabled: boolean; onboarding: MarketUnlockOnboardingCourse }) {
  const store = useMemo(() => createLeaftailArrivalStore(owner, browserStorage()), [owner]);
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getServerSnapshot);
  const allowed = leaftailArrivalCanStart({ loaded: state.loaded, ...options });
  const current = useRef({ store, allowed });
  useLayoutEffect(() => { current.current = { store, allowed }; }, [store, allowed]);
  useEffect(() => {
    store.restore();
    const restore = (event: StorageEvent) => { if (event.key === store.storageKey || event.key === null) store.restore(); };
    window.addEventListener("storage", restore);
    return () => window.removeEventListener("storage", restore);
  }, [store]);
  const complete = useCallback(() => { if (current.current.store === store) store.complete(); }, [store]);
  const dismiss = useCallback(() => { if (current.current.store === store && current.current.allowed) store.dismiss(); }, [store]);
  const seen = Boolean(state.progress?.arrived);
  return { loaded: state.loaded, seen, enabled: allowed && !seen,
    open: allowed && !state.progress?.dismissed, complete, dismiss };
}
