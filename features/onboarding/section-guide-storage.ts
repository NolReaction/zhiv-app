import { parseSectionGuideProgress, type SectionGuideStorageId, type SectionGuideProgress } from "./section-guide-model";

type GuideStorage = Pick<Storage, "getItem" | "setItem">;
type Snapshot = { loaded: boolean; progress: SectionGuideProgress | null };
const serverSnapshot: Snapshot = { loaded: false, progress: null };
const memory = new Map<string, SectionGuideProgress>();
export const sectionGuideStorageKey = (owner: string, section: SectionGuideStorageId) => `zhiv.section-guide.v1:${encodeURIComponent(owner)}:${section}`;

/** Local presentation preference only. A blocked browser store still remembers within this session. */
export function createSectionGuideStore(owner: string, section: SectionGuideStorageId, storage?: GuideStorage) {
  const storageKey = sectionGuideStorageKey(owner, section);
  let snapshot = serverSnapshot;
  const listeners = new Set<() => void>();
  const update = (progress: SectionGuideProgress | null) => {
    if (snapshot.loaded && JSON.stringify(snapshot.progress) === JSON.stringify(progress)) return;
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
        try { progress = parseSectionGuideProgress(storage.getItem(storageKey), section); } catch { /* Unavailable localStorage is harmless. */ }
      }
      update(progress);
    },
    save(progress: SectionGuideProgress) {
      try {
        if (!storage) throw new Error("Storage unavailable");
        storage.setItem(storageKey, JSON.stringify(progress));
        memory.delete(storageKey);
      } catch { memory.set(storageKey, progress); }
      update(progress);
    },
  };
}
