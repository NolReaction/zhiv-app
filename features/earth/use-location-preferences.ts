"use client";

import { useMemo, useSyncExternalStore } from "react";
import { getEarthLocationPreferenceStore } from "./location-preferences";

export function useEarthLocationPreference(ownerPublicId: string | null) {
  const store = useMemo(() => getEarthLocationPreferenceStore(ownerPublicId), [ownerPublicId]);
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getServerSnapshot);
  const persistence = useSyncExternalStore(store.subscribe, store.getPersistenceSnapshot, store.getServerPersistenceSnapshot);
  return { enabled: state.enabled, setEnabled: store.setEnabled, persistence };
}
