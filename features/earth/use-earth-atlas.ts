"use client";

import { useEffect, useMemo, useSyncExternalStore } from "react";
import { createEarthAtlasStore } from "./earth-atlas-storage";

function browserStorage() {
  try { return typeof window === "undefined" ? undefined : window.localStorage; } catch { return undefined; }
}

export function useEarthAtlas(owner: string | null) {
  const store = useMemo(() => createEarthAtlasStore(owner, browserStorage), [owner]);
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getServerSnapshot);
  useEffect(() => {
    const deactivate = store.activate();
    const changed = (event: StorageEvent) => { if (event.key === store.storageKey || event.key === null) store.restore(true); };
    window.addEventListener("storage", changed);
    return () => { deactivate(); window.removeEventListener("storage", changed); };
  }, [store]);
  return { snapshot, discover: store.discover, reset: store.reset };
}
