export type MobilePreferencesPort = {
  get(options: { key: string }): Promise<{ value: string | null }>;
  set(options: { key: string; value: string }): Promise<void>;
};

export type MobileLocationPreference = Readonly<{
  ready: boolean;
  enabled: boolean;
  saving: boolean;
  error: string | null;
}>;

// This switch belongs to the diagnostics app, not an account's sharing consent.
// No position, OS permission or account credential is stored here.
export const mobileLocationPreferenceKey = "mochlik.native-diagnostics.location-enabled.v1";

const INITIAL: MobileLocationPreference = {
  ready: false,
  enabled: false,
  saving: false,
  error: null,
};

/** Loading an enabled preference permits manual lookup; it never starts GPS. */
export function createMobileLocationPreferenceStore(port: MobilePreferencesPort) {
  let state = INITIAL;
  const listeners = new Set<() => void>();
  let hydration: Promise<void> | undefined;
  let editVersion = 0;
  let pendingWrites = 0;
  let writeQueue = Promise.resolve();

  function publish(next: MobileLocationPreference) {
    state = next;
    for (const listener of listeners) listener();
  }

  function hydrate(): Promise<void> {
    if (hydration) return hydration;
    if (editVersion > 0) {
      hydration = Promise.resolve();
      return hydration;
    }
    const version = editVersion;
    hydration = (async () => {
      try {
        const { value } = await port.get({ key: mobileLocationPreferenceKey });
        // A delayed read cannot undo a more recent deliberate choice.
        if (version !== editVersion) return;
        publish({ ready: true, enabled: value === "on", saving: false, error: null });
      } catch {
        if (version !== editVersion) return;
        publish({ ready: true, enabled: false, saving: false,
          error: "Не удалось прочитать настройку. Геопозиция выключена." });
      }
    })();
    return hydration;
  }

  function setEnabled(enabled: boolean): Promise<void> {
    const version = ++editVersion;
    pendingWrites += 1;
    // OFF takes effect synchronously, including while another write is pending.
    publish({ ready: true, enabled, saving: true, error: null });
    const operation = writeQueue.then(async () => {
      let error: string | null = null;
      try {
        await port.set({ key: mobileLocationPreferenceKey, value: enabled ? "on" : "off" });
      } catch {
        error = "Не удалось сохранить настройку. Она действует только до перезапуска.";
      } finally {
        pendingWrites -= 1;
        // The latest choice owns the visible outcome. Earlier errors cannot
        // replace it, and serialization ensures OFF is written after ON.
        if (version === editVersion) publish({ ...state, saving: pendingWrites > 0, error });
      }
    });
    // Errors from the storage port are consumed inside the operation. Callers
    // can await this promise or use void without an unhandled rejection.
    writeQueue = operation;
    return operation;
  }

  return {
    getSnapshot: () => state,
    getServerSnapshot: () => INITIAL,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    hydrate,
    setEnabled,
  };
}
