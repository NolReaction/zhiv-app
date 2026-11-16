import { getClientPlatform } from "@/lib/client-platform";
import { clientJournalStorage, isStoragePromise, type ClientJournalStorage } from "@/lib/client-journal-storage";
import { createDurableEarthLocationPreferenceStore } from "./durable-location-preferences";
type PreferenceStorage = Pick<Storage, "getItem" | "setItem">;
export type EarthLocationPreference = Readonly<{ enabled: boolean; automaticStartAllowed: boolean }>;
export type EarthLocationPreferencePersistence = Readonly<{ pending: boolean; error: string | null }>;
export type EarthLocationPreferenceStore = {
  storageKey: string;
  getSnapshot(): EarthLocationPreference;
  getServerSnapshot(): EarthLocationPreference;
  getPersistenceSnapshot(): EarthLocationPreferencePersistence;
  getServerPersistenceSnapshot(): EarthLocationPreferencePersistence;
  subscribe(listener: () => void): () => void;
  setEnabled(enabled: boolean): void | Promise<boolean>;
  allowAutomaticStart(): boolean | Promise<boolean>;
  suppressAutomaticStart(): void | Promise<boolean>;
  isStartAllowed(): boolean;
  dispose?(): void;
};

const ACTIVE: EarthLocationPreference = { enabled: true, automaticStartAllowed: true };
const READY: EarthLocationPreference = { enabled: true, automaticStartAllowed: false };
const OFF: EarthLocationPreference = { enabled: false, automaticStartAllowed: false };
const PERSISTED: EarthLocationPreferencePersistence = { pending: false, error: null };
export const earthLocationPreferenceKey = (owner: string) => `zhiv.earth-location.v1:${encodeURIComponent(owner)}`;

function browserStorage(): PreferenceStorage | undefined {
  try { return typeof window === "undefined" ? undefined : window.localStorage; } catch { return undefined; }
}

function browserStorageChanges(key: string, listener: () => void) {
  if (typeof window === "undefined") return () => {};
  const changed = (event: StorageEvent) => { if (event.key === key || event.key === null) listener(); };
  window.addEventListener("storage", changed);
  return () => window.removeEventListener("storage", changed);
}

/** A device preference only: it never contains a fix or grants friend sharing. */
export function createEarthLocationPreferenceStore(
  owner: string | null,
  getStorage: () => PreferenceStorage | undefined = browserStorage,
  onStorageChange: (key: string, listener: () => void) => () => void = browserStorageChanges,
): EarthLocationPreferenceStore {
  const key = earthLocationPreferenceKey(owner ?? "");
  const listeners = new Set<() => void>();
  let fallback: EarthLocationPreference | undefined;
  // An unreadable persisted OFF must not become an automatic native request.
  // A successful missing-key read still selects the normal ACTIVE default.
  let lastKnown = owner ? READY : OFF;
  let removeStorageListener: (() => void) | undefined;
  const read = (): EarthLocationPreference => {
    if (!owner) return OFF;
    if (fallback) return fallback;
    try {
      const storage = getStorage();
      if (!storage) return lastKnown;
      const value = storage.getItem(key);
      lastKnown = value === "ready" ? READY : value === "active" ? ACTIVE : value === null ? getClientPlatform() ? READY : ACTIVE : OFF;
      return lastKnown;
    } catch { return lastKnown; }
  };
  const notify = () => { for (const listener of listeners) listener(); };
  const write = (next: EarthLocationPreference) => {
    if (!owner) return;
    lastKnown = next;
    try {
      const storage = getStorage();
      if (!storage) throw new Error("Storage unavailable");
      storage.setItem(key, next === OFF ? "off" : next === READY ? "ready" : "active");
      fallback = undefined;
    } catch { fallback = next; }
    notify();
  };
  return {
    storageKey: key,
    getSnapshot: read,
    getServerSnapshot: () => owner ? ACTIVE : OFF,
    getPersistenceSnapshot: () => PERSISTED,
    getServerPersistenceSnapshot: () => PERSISTED,
    subscribe(listener: () => void) {
      listeners.add(listener);
      if (listeners.size === 1 && owner) removeStorageListener = onStorageChange(key, () => {
        fallback = undefined;
        notify();
      });
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) { removeStorageListener?.(); removeStorageListener = undefined; }
      };
    },
    setEnabled(enabled: boolean) {
      if (read().enabled === enabled) return;
      // Re-enabling makes the API available but cannot restart a prior watch.
      // Only the next deliberate lookup enables future automatic private GPS.
      write(enabled ? READY : OFF);
    },
    allowAutomaticStart() {
      if (!read().enabled) return false;
      if (read() !== ACTIVE) write(ACTIVE);
      return true;
    },
    suppressAutomaticStart() {
      const current = read();
      if (current.enabled && current.automaticStartAllowed) write(READY);
    },
    isStartAllowed() { return read().enabled && read().automaticStartAllowed; },
  };
}

const browserStores = new Map<string | null, ReturnType<typeof createEarthLocationPreferenceStore>>();
const durableStores = new Map<string, { storage: ClientJournalStorage; store: EarthLocationPreferenceStore }>();
export function getEarthLocationPreferenceStore(owner: string | null) {
  const storage = owner ? clientJournalStorage(owner) : undefined;
  if (owner && storage) {
    const current = durableStores.get(owner);
    if (current?.storage === storage) return current.store;
    current?.store.dispose?.();
    let legacy: Pick<Storage, "getItem" | "removeItem"> | undefined;
    try { legacy = typeof window === "undefined" ? undefined : window.localStorage; } catch { /* Native storage remains authoritative. */ }
    const store = createDurableEarthLocationPreferenceStore(earthLocationPreferenceKey(owner), storage, legacy);
    durableStores.set(owner, { storage, store });
    return store;
  }
  if (owner && getClientPlatform()) throw new Error("Хранилище геопозиции ещё не готово. Перезапустите приложение.");
  let store = browserStores.get(owner);
  if (!store) { store = createEarthLocationPreferenceStore(owner); browserStores.set(owner, store); }
  return store;
}

/** Web retains its synchronous user gesture; native lookup waits for durable consent. */
export function withEarthLocationPreference<T>(store: EarthLocationPreferenceStore, action: () => T): T | false | Promise<T | false> {
  const granted = store.allowAutomaticStart();
  const run = (allowed: boolean) => allowed && store.isStartAllowed() ? action() : false;
  return isStoragePromise(granted) ? granted.then(run) : run(granted);
}
