import { gameplayStorageKey } from "@/lib/gameplay-generation";
type PreferenceStorage = Pick<Storage, "getItem" | "setItem">;
const memory = new Map<string, boolean>();

export const tapHintPreferenceKey = (owner: string) => gameplayStorageKey(`zhiv.world.tap-hints.v1:${encodeURIComponent(owner)}`);

/** This appearance preference never changes object hit areas or lesson progress. */
export function readTapHintPreference(owner: string, storage?: PreferenceStorage): boolean {
  const key = tapHintPreferenceKey(owner);
  const fallback = memory.get(key);
  if (fallback !== undefined) return fallback;
  try { return storage?.getItem(key) !== "false"; } catch { return true; }
}

export function saveTapHintPreference(owner: string, visible: boolean, storage?: PreferenceStorage): void {
  const key = tapHintPreferenceKey(owner);
  try {
    if (!storage) throw new Error("Storage unavailable");
    storage.setItem(key, String(visible));
    memory.delete(key);
  } catch { memory.set(key, visible); }
}
