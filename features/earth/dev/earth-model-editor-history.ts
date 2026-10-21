import {
  getEarthModelPlacements,
  importEarthModelPlacements,
  subscribeEarthModelPlacements,
  type EarthModelPlacement,
} from "../model-placement";

const MAX_HISTORY_ENTRIES = 100;
type PlacementState = readonly EarthModelPlacement[];
export type EarthModelEditorHistorySnapshot = Readonly<{
  canUndo: boolean;
  canRedo: boolean;
  undoCount: number;
  redoCount: number;
}>;

/** Development-only undo state. Constructing it has no subscriptions or writes.
 * Call connect after draft hydration; its cleanup permits StrictMode reconnect.
 * A reconnect starts a fresh baseline. History never enters exported placements.
 */
export function createEarthModelEditorHistory() {
  const undoStates: PlacementState[] = [], redoStates: PlacementState[] = [];
  const listeners = new Set<() => void>();
  let current = getEarthModelPlacements();
  let transactionStart: PlacementState | null = null;
  let releaseStore: (() => void) | null = null;
  let generation = 0;
  let replaying = false;
  let snapshot: EarthModelEditorHistorySnapshot = Object.freeze({
    canUndo: false, canRedo: false, undoCount: 0, redoCount: 0,
  });

  function equal(a: PlacementState, b: PlacementState) {
    return a === b || JSON.stringify(a) === JSON.stringify(b);
  }
  function pendingChange() { return transactionStart !== null && !equal(transactionStart, current); }
  function publish() {
    const pending = pendingChange();
    const undoCount = Math.min(MAX_HISTORY_ENTRIES, undoStates.length + Number(pending));
    const redoCount = pending ? 0 : redoStates.length;
    if (snapshot.undoCount === undoCount && snapshot.redoCount === redoCount) return;
    snapshot = Object.freeze({ canUndo: undoCount > 0, canRedo: redoCount > 0, undoCount, redoCount });
    for (const listener of [...listeners]) listener();
  }
  function push(states: PlacementState[], value: PlacementState) {
    // Placement-store arrays and rows are immutable; retain complete snapshots,
    // including fields a particular control does not edit.
    states.push(value);
    if (states.length > MAX_HISTORY_ENTRIES) states.splice(0, states.length - MAX_HISTORY_ENTRIES);
  }
  function finishTransaction() {
    const start = transactionStart;
    transactionStart = null;
    if (start !== null && !equal(start, current)) {
      push(undoStates, start);
      redoStates.length = 0;
    }
  }
  function observePlacements() {
    const next = getEarthModelPlacements(), before = current;
    current = next;
    if (replaying || equal(before, next)) return;
    if (transactionStart === null) {
      push(undoStates, before);
      redoStates.length = 0;
    }
    // Keep redo until a transaction actually commits. A gesture that returns
    // to its starting values is a no-op and preserves the existing redo branch.
    publish();
  }
  function restore(value: PlacementState) {
    replaying = true;
    try { importEarthModelPlacements({ version: 1, placements: value }); }
    finally { current = getEarthModelPlacements(); replaying = false; }
  }
  function disconnect() {
    generation++;
    releaseStore?.();
    releaseStore = null;
    transactionStart = null;
    undoStates.length = 0; redoStates.length = 0;
    current = getEarthModelPlacements();
    publish();
  }

  return {
    connect() {
      disconnect();
      const connection = generation;
      // Hydration and edits before the effect connects are the initial state,
      // not user actions that can accidentally undo into another draft.
      current = getEarthModelPlacements();
      releaseStore = subscribeEarthModelPlacements(observePlacements);
      return () => { if (connection === generation) disconnect(); };
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    getSnapshot() { return snapshot; },
    /** Idempotent until endTransaction; pair one gesture with one end call. */
    beginTransaction() {
      if (releaseStore && transactionStart === null) transactionStart = current;
    },
    endTransaction() {
      if (!releaseStore) return;
      finishTransaction(); publish();
    },
    undo(): boolean {
      if (!releaseStore) return false;
      finishTransaction();
      const target = undoStates.at(-1);
      if (!target) { publish(); return false; }
      const before = current;
      restore(target);
      undoStates.pop(); push(redoStates, before);
      publish();
      return true;
    },
    redo(): boolean {
      if (!releaseStore) return false;
      finishTransaction();
      const target = redoStates.at(-1);
      if (!target) { publish(); return false; }
      const before = current;
      restore(target);
      redoStates.pop(); push(undoStates, before);
      publish();
      return true;
    },
    dispose: disconnect,
  };
}
