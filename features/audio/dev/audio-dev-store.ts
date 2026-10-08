type AudioDevState = Readonly<{ showSources: boolean }>;
const INITIAL_STATE: AudioDevState = Object.freeze({ showSources: false });
let state = INITIAL_STATE;
const listeners = new Set<() => void>();

/** Presentation-only diagnostics; never stored with player or economy state. */
export const audioDevStore = {
  getSnapshot: () => state,
  getServerSnapshot: () => INITIAL_STATE,
  subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
  setShowSources(showSources: boolean) {
    if (process.env.NODE_ENV !== "development" || state.showSources === showSources) return;
    state = Object.freeze({ showSources });
    listeners.forEach(listener => listener());
  },
};
