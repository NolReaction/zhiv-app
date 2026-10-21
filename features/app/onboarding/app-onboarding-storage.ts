import { gameplayStorageKey } from "@/lib/gameplay-generation";
import { parseAppOnboarding, type AppOnboardingProgress } from "./app-onboarding-model";

type AppOnboardingStorage = Pick<Storage, "getItem" | "setItem">;
type Snapshot = { loaded: boolean; progress: AppOnboardingProgress | null; paused: boolean };
const serverSnapshot: Snapshot = { loaded: false, progress: null, paused: false };
const memory = new Map<string, AppOnboardingProgress | null>();
const pausedMemory = new Map<string, boolean>();
export const appOnboardingStorageKey = (owner: string) => gameplayStorageKey(`zhiv.app-onboarding.v2:${owner}`);
export const appOnboardingPauseStorageKey = (owner: string) => gameplayStorageKey(`zhiv.app-onboarding.paused.v1:${encodeURIComponent(owner)}`);

export function createAppOnboardingStore(owner: string, storage?: AppOnboardingStorage) {
  let snapshot = serverSnapshot;
  const listeners = new Set<() => void>();
  const update = (progress: AppOnboardingProgress | null, paused = snapshot.paused) => {
    if (snapshot.loaded && snapshot.paused === paused && JSON.stringify(snapshot.progress) === JSON.stringify(progress)) return;
    snapshot = { loaded: true, progress, paused };
    for (const listener of listeners) listener();
  };
  const key = appOnboardingStorageKey(owner);
  const pauseStorageKey = appOnboardingPauseStorageKey(owner);
  return {
    storageKey: key,
    pauseStorageKey,
    getSnapshot: () => snapshot,
    getServerSnapshot: () => serverSnapshot,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    restore() {
      let restored = memory.get(owner) ?? null;
      if (!memory.has(owner)) {
        try { restored = storage ? parseAppOnboarding(storage.getItem(key)) : null; } catch { /* Keep the guide available. */ }
      }
      let paused = pausedMemory.get(owner) ?? false;
      if (!pausedMemory.has(owner)) {
        try { paused = storage?.getItem(pauseStorageKey) === "true"; } catch { /* Use session memory if storage is blocked. */ }
      }
      update(restored, paused);
    },
    save(progress: AppOnboardingProgress | null) {
      try {
        if (!storage) throw new Error("Browser storage unavailable");
        storage.setItem(key, JSON.stringify(progress));
        memory.delete(owner);
      } catch { memory.set(owner, progress); }
      update(progress);
    },
    setPaused(paused: boolean) {
      try {
        if (!storage) throw new Error("Browser storage unavailable");
        storage.setItem(pauseStorageKey, String(paused));
        pausedMemory.delete(owner);
      } catch { pausedMemory.set(owner, paused); }
      update(snapshot.progress, paused);
    },
  };
}
