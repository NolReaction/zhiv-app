"use client";

import { useCallback, useSyncExternalStore } from "react";
import { readTapHintPreference, saveTapHintPreference, tapHintPreferenceKey } from "./tap-hint-preferences";

const CHANGE_EVENT = "zhiv:world-tap-hints-changed";
const serverSnapshot = () => true;
function browserStorage() {
  try { return typeof window === "undefined" ? undefined : window.localStorage; } catch { return undefined; }
}

export function useTapHintPreference(owner: string) {
  const read = useCallback(() => readTapHintPreference(owner, browserStorage()), [owner]);
  const subscribe = useCallback((listener: () => void) => {
    const storageKey = tapHintPreferenceKey(owner);
    const restore = (event: StorageEvent) => { if (event.key === storageKey || event.key === null) listener(); };
    window.addEventListener("storage", restore);
    window.addEventListener(CHANGE_EVENT, listener);
    return () => { window.removeEventListener("storage", restore); window.removeEventListener(CHANGE_EVENT, listener); };
  }, [owner]);
  const showTapHints = useSyncExternalStore(subscribe, read, serverSnapshot);
  const setShowTapHints = useCallback((visible: boolean) => {
    saveTapHintPreference(owner, visible, browserStorage());
    window.dispatchEvent(new Event(CHANGE_EVENT));
  }, [owner]);
  return { showTapHints, setShowTapHints };
}
