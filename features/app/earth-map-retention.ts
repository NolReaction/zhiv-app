export const EARTH_MAP_RETENTION_MS = 120_000;

export type EarthMapRetentionContext = {
  owner: string | null;
  selected: boolean;
  available: boolean;
  documentHidden: boolean;
};

type RetentionSnapshot = { owner: string | null; mounted: boolean; ready: boolean; expiresAt: number | null };
type RetentionClock = {
  now: () => number;
  setTimeout: (callback: () => void, delay: number) => unknown;
  clearTimeout: (handle: unknown) => void;
};

const EMPTY: RetentionSnapshot = { owner: null, mounted: false, ready: false, expiresAt: null };
const INACTIVE: EarthMapRetentionContext = { owner: null, selected: false, available: false, documentHidden: false };

/** One owner-scoped map may sleep briefly; GPS and camera data never enter this controller. */
export function createEarthMapRetention(clock: RetentionClock = {
  now: Date.now,
  setTimeout: (callback, delay) => setTimeout(callback, delay),
  clearTimeout: handle => clearTimeout(handle as ReturnType<typeof setTimeout>),
}) {
  const listeners = new Set<() => void>();
  let context = INACTIVE;
  let snapshot = EMPTY;
  let timer: unknown = null;
  let expiryEpoch = 0;

  function publish(next: RetentionSnapshot) {
    if (snapshot.owner === next.owner && snapshot.mounted === next.mounted
      && snapshot.ready === next.ready && snapshot.expiresAt === next.expiresAt) return;
    snapshot = next;
    for (const listener of listeners) listener();
  }
  function cancelExpiry() {
    expiryEpoch += 1;
    if (timer !== null) clock.clearTimeout(timer);
    timer = null;
  }
  function release() {
    cancelExpiry();
    publish(EMPTY);
  }
  function reconcile() {
    if (!context.owner || !context.available) { release(); return; }
    const currentOwner = snapshot.owner === context.owner;
    if (context.selected && !context.documentHidden) {
      cancelExpiry();
      publish({ owner: context.owner, mounted: true, ready: currentOwner && snapshot.ready, expiresAt: null });
      return;
    }
    // A hidden document can finish the current preparation on return. Ordinary
    // section navigation only retains an already prepared map.
    if (!currentOwner || !snapshot.mounted || (!snapshot.ready && !context.selected)) { release(); return; }
    if (timer !== null) return; // Unrelated renders never extend the dormant budget.
    const expiresAt = clock.now() + EARTH_MAP_RETENTION_MS;
    const epoch = ++expiryEpoch;
    timer = clock.setTimeout(() => {
      if (epoch !== expiryEpoch) return;
      timer = null;
      publish(EMPTY);
    }, EARTH_MAP_RETENTION_MS);
    publish({ ...snapshot, expiresAt });
  }

  return {
    getSnapshot: () => snapshot,
    getServerSnapshot: () => EMPTY,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    setContext(next: EarthMapRetentionContext) { context = next; reconcile(); },
    reportReady(owner: string, ready: boolean) {
      if (!snapshot.mounted || snapshot.owner !== owner || context.owner !== owner) return;
      publish({ ...snapshot, ready });
      reconcile();
    },
    dispose() { context = INACTIVE; release(); },
  };
}
