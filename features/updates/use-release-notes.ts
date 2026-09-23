"use client";

import { useMemo, useSyncExternalStore } from "react";
import { browserReleaseNotesEnvironment, createReleaseNotesStore } from "./release-notes-store";

export function useReleaseNotes(ownerPublicId: string) {
  const store = useMemo(() => createReleaseNotesStore(ownerPublicId, browserReleaseNotesEnvironment()), [ownerPublicId]);
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getServerSnapshot);
  return { ...snapshot, refresh: store.refresh, markRead: store.markRead };
}
