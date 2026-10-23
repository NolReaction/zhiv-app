import { parseResidentArrivalProgress, type ResidentArrivalProgress } from "@/features/world/domain/resident-arrival-onboarding";

type ArrivalStorage = Pick<Storage, "getItem" | "setItem">;
type Snapshot = { loaded: boolean; prepared: boolean; progress: ResidentArrivalProgress | null };
const serverSnapshot: Snapshot = { loaded: false, prepared: false, progress: null };
const memory = new Map<string, ResidentArrivalProgress>();
// Circle, map and DEV can observe separate stores in the same tab. Native
// storage events only reach other tabs, so active peers share local changes.
const peers = new Map<string, Set<(progress: ResidentArrivalProgress) => void>>();

/** Arrival and coach dismissal are independent: closing the text never completes the run. */
export function createResidentArrivalStore(storageKey: string, storage?: ArrivalStorage) {
  let snapshot = serverSnapshot;
  let prepared = false;
  const listeners = new Set<() => void>();
  const update = (progress: ResidentArrivalProgress | null) => {
    if (snapshot.loaded && snapshot.prepared === prepared && snapshot.progress?.arrived === progress?.arrived && snapshot.progress?.dismissed === progress?.dismissed) return;
    snapshot = { loaded: true, prepared, progress };
    for (const listener of listeners) listener();
  };
  const restore = () => {
    let progress = memory.get(storageKey) ?? null;
    if (!progress && storage) try { progress = parseResidentArrivalProgress(storage.getItem(storageKey)); } catch { /* Memory fallback remains usable. */ }
    update(progress);
  };
  const save = (part: "arrived" | "dismissed" | "existing") => {
    // Read the latest value first so a second tab cannot erase a finished run or dismissed coach.
    const previous = snapshot.progress;
    restore();
    const freshCompletion = part === "arrived" && !previous?.arrived && !snapshot.progress?.arrived;
    const coachDismissed = Boolean(previous?.dismissed || snapshot.progress?.dismissed);
    const progress: ResidentArrivalProgress = { version: 1,
      arrived: part === "arrived" || part === "existing" || Boolean(previous?.arrived || snapshot.progress?.arrived),
      dismissed: part === "dismissed" || part === "existing" || Boolean(previous?.dismissed || snapshot.progress?.dismissed) };
    try {
      if (!storage) throw new Error("Storage unavailable");
      storage.setItem(storageKey, JSON.stringify(progress)); memory.delete(storageKey);
    } catch { memory.set(storageKey, progress); }
    update(progress);
    for (const peer of peers.get(storageKey) ?? []) if (peer !== update) peer(progress);
    return freshCompletion && coachDismissed;
  };
  return { storageKey, getSnapshot: () => snapshot, getServerSnapshot: () => serverSnapshot,
    subscribe(listener: () => void) {
      listeners.add(listener);
      let active = peers.get(storageKey);
      if (!active) { active = new Set(); peers.set(storageKey, active); }
      active.add(update);
      return () => {
        listeners.delete(listener);
        if (!listeners.size) {
          active!.delete(update);
          if (!active!.size && peers.get(storageKey) === active) peers.delete(storageKey);
        }
      };
    },
    restore, complete: () => save("arrived"), dismiss: () => save("dismissed"),
    // Existing server buildings are historical arrivals, not a new cutscene.
    prepare(unlocked: boolean) {
      if (prepared) return;
      prepared = true;
      if (unlocked) save("existing");
      else update(snapshot.progress);
    } };
}
