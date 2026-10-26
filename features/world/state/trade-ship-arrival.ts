import { advanceTradeShipMotion, createTradeShipMotion, type TradeShipMotion } from "@/features/world/objects/trade-ship/trade-ship-motion";
import { syncForestResidentAccess, type EconomySceneResidents } from "./economy/economy-residents-state";
import { createTradeShipArrivalStore, tradeShipArrivalStorageKey, TRADE_SHIP_ARRIVAL_DURATION } from "./trade-ship-arrival-storage";

export type SceneTradeShipFrame = {
  motion: TradeShipMotion; voyageId: string; kind: "arrival" | "dev"; pending: boolean; claimHorn?: () => boolean;
};
type ArrivalStore = ReturnType<typeof createTradeShipArrivalStore>;

/** Cosmetic only: authoritative account levels allow this visual, never the reverse. */
export function createTradeShipArrivalRuntime(owner: string, store: ArrivalStore) {
  const authority: { economyResidents?: EconomySceneResidents } = {};
  const listeners = new Set<() => void>();
  let eligible = false, elapsed = 0, lastFrame: number | null = null;
  let motion = createTradeShipMotion("arriving");
  const notify = () => { for (const listener of [...listeners]) listener(); };
  const sample = () => advanceTradeShipMotion(createTradeShipMotion("arriving"), elapsed);
  function restored() {
    const progress = store.getSnapshot().progress;
    const next = Math.max(elapsed, progress?.started ? progress.elapsed : 0);
    if (next !== elapsed) { elapsed = next; motion = sample(); }
    notify();
  }
  const unsubscribe = store.subscribe(restored);
  function flush() {
    if (store.getSnapshot().progress?.started) store.checkpoint(elapsed);
  }
  return {
    owner, storageKey: store.storageKey,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    restore() { store.restore(); restored(); },
    configure(incoming: EconomySceneResidents | null | undefined) {
      if (!owner || incoming?.ownerPublicId !== owner || !incoming.production) return;
      if (!syncForestResidentAccess(authority, incoming, owner)) return;
      const level = authority.economyResidents?.buildings.lighthouse;
      const next = Number.isSafeInteger(level) && level! >= 1;
      if (next !== eligible) { eligible = next; notify(); }
    },
    getFrame(): SceneTradeShipFrame | null {
      const state = store.getSnapshot();
      if (!eligible || !state.loaded) return null;
      return { motion, voyageId: store.storageKey, kind: "arrival", pending: !state.progress?.started };
    },
    start(still = false) {
      if (!eligible || !store.getSnapshot().loaded) return false;
      if (store.getSnapshot().progress?.started && (!still || motion.phase === "docked")) return false;
      store.start();
      if (still) { elapsed = TRADE_SHIP_ARRIVAL_DURATION; motion = sample(); flush(); }
      notify(); return true;
    },
    advance(seconds: number, frame: number) {
      if (!eligible || !store.getSnapshot().progress?.started || motion.phase === "docked"
        || !Number.isFinite(seconds) || seconds <= 0 || !Number.isFinite(frame) || frame === lastFrame) return;
      lastFrame = frame;
      const phase = motion.phase;
      elapsed = Math.min(TRADE_SHIP_ARRIVAL_DURATION, elapsed + Math.min(.05, seconds));
      motion = sample();
      const saved = store.getSnapshot().progress?.elapsed ?? 0;
      if (elapsed - saved >= .25 || motion.phase !== phase) flush();
      if (motion.phase !== phase) notify();
    },
    claimHorn() {
      if (!eligible || !store.getSnapshot().progress?.started) return false;
      flush(); return store.claimHorn();
    },
    flush,
    dispose() { flush(); unsubscribe(); listeners.clear(); },
  };
}

type Runtime = ReturnType<typeof createTradeShipArrivalRuntime>;
type Entry = { runtime: Runtime; clients: Set<() => void>; queued: boolean; stop?: () => void };
const entries = new Map<string, Entry>();
function storage() {
  try { return typeof window === "undefined" ? undefined : window.localStorage; } catch { return undefined; }
}

/** Scene remounts share one live clock; browser storage is a bounded resume checkpoint. */
export function connectTradeShipArrival(owner: string, changed: () => void) {
  const key = tradeShipArrivalStorageKey(owner);
  let entry = entries.get(key);
  if (!entry) {
    entry = { runtime: createTradeShipArrivalRuntime(owner, createTradeShipArrivalStore(owner, storage())), clients: new Set(), queued: false };
    const current = entry;
    current.runtime.subscribe(() => {
      if (current.queued) return;
      current.queued = true;
      queueMicrotask(() => { current.queued = false; for (const listener of [...current.clients]) listener(); });
    });
    entries.set(key, current);
  }
  const current = entry, runtime = current.runtime;
  if (!current.clients.size) {
    runtime.restore();
    const restore = (event: StorageEvent) => { if (event.key === key || event.key === null) runtime.restore(); };
    const save = () => runtime.flush();
    if (typeof window !== "undefined") {
      window.addEventListener?.("storage", restore); window.addEventListener?.("pagehide", save);
      current.stop = () => { window.removeEventListener?.("storage", restore); window.removeEventListener?.("pagehide", save); };
    }
  }
  current.clients.add(changed);
  let released = false;
  return {
    configure: runtime.configure,
    getFrame: (): SceneTradeShipFrame | null => {
      const frame = runtime.getFrame();
      return !released && frame ? { ...frame, claimHorn: () => !released && runtime.claimHorn() } : null;
    },
    start: (still = false) => !released && runtime.start(still),
    advance: (seconds: number, frame: number) => { if (!released) runtime.advance(seconds, frame); },
    release() {
      if (released) return;
      released = true; runtime.flush(); current.clients.delete(changed);
      if (!current.clients.size) {
        current.stop?.(); current.stop = undefined;
        // Keep one dormant account's exact phase, without retaining every user visited in a tab.
        for (const [otherKey, other] of entries) if (other !== current && !other.clients.size) {
          other.runtime.dispose(); entries.delete(otherKey);
        }
      }
    },
  };
}
