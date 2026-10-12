"use client";

import { useCallback, useSyncExternalStore } from "react";
import { readSectionGuideLauncherPreference, saveSectionGuideLauncherPreference, sectionGuideLauncherPreferenceKey } from "./section-guide-preferences";

const CHANGE_EVENT = "zhiv:section-guide-preferences-changed";
const serverSnapshot = () => true;
function browserStorage() {
  try { return typeof window === "undefined" ? undefined : window.localStorage; } catch { return undefined; }
}

export function useSectionGuideLauncherPreference(owner: string) {
  const read = useCallback(() => readSectionGuideLauncherPreference(owner, browserStorage()), [owner]);
  const subscribe = useCallback((listener: () => void) => {
    const storageKey = sectionGuideLauncherPreferenceKey(owner);
    const restore = (event: StorageEvent) => { if (event.key === storageKey || event.key === null) listener(); };
    window.addEventListener("storage", restore);
    window.addEventListener(CHANGE_EVENT, listener);
    return () => { window.removeEventListener("storage", restore); window.removeEventListener(CHANGE_EVENT, listener); };
  }, [owner]);
  const showSectionGuideLauncher = useSyncExternalStore(subscribe, read, serverSnapshot);
  const setShowSectionGuideLauncher = useCallback((visible: boolean) => {
    saveSectionGuideLauncherPreference(owner, visible, browserStorage());
    window.dispatchEvent(new Event(CHANGE_EVENT));
  }, [owner]);
  return { showSectionGuideLauncher, setShowSectionGuideLauncher };
}
