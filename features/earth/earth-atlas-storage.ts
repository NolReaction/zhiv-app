import { EARTH_ATLAS_ENTRIES, earthAtlasEntry } from "./earth-atlas";

type AtlasStorage = Pick<Storage, "getItem" | "setItem">;
export type EarthAtlasSnapshot = Readonly<{ loaded: boolean; ids: readonly string[]; persistent: boolean }>;
const serverSnapshot: EarthAtlasSnapshot = { loaded: false, ids: [], persistent: true };
export const earthAtlasStorageKey = (owner: string) => `zhiv.earth-atlas.v1:${encodeURIComponent(owner)}`;

export function parseEarthAtlas(raw: string | null): string[] {
  if (!raw || raw.length > 8_000) return [];
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object" || !("version" in value) || value.version !== 1 || !("ids" in value)
      || !Array.isArray(value.ids) || value.ids.length > EARTH_ATLAS_ENTRIES.length) return [];
    return [...new Set(value.ids.filter((id): id is string => typeof id === "string" && !!earthAtlasEntry(id)))];
  } catch { return []; }
}

/** Only public catalogue IDs are stored: no GPS fixes, dates, friend identities or server rewards. */
export function createEarthAtlasStore(owner: string | null, getStorage: () => AtlasStorage | undefined) {
  const storageKey = earthAtlasStorageKey(owner ?? "");
  let snapshot = serverSnapshot;
  let fallback: string[] | null = null;
  let active = false;
  let generation = 0;
  const listeners = new Set<() => void>();
  const update = (ids: readonly string[], persistent: boolean) => {
    if (snapshot.loaded && snapshot.persistent === persistent && snapshot.ids.length === ids.length
      && snapshot.ids.every((id, i) => id === ids[i])) return;
    snapshot = { loaded: true, ids, persistent };
    for (const listener of listeners) listener();
  };
  const restore = (external = false) => {
    if (!active || !owner) return;
    if (external) fallback = null;
    if (fallback) { update(fallback, false); return; }
    try {
      const storage = getStorage();
      if (!storage) throw new Error("Storage unavailable");
      update(parseEarthAtlas(storage.getItem(storageKey)), true);
    } catch { update(snapshot.ids, false); }
  };
  const write = (ids: readonly string[]) => {
    try {
      const storage = getStorage();
      if (!storage) throw new Error("Storage unavailable");
      storage.setItem(storageKey, JSON.stringify({ version: 1, ids })); fallback = null; update(ids, true);
    } catch { fallback = [...ids]; update(ids, false); }
  };
  return { storageKey, getSnapshot: () => snapshot, getServerSnapshot: () => serverSnapshot,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    activate() {
      const current = ++generation;
      active = Boolean(owner); restore();
      return () => { if (current === generation) { active = false; generation++; } };
    },
    restore,
    discover(id: string) {
      if (!active || !owner || !earthAtlasEntry(id)) return false;
      restore();
      if (snapshot.ids.includes(id)) return false;
      write([...snapshot.ids, id]); return true;
    },
    reset() {
      if (!active || !owner) return;
      write([]);
    },
  };
}
