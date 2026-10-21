type PreferenceStorage = Pick<Storage, "getItem" | "setItem">;
export type EarthLocationPreference = Readonly<{ enabled: boolean; automaticStartAllowed: boolean }>;

const ACTIVE: EarthLocationPreference = { enabled: true, automaticStartAllowed: true };
const READY: EarthLocationPreference = { enabled: true, automaticStartAllowed: false };
const OFF: EarthLocationPreference = { enabled: false, automaticStartAllowed: false };
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
) {
  const key = earthLocationPreferenceKey(owner ?? "");
  const listeners = new Set<() => void>();
  let fallback: EarthLocationPreference | undefined;
  let lastKnown = owner ? ACTIVE : OFF;
  let removeStorageListener: (() => void) | undefined;
  const read = (): EarthLocationPreference => {
    if (!owner) return OFF;
    if (fallback) return fallback;
    try {
      const storage = getStorage();
      if (!storage) return lastKnown;
      const value = storage.getItem(key);
      lastKnown = value === "ready" ? READY : value === "active" || value === null ? ACTIVE : OFF;
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
      // Only the next deliberate lookup enables passive granted-permission use.
      write(enabled ? READY : OFF);
    },
    allowAutomaticStart() {
      if (!read().enabled) return false;
      if (read() !== ACTIVE) write(ACTIVE);
      return true;
    },
  };
}

const browserStores = new Map<string | null, ReturnType<typeof createEarthLocationPreferenceStore>>();
export function getEarthLocationPreferenceStore(owner: string | null) {
  let store = browserStores.get(owner);
  if (!store) { store = createEarthLocationPreferenceStore(owner); browserStores.set(owner, store); }
  return store;
}
