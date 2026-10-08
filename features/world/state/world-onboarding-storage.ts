import { parseWorldOnboarding, type WorldOnboardingProgress } from "@/features/world/domain/world-onboarding";

type OnboardingStorage = Pick<Storage, "getItem" | "setItem">;
const memory = new Map<string, WorldOnboardingProgress>();
// Keep the original key so v1 skips/completions remain deliberate choices after an update.
export const onboardingStorageKey = (owner: string) => `zhiv.world-onboarding.v1:${owner}`;

export function readWorldOnboarding(owner: string, storage: Pick<Storage, "getItem">): WorldOnboardingProgress | null {
  try { return parseWorldOnboarding(storage.getItem(onboardingStorageKey(owner))); } catch { return null; }
}
export function writeWorldOnboarding(owner: string, progress: WorldOnboardingProgress, storage: Pick<Storage, "setItem">): boolean {
  try { storage.setItem(onboardingStorageKey(owner), JSON.stringify(progress)); return true; } catch { return false; }
}

type Snapshot = { loaded: boolean; progress: WorldOnboardingProgress | null };
const serverSnapshot: Snapshot = { loaded: false, progress: null };

/** Browser preference only: no API commands, economy changes or credentials. */
export function createWorldOnboardingStore(owner: string, storage?: OnboardingStorage) {
  let snapshot = serverSnapshot;
  const listeners = new Set<() => void>();
  const update = (progress: WorldOnboardingProgress | null) => {
    if (snapshot.loaded && JSON.stringify(snapshot.progress) === JSON.stringify(progress)) return;
    snapshot = { loaded: true, progress };
    for (const listener of listeners) listener();
  };
  return {
    storageKey: onboardingStorageKey(owner),
    getSnapshot: () => snapshot,
    getServerSnapshot: () => serverSnapshot,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    restore() { update(memory.get(owner) ?? (storage ? readWorldOnboarding(owner, storage) : null)); },
    save(progress: WorldOnboardingProgress) {
      if (storage && writeWorldOnboarding(owner, progress, storage)) memory.delete(owner);
      else memory.set(owner, progress);
      update(progress);
    },
  };
}
