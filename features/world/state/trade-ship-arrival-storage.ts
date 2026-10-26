import { gameplayStorageKey } from "@/lib/gameplay-generation";
import { TRADE_SHIP_GANGWAY, TRADE_SHIP_VOYAGE } from "@/features/world/objects/trade-ship/trade-ship-motion";

export const TRADE_SHIP_ARRIVAL_DURATION = TRADE_SHIP_VOYAGE.arrivalDuration + TRADE_SHIP_GANGWAY.deployDuration;
export type TradeShipArrivalProgress = Readonly<{ version: 1; started: boolean; elapsed: number; hornClaimed: boolean }>;
export type TradeShipArrivalSnapshot = Readonly<{ loaded: boolean; progress: TradeShipArrivalProgress | null }>;
type ArrivalStorage = Pick<Storage, "getItem" | "setItem">;
const serverSnapshot: TradeShipArrivalSnapshot = { loaded: false, progress: null };
const memory = new Map<string, TradeShipArrivalProgress>();
const peers = new Map<string, Set<(progress: TradeShipArrivalProgress) => void>>();

export const tradeShipArrivalStorageKey = (owner: string) => gameplayStorageKey(`zhiv.trade-ship-arrival.v1:${encodeURIComponent(owner)}`);

function parse(value: string | null): TradeShipArrivalProgress | null {
  try {
    const data: unknown = JSON.parse(value ?? "null");
    if (!data || typeof data !== "object" || !("version" in data) || data.version !== 1
      || !("started" in data) || typeof data.started !== "boolean"
      || !("elapsed" in data) || typeof data.elapsed !== "number" || !Number.isFinite(data.elapsed)
      || !("hornClaimed" in data) || typeof data.hornClaimed !== "boolean") return null;
    return Object.freeze({ version: 1, started: data.started,
      elapsed: data.started ? Math.max(0, Math.min(TRADE_SHIP_ARRIVAL_DURATION, data.elapsed)) : 0,
      hornClaimed: data.started && data.hornClaimed });
  } catch { return null; }
}

function merge(a: TradeShipArrivalProgress | null, b: TradeShipArrivalProgress | null): TradeShipArrivalProgress | null {
  if (!a) return b;
  if (!b) return a;
  const started = a.started || b.started, elapsed = Math.max(a.elapsed, b.elapsed), hornClaimed = a.hornClaimed || b.hornClaimed;
  return started === a.started && elapsed === a.elapsed && hornClaimed === a.hornClaimed ? a
    : Object.freeze({ version: 1, started, elapsed, hornClaimed });
}

/** Cosmetic presentation only: this store never grants lighthouse access or gameplay rewards. */
export function createTradeShipArrivalStore(owner: string, storage?: ArrivalStorage) {
  const storageKey = tradeShipArrivalStorageKey(owner), validOwner = Boolean(owner.trim());
  let snapshot = serverSnapshot;
  const listeners = new Set<() => void>();
  const accept = (progress: TradeShipArrivalProgress | null) => {
    const next = merge(snapshot.progress, progress);
    if (snapshot.loaded && next === snapshot.progress) return false;
    snapshot = { loaded: true, progress: next };
    if (next) memory.set(storageKey, merge(memory.get(storageKey) ?? null, next)!);
    for (const listener of [...listeners]) listener();
    return true;
  };
  const receive = (progress: TradeShipArrivalProgress) => { accept(progress); };
  const broadcast = () => {
    if (!snapshot.progress) return;
    for (const peer of [...peers.get(storageKey) ?? []]) if (peer !== receive) peer(snapshot.progress);
  };
  const restore = () => {
    if (!validOwner) { accept(null); return; }
    let progress = memory.get(storageKey) ?? null;
    try { progress = merge(progress, parse(storage?.getItem(storageKey) ?? null)); } catch { /* Same-tab memory survives restricted storage. */ }
    if (accept(progress)) broadcast();
  };
  const save = (progress: TradeShipArrivalProgress) => {
    const next = merge(snapshot.progress, progress)!;
    memory.set(storageKey, next);
    // Synchronous write precedes notification/playback, including durable horn consumption.
    try { storage?.setItem(storageKey, JSON.stringify(next)); } catch { /* Memory and peers still retain progress. */ }
    accept(next); broadcast();
  };
  return { storageKey, getSnapshot: () => snapshot, getServerSnapshot: () => serverSnapshot,
    subscribe(listener: () => void) {
      listeners.add(listener);
      let active = peers.get(storageKey);
      if (!active) { active = new Set(); peers.set(storageKey, active); }
      active.add(receive);
      return () => {
        listeners.delete(listener);
        if (!listeners.size) {
          active!.delete(receive);
          if (!active!.size && peers.get(storageKey) === active) peers.delete(storageKey);
        }
      };
    },
    restore,
    start() {
      if (!validOwner) return;
      restore();
      if (!snapshot.progress?.started) save(Object.freeze({ version: 1, started: true, elapsed: 0, hornClaimed: false }));
    },
    checkpoint(elapsed: number) {
      if (!validOwner || !Number.isFinite(elapsed) || elapsed < 0) return;
      restore();
      if (!snapshot.progress?.started) return;
      const next = Math.min(TRADE_SHIP_ARRIVAL_DURATION, elapsed);
      if (next > snapshot.progress.elapsed) save(Object.freeze({ ...snapshot.progress, elapsed: next }));
    },
    claimHorn() {
      if (!validOwner) return false;
      restore();
      if (!snapshot.progress?.started || snapshot.progress.hornClaimed) return false;
      save(Object.freeze({ ...snapshot.progress, hornClaimed: true }));
      return true;
    },
  };
}
