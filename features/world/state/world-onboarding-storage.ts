import { parseWorldOnboarding, type WorldOnboardingProgress } from "@/features/world/domain/world-onboarding";

type OnboardingStorage = Pick<Storage, "getItem" | "setItem">;
const memory = new Map<string, WorldOnboardingProgress>();
const pausedMemory = new Map<string, boolean>();
// Keep the original key so v1 skips/completions remain deliberate choices after an update.
export const onboardingStorageKey = (owner: string) => `zhiv.world-onboarding.v1:${owner}`;
export const onboardingPauseStorageKey = (owner: string) => `zhiv.world-onboarding.paused.v1:${encodeURIComponent(owner)}`;

export function readWorldOnboarding(owner: string, storage: Pick<Storage, "getItem">): WorldOnboardingProgress | null {
  try { return parseWorldOnboarding(storage.getItem(onboardingStorageKey(owner))); } catch { return null; }
}
export function writeWorldOnboarding(owner: string, progress: WorldOnboardingProgress, storage: Pick<Storage, "setItem">): boolean {
  try { storage.setItem(onboardingStorageKey(owner), JSON.stringify(progress)); return true; } catch { return false; }
}

type Snapshot = { loaded: boolean; progress: WorldOnboardingProgress | null; paused: boolean };
const serverSnapshot: Snapshot = { loaded: false, progress: null, paused: false };

/** Browser preference only: no API commands, economy changes or credentials. */
export function createWorldOnboardingStore(owner: string, storage?: OnboardingStorage) {
  let snapshot = serverSnapshot;
  const pauseStorageKey = onboardingPauseStorageKey(owner);
  const listeners = new Set<() => void>();
  const update = (progress: WorldOnboardingProgress | null, paused = snapshot.paused) => {
    if (snapshot.loaded && snapshot.paused === paused && JSON.stringify(snapshot.progress) === JSON.stringify(progress)) return;
    snapshot = { loaded: true, progress, paused };
    for (const listener of listeners) listener();
  };
  return {
    storageKey: onboardingStorageKey(owner),
    pauseStorageKey,
    getSnapshot: () => snapshot,
    getServerSnapshot: () => serverSnapshot,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    restore() {
      let paused = pausedMemory.get(owner) ?? false;
      if (!pausedMemory.has(owner)) {
        try { paused = storage?.getItem(pauseStorageKey) === "true"; } catch { /* Use session memory if storage is blocked. */ }
      }
      update(memory.get(owner) ?? (storage ? readWorldOnboarding(owner, storage) : null), paused);
    },
    save(progress: WorldOnboardingProgress) {
      if (storage && writeWorldOnboarding(owner, progress, storage)) memory.delete(owner);
      else memory.set(owner, progress);
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
