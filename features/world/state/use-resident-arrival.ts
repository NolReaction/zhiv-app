"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { residentArrivalCanStart } from "@/features/world/domain/resident-arrival-onboarding";
import type { MarketUnlockOnboardingCourse } from "@/features/world/domain/market-unlock-onboarding";
import { createResidentArrivalStore } from "./resident-arrival-storage";

function browserStorage() {
  try { return typeof window === "undefined" ? undefined : window.localStorage; } catch { return undefined; }
}

export function useResidentArrival(storageKey: string, options: { unlocked: boolean; enabled: boolean; onboarding: MarketUnlockOnboardingCourse }) {
  const store = useMemo(() => createResidentArrivalStore(storageKey, browserStorage()), [storageKey]);
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getServerSnapshot);
  const allowed = residentArrivalCanStart({ loaded: state.loaded, ...options });
  const current = useRef({ store, allowed, unlocked: options.unlocked });
  useLayoutEffect(() => { current.current = { store, allowed, unlocked: options.unlocked }; }, [store, allowed, options.unlocked]);
  useEffect(() => {
    store.restore();
    const restore = (event: StorageEvent) => { if (event.key === store.storageKey || event.key === null) store.restore(); };
    window.addEventListener("storage", restore);
    return () => window.removeEventListener("storage", restore);
  }, [store]);
  const complete = useCallback(() => { if (current.current.store === store && current.current.unlocked) store.complete(); }, [store]);
  const dismiss = useCallback(() => { if (current.current.store === store && current.current.allowed) store.dismiss(); }, [store]);
  const seen = Boolean(state.progress?.arrived);
  return { loaded: state.loaded, seen, enabled: allowed && !seen,
    open: allowed && !state.progress?.dismissed, complete, dismiss };
}
