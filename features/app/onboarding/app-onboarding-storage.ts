import { parseAppOnboarding, type AppOnboardingProgress } from "./app-onboarding-model";

type AppOnboardingStorage = Pick<Storage, "getItem" | "setItem">;
type Snapshot = { loaded: boolean; progress: AppOnboardingProgress | null };
const serverSnapshot: Snapshot = { loaded: false, progress: null };
const memory = new Map<string, AppOnboardingProgress | null>();
export const appOnboardingStorageKey = (owner: string) => `zhiv.app-onboarding.v2:${owner}`;

export function createAppOnboardingStore(owner: string, storage?: AppOnboardingStorage) {
  let snapshot = serverSnapshot;
  const listeners = new Set<() => void>();
  const update = (progress: AppOnboardingProgress | null) => {
    if (snapshot.loaded && JSON.stringify(snapshot.progress) === JSON.stringify(progress)) return;
    snapshot = { loaded: true, progress };
    for (const listener of listeners) listener();
  };
  const key = appOnboardingStorageKey(owner);
  return {
    storageKey: key,
    getSnapshot: () => snapshot,
    getServerSnapshot: () => serverSnapshot,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    restore() {
      let restored = memory.get(owner) ?? null;
      if (!memory.has(owner)) {
        try { restored = storage ? parseAppOnboarding(storage.getItem(key)) : null; } catch { /* Keep the guide available. */ }
      }
      update(restored);
    },
    save(progress: AppOnboardingProgress | null) {
      try {
        if (!storage) throw new Error("Browser storage unavailable");
        storage.setItem(key, JSON.stringify(progress));
        memory.delete(owner);
      } catch { memory.set(owner, progress); }
      update(progress);
    },
  };
}
