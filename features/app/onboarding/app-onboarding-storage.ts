import { gameplayStorageKey } from "@/lib/gameplay-generation";
import { parseAppOnboarding, type AppOnboardingProgress } from "./app-onboarding-model";

type AppOnboardingStorage = Pick<Storage, "getItem" | "setItem">;
type Snapshot = { loaded: boolean; progress: AppOnboardingProgress | null; paused: boolean; notificationOfferSeen: boolean };
const serverSnapshot: Snapshot = { loaded: false, progress: null, paused: false, notificationOfferSeen: false };
const memory = new Map<string, AppOnboardingProgress | null>();
const pausedMemory = new Map<string, boolean>();
const notificationOfferMemory = new Map<string, boolean>();
export const appOnboardingStorageKey = (owner: string) => gameplayStorageKey(`zhiv.app-onboarding.v2:${owner}`);
export const appOnboardingPauseStorageKey = (owner: string) => gameplayStorageKey(`zhiv.app-onboarding.paused.v1:${encodeURIComponent(owner)}`);
// Notification consent is a device preference, independent of gameplay resets and tutorial replays.
export const appOnboardingNotificationStorageKey = (owner: string) => `zhiv.notifications-onboarding.v1:${encodeURIComponent(owner)}`;

export function createAppOnboardingStore(owner: string, storage?: AppOnboardingStorage) {
  let snapshot = serverSnapshot;
  const listeners = new Set<() => void>();
  const update = (progress: AppOnboardingProgress | null, paused = snapshot.paused, notificationOfferSeen = snapshot.notificationOfferSeen) => {
    if (snapshot.loaded && snapshot.paused === paused && snapshot.notificationOfferSeen === notificationOfferSeen
      && JSON.stringify(snapshot.progress) === JSON.stringify(progress)) return;
    snapshot = { loaded: true, progress, paused, notificationOfferSeen };
    for (const listener of listeners) listener();
  };
  const key = appOnboardingStorageKey(owner);
  const pauseStorageKey = appOnboardingPauseStorageKey(owner);
  const notificationStorageKey = appOnboardingNotificationStorageKey(owner);
  return {
    storageKey: key,
    pauseStorageKey,
    notificationStorageKey,
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
      let notificationOfferSeen = notificationOfferMemory.get(owner) ?? false;
      if (!notificationOfferMemory.has(owner)) {
        try { notificationOfferSeen = storage?.getItem(notificationStorageKey) === "true"; } catch { /* Use session memory if storage is blocked. */ }
      }
      update(restored, paused, notificationOfferSeen);
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
    acknowledgeNotifications() {
      try {
        if (!storage) throw new Error("Browser storage unavailable");
        storage.setItem(notificationStorageKey, "true");
        notificationOfferMemory.delete(owner);
      } catch { notificationOfferMemory.set(owner, true); }
      update(snapshot.progress, snapshot.paused, true);
    },
  };
}
