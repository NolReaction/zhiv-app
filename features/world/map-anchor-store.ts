import type { MapObjectScreenAnchor } from "./construction-map-anchor";

/** Camera coordinates are transient view data, separate from scene/game state. */
export function createMapAnchorStore() {
  let snapshot: readonly MapObjectScreenAnchor[] = [];
  const listeners = new Set<() => void>();
  return {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    publish(next: readonly MapObjectScreenAnchor[]) {
      if (next === snapshot) return;
      snapshot = next;
      listeners.forEach(listener => listener());
    },
  };
}
