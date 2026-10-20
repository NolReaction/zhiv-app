"use client";

import { useMemo, useSyncExternalStore } from "react";
import { getEarthLocationPreferenceStore } from "./location-preferences";

export function useEarthLocationPreference(ownerPublicId: string | null) {
  const store = useMemo(() => getEarthLocationPreferenceStore(ownerPublicId), [ownerPublicId]);
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getServerSnapshot);
  return { enabled: state.enabled, setEnabled: store.setEnabled };
}
