import type { InventoryGain } from "@/features/economy/domain/inventory-gain";

export const INVENTORY_GAIN_MS = 2600;
export const INVENTORY_GAIN_QUEUE_LIMIT = 4;
type PlaybackEffects = {
  show: (event: InventoryGain) => boolean;
  hide: (event: InventoryGain) => void;
  schedule: (finish: () => void, milliseconds: number) => unknown;
  cancel: (timer: unknown) => void;
};

/** A small receipt queue owns presentation only. It never edits quantities or
 * keeps old rewards for reopening a map, returning from a hidden tab or signing
 * into another account. Effects are injectable so lifecycle races are testable. */
export function createInventoryGainPlayback(initialOwner: string | null, initial: readonly InventoryGain[], effects: PlaybackEffects) {
  let owner = initialOwner, seen = new Set(initial.map(event => event.id));
  let queue: InventoryGain[] = [], current: InventoryGain | null = null, timer: unknown = null;
  function clear() {
    if (timer !== null) effects.cancel(timer);
    timer = null; queue = [];
    if (current) effects.hide(current);
    current = null;
  }
  function start() {
    while (!current && queue.length) {
      const event = queue.shift()!;
      if (!effects.show(event)) continue;
      current = event;
      timer = effects.schedule(() => {
        // A cancelled callback must never hide a different account's new badge.
        if (current !== event) return;
        effects.hide(event); current = null; timer = null; start();
      }, INVENTORY_GAIN_MS);
    }
  }
  return {
    receive(nextOwner: string | null, events: readonly InventoryGain[], visible: boolean) {
      if (nextOwner !== owner) {
        clear(); owner = nextOwner; seen = new Set(events.map(event => event.id)); return;
      }
      const fresh = events.filter(event => {
        if (seen.has(event.id)) return false;
        seen.add(event.id);
        return event.ownerPublicId === owner;
      });
      while (seen.size > 64) seen.delete(seen.values().next().value!);
      if (!visible || !owner) { clear(); return; }
      queue = [...queue, ...fresh].slice(-INVENTORY_GAIN_QUEUE_LIMIT);
      start();
    },
    clear,
  };
}
