import { EARTH_ATLAS_ENTRIES, earthAtlasEntry, type EarthAtlasEntry } from "./earth-atlas";
import { EARTH_ATLAS_PLACES } from "./earth-atlas-visible";

export const EARTH_ATLAS_DISCOVERY_DURATION_MS = 3200;

export type EarthAtlasDiscoveryFeedback = Readonly<{
  sequence: number;
  entry: EarthAtlasEntry;
  openedCount: number;
  total: number;
}>;

type Scheduler = Readonly<{
  schedule: (callback: () => void, delay: number) => unknown;
  cancel: (handle: unknown) => void;
}>;

const browserScheduler: Scheduler = {
  schedule: (callback, delay) => setTimeout(callback, delay),
  cancel: handle => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** Transient feedback only. The atlas store remains the authority for a successful opening. */
export function createEarthAtlasDiscoveryFeedback(owner: string | null, scheduler: Scheduler = browserScheduler) {
  const listeners = new Set<() => void>();
  let snapshot: EarthAtlasDiscoveryFeedback | null = null;
  let timer: unknown;
  let active = false;
  let activation = 0;
  let sequence = 0;
  let lastKey: string | null = null;

  const publish = (next: EarthAtlasDiscoveryFeedback | null) => {
    if (snapshot === next) return;
    snapshot = next;
    listeners.forEach(listener => listener());
  };
  const cancelTimer = () => {
    if (timer === undefined) return;
    scheduler.cancel(timer);
    timer = undefined;
  };
  const clear = () => {
    cancelTimer();
    lastKey = null;
    publish(null);
  };
  const show = (entry: EarthAtlasEntry, openedCount: number) => {
    const canonical = earthAtlasEntry(entry.id);
    if (!active || !owner || !canonical || !Number.isInteger(openedCount)
      || openedCount < 1 || openedCount > EARTH_ATLAS_ENTRIES.length) return false;
    const total = canonical.kind === "landmark" ? EARTH_ATLAS_PLACES.length : EARTH_ATLAS_ENTRIES.length;
    const count = Math.min(openedCount, total);
    const key = `${canonical.id}:${count}`;
    // A duplicate callback must not restart animation or extend the announcement.
    if (key === lastKey) return false;
    cancelTimer();
    lastKey = key;
    const next = Object.freeze({ sequence: ++sequence, entry: canonical, openedCount: count, total });
    timer = scheduler.schedule(() => {
      // A canceled browser callback can still be queued when a newer event arrives.
      if (!active || snapshot?.sequence !== next.sequence) return;
      timer = undefined;
      publish(null);
    }, EARTH_ATLAS_DISCOVERY_DURATION_MS);
    publish(next);
    return true;
  };

  return {
    getSnapshot: () => snapshot,
    getServerSnapshot: () => null,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    activate: () => {
      const lease = ++activation;
      active = Boolean(owner);
      return () => {
        if (lease !== activation) return;
        active = false;
        clear();
      };
    },
    show,
    clear,
  };
}
