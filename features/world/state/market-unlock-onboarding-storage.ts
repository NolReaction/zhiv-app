import { gameplayStorageKey } from "@/lib/gameplay-generation";
import { parseMarketUnlockOnboarding, type MarketUnlockOnboardingProgress } from "@/features/world/domain/market-unlock-onboarding";

type GuideStorage = Pick<Storage, "getItem" | "setItem">;
type Snapshot = { loaded: boolean; progress: MarketUnlockOnboardingProgress | null };
const serverSnapshot: Snapshot = { loaded: false, progress: null };
const memory = new Map<string, MarketUnlockOnboardingProgress>();
export const marketUnlockOnboardingStorageKey = (owner: string) => gameplayStorageKey(`zhiv.market-unlock-onboarding.v1:${encodeURIComponent(owner)}`);

/** Per-player browser presentation only. No bridge claims, inventory or market commands. */
export function createMarketUnlockOnboardingStore(owner: string, storage?: GuideStorage) {
  const storageKey = marketUnlockOnboardingStorageKey(owner);
  let snapshot = serverSnapshot;
  const listeners = new Set<() => void>();
  const update = (progress: MarketUnlockOnboardingProgress | null) => {
    if (snapshot.loaded && snapshot.progress?.status === progress?.status) return;
    snapshot = { loaded: true, progress };
    for (const listener of listeners) listener();
  };
  return {
    storageKey,
    getSnapshot: () => snapshot,
    getServerSnapshot: () => serverSnapshot,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    restore() {
      let progress = memory.get(storageKey) ?? null;
      if (!progress && storage) {
        try { progress = parseMarketUnlockOnboarding(storage.getItem(storageKey)); } catch { /* Session memory still works. */ }
      }
      update(progress);
    },
    finish(status: MarketUnlockOnboardingProgress["status"]) {
      const progress: MarketUnlockOnboardingProgress = { version: 1, status };
      try {
        if (!storage) throw new Error("Storage unavailable");
        storage.setItem(storageKey, JSON.stringify(progress));
        memory.delete(storageKey);
      } catch { memory.set(storageKey, progress); }
      update(progress);
    },
  };
}
