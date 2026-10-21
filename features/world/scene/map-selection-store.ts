import type { MapObjectSelection } from "./map-engine";

/** Only the selected menu follows camera pixels; its parent owns open/close. */
export function createMapSelectionStore() {
  let snapshot: MapObjectSelection | null = null;
  const listeners = new Set<() => void>();
  return {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    publish(next: MapObjectSelection | null) {
      if (next === snapshot) return;
      snapshot = next;
      listeners.forEach(listener => listener());
    },
  };
}
