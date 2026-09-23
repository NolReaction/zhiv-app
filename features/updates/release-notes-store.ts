import { BUNDLED_RELEASE_NOTES, parseReadReleaseIds, parseReleaseFeed, releaseReadStorageKey, unreadReleaseIds, type ReleaseNote } from "./release-notes";

export const RELEASE_REFRESH_INTERVAL = 5 * 60_000;
export const RELEASE_REFRESH_THROTTLE = 30_000;
export const RELEASE_REQUEST_TIMEOUT = 10_000;

type StoreEvent = { type: "refresh" } | { type: "storage"; key: string | null; newValue: string | null };
type StorageAccess = Pick<Storage, "getItem" | "setItem">;

export type ReleaseNotesEnvironment = {
  fetch: (url: string, init: RequestInit) => Promise<Pick<Response, "ok" | "headers" | "json">>;
  storage: () => StorageAccess;
  visible: () => boolean;
  listen: (listener: (event: StoreEvent) => void) => () => void;
  now: () => number;
  setInterval: (callback: () => void, delay: number) => ReturnType<typeof setInterval>;
  clearInterval: (timer: ReturnType<typeof setInterval>) => void;
  setTimeout: (callback: () => void, delay: number) => ReturnType<typeof setTimeout>;
  clearTimeout: (timer: ReturnType<typeof setTimeout>) => void;
};

export type ReleaseNotesSnapshot = {
  releases: ReleaseNote[];
  unreadIds: string[];
  unreadCount: number;
  checking: boolean;
  refreshError: boolean;
};

// Keep acknowledgements during this session even when browser storage is blocked.
const sessionReadIds = new Map<string, Set<string>>();

export function browserReleaseNotesEnvironment(): ReleaseNotesEnvironment {
  return {
    fetch: (url, init) => fetch(url, init),
    storage: () => window.localStorage,
    visible: () => document.visibilityState !== "hidden",
    now: Date.now,
    setInterval, clearInterval, setTimeout, clearTimeout,
    listen: listener => {
      const refresh = () => listener({ type: "refresh" });
      const storage = (event: StorageEvent) => listener({ type: "storage", key: event.key, newValue: event.newValue });
      window.addEventListener("focus", refresh);
      window.addEventListener("online", refresh);
      window.addEventListener("storage", storage);
      document.addEventListener("visibilitychange", refresh);
      return () => {
        window.removeEventListener("focus", refresh);
        window.removeEventListener("online", refresh);
        window.removeEventListener("storage", storage);
        document.removeEventListener("visibilitychange", refresh);
      };
    },
  };
}

export function createReleaseNotesStore(ownerPublicId: string, environment: ReleaseNotesEnvironment,
  memory: Map<string, Set<string>> = sessionReadIds) {
  const storageKey = releaseReadStorageKey(ownerPublicId);
  let readIds = new Set<string>();
  let snapshot: ReleaseNotesSnapshot = {
    releases: BUNDLED_RELEASE_NOTES,
    unreadIds: unreadReleaseIds(BUNDLED_RELEASE_NOTES, readIds),
    unreadCount: BUNDLED_RELEASE_NOTES.length,
    checking: false,
    refreshError: false,
  };
  const serverSnapshot = snapshot;
  const listeners = new Set<() => void>();
  let active = false;
  let lastAttempt = -Infinity;
  let requestId = 0;
  let controller: AbortController | undefined;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let interval: ReturnType<typeof setInterval> | undefined;
  let unlisten: (() => void) | undefined;

  function update(patch: Partial<ReleaseNotesSnapshot> = {}) {
    const releases = patch.releases ?? snapshot.releases;
    const unreadIds = unreadReleaseIds(releases, readIds);
    snapshot = { ...snapshot, ...patch, unreadIds, unreadCount: unreadIds.length };
    listeners.forEach(listener => listener());
  }

  function mergeReadIds(extra?: Set<string>) {
    const merged = new Set([...readIds, ...(memory.get(storageKey) ?? []), ...(extra ?? [])]);
    try { parseReadReleaseIds(environment.storage().getItem(storageKey)).forEach(id => merged.add(id)); } catch { /* Storage can be unavailable in private mode. */ }
    readIds = merged;
    memory.set(storageKey, merged);
  }

  function persistReadIds() {
    try {
      const storage = environment.storage();
      const serialized = JSON.stringify({ schemaVersion: 1, ids: [...readIds].sort() });
      if (storage.getItem(storageKey) !== serialized) storage.setItem(storageKey, serialized);
    } catch { /* The in-memory acknowledgement remains valid. */ }
  }

  function cancelRequest() {
    controller?.abort();
    controller = undefined;
    if (timeout !== undefined) environment.clearTimeout(timeout);
    timeout = undefined;
  }

  async function refresh(force = false) {
    if (!active || (!force && (!environment.visible() || snapshot.checking || environment.now() - lastAttempt < RELEASE_REFRESH_THROTTLE))) return;
    cancelRequest();
    const currentRequest = ++requestId;
    const requestController = new AbortController();
    controller = requestController;
    lastAttempt = environment.now();
    update({ checking: true, refreshError: false });
    timeout = environment.setTimeout(() => {
      if (!active || currentRequest !== requestId) return;
      ++requestId;
      cancelRequest();
      update({ checking: false, refreshError: true });
    }, RELEASE_REQUEST_TIMEOUT);
    try {
      const response = await environment.fetch("/updates.json", { cache: "no-store", credentials: "omit", signal: requestController.signal });
      if (!response.ok || !/\bapplication\/(?:[\w.-]+\+)?json\b/i.test(response.headers.get("content-type") ?? "")) throw new Error("Invalid release feed response");
      const releases = parseReleaseFeed(await response.json());
      if (!releases) throw new Error("Invalid release feed");
      if (active && currentRequest === requestId) update({ releases, refreshError: false });
    } catch {
      if (active && currentRequest === requestId) update({ refreshError: true });
    } finally {
      if (active && currentRequest === requestId) {
        cancelRequest();
        update({ checking: false });
      }
    }
  }

  function stop() {
    active = false;
    ++requestId;
    cancelRequest();
    if (interval !== undefined) environment.clearInterval(interval);
    interval = undefined;
    unlisten?.();
    unlisten = undefined;
    snapshot = { ...snapshot, checking: false };
  }

  function start() {
    active = true;
    mergeReadIds();
    update();
    unlisten = environment.listen(event => {
      if (event.type === "refresh") { void refresh(); return; }
      if (event.key !== storageKey) return;
      mergeReadIds(parseReadReleaseIds(event.newValue));
      persistReadIds();
      update();
    });
    interval = environment.setInterval(() => { void refresh(); }, RELEASE_REFRESH_INTERVAL);
    void refresh(true);
  }

  return {
    getSnapshot: () => snapshot,
    getServerSnapshot: () => serverSnapshot,
    subscribe(listener: () => void) {
      listeners.add(listener);
      if (!active) start();
      return () => { listeners.delete(listener); if (listeners.size === 0) stop(); };
    },
    refresh: () => { void refresh(true); },
    markRead(id: string) {
      if (!snapshot.releases.some(release => release.id === id)) return;
      mergeReadIds(new Set([id]));
      persistReadIds();
      update();
    },
  };
}
