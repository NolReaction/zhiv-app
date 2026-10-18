import { parseResidentArrivalProgress, type ResidentArrivalProgress } from "@/features/world/domain/resident-arrival-onboarding";

type ArrivalStorage = Pick<Storage, "getItem" | "setItem">;
type Snapshot = { loaded: boolean; progress: ResidentArrivalProgress | null };
const serverSnapshot: Snapshot = { loaded: false, progress: null };
const memory = new Map<string, ResidentArrivalProgress>();

/** Arrival and coach dismissal are independent: closing the text never completes the run. */
export function createResidentArrivalStore(storageKey: string, storage?: ArrivalStorage) {
  let snapshot = serverSnapshot;
  const listeners = new Set<() => void>();
  const update = (progress: ResidentArrivalProgress | null) => {
    if (snapshot.loaded && snapshot.progress?.arrived === progress?.arrived && snapshot.progress?.dismissed === progress?.dismissed) return;
    snapshot = { loaded: true, progress };
    for (const listener of listeners) listener();
  };
  const restore = () => {
    let progress = memory.get(storageKey) ?? null;
    if (!progress && storage) try { progress = parseResidentArrivalProgress(storage.getItem(storageKey)); } catch { /* Memory fallback remains usable. */ }
    update(progress);
  };
  const save = (part: "arrived" | "dismissed") => {
    // Read the latest value first so a second tab cannot erase a finished run or dismissed coach.
    const previous = snapshot.progress;
    restore();
    const progress: ResidentArrivalProgress = { version: 1, arrived: Boolean(previous?.arrived || snapshot.progress?.arrived), dismissed: Boolean(previous?.dismissed || snapshot.progress?.dismissed), [part]: true };
    try {
      if (!storage) throw new Error("Storage unavailable");
      storage.setItem(storageKey, JSON.stringify(progress)); memory.delete(storageKey);
    } catch { memory.set(storageKey, progress); }
    update(progress);
  };
  return { storageKey, getSnapshot: () => snapshot, getServerSnapshot: () => serverSnapshot,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    restore, complete: () => save("arrived"), dismiss: () => save("dismissed") };
}
