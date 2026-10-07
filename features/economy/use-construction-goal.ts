"use client";

import { useEffect, useMemo, useSyncExternalStore } from "react";
import type { EconomyView } from "./model";
import { constructionGoalDetails, createConstructionGoalStore } from "./construction-goal";

function goalStorage() {
  try { return typeof window === "undefined" ? undefined : window.localStorage; } catch { return undefined; }
}

/** Mount once with the shared world controller; pass the result to its panels. */
export function useConstructionGoal(owner: string | null, state: EconomyView | null) {
  const store = useMemo(() => createConstructionGoalStore(owner, goalStorage()), [owner]);
  const storedGoal = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getServerSnapshot);
  const snapshot = state?.ownerPublicId === owner ? state : null;
  const details = useMemo(() => snapshot ? constructionGoalDetails(snapshot, storedGoal) : null, [snapshot, storedGoal]);
  useEffect(() => {
    store.restore();
    const restore = (event: StorageEvent) => { if (event.key === store.storageKey || event.key === null) store.restore(); };
    window.addEventListener("storage", restore);
    return () => window.removeEventListener("storage", restore);
  }, [store]);
  useEffect(() => { store.reconcile(snapshot); }, [store, snapshot, storedGoal]);
  return {
    goal: details?.goal ?? null,
    details,
    pin: (buildingId: string) => store.pin(snapshot, buildingId),
    clear: store.clear,
  };
}

export type ConstructionGoalController = ReturnType<typeof useConstructionGoal>;
