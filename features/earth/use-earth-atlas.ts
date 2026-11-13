"use client";

import { deviceSettingsStorage } from "@/lib/client-persistence";

import { useEffect, useMemo, useSyncExternalStore } from "react";
import { createEarthAtlasStore } from "./earth-atlas-storage";

function browserStorage() {
  return deviceSettingsStorage();
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
  return { snapshot, readSnapshot: store.getSnapshot, discover: store.discover, reset: store.reset };
}
