import type { ClientJournalStorage } from "@/lib/client-journal-storage";
import type { EarthLocationPreference, EarthLocationPreferencePersistence, EarthLocationPreferenceStore } from "./location-preferences";

const ACTIVE: EarthLocationPreference = { enabled: true, automaticStartAllowed: true };
const READY: EarthLocationPreference = { enabled: true, automaticStartAllowed: false };
const OFF: EarthLocationPreference = { enabled: false, automaticStartAllowed: false };
const IDLE: EarthLocationPreferencePersistence = { pending: false, error: null };
const encode = (value: EarthLocationPreference) => !value.enabled ? "off" : value.automaticStartAllowed ? "active" : "ready";
// Boot never resumes a saved watch. A new lookup (button or entering the map
// with an OS grant) must pass the controller's privacy gates and commit ACTIVE.
const decode = (value: string | null) => value === null || value === "ready" || value === "active" ? READY : OFF;

/** Uses a hydrated, owner/session-fenced SQLite port. No coordinate or OS grant is stored. */
export function createDurableEarthLocationPreferenceStore(
  storageKey: string,
  storage: ClientJournalStorage,
  legacy?: Pick<Storage, "getItem" | "removeItem">,
): EarthLocationPreferenceStore {
  const listeners = new Set<() => void>();
  const saved = storage.getItem(storageKey);
  let legacyValue: string | null = null;
  if (saved === null) {
    try { legacyValue = legacy?.getItem(storageKey) ?? null; } catch { /* No automatic lookup follows an unreadable legacy choice. */ }
  }
  let state = decode(saved ?? legacyValue);
  let persistence = IDLE;
  let desired = state;
  let retired = false;
  let version = 0;
  let pending = 0;
  let tail: Promise<unknown> = Promise.resolve();
  let activeWrite: Promise<boolean> | undefined;
  const notify = () => { for (const listener of listeners) listener(); };
  const currentSession = () => {
    if (retired) return false;
    try { storage.getItem(storageKey); return true; } catch { return false; }
  };

  function write(next: EarthLocationPreference, restrictive: boolean): Promise<boolean> {
    if (retired) return Promise.resolve(false);
    const request = ++version;
    desired = next;
    pending += 1;
    // Privacy restrictions take effect now, even while a previous ON is in flight.
    // An expansion remains invisible until its actual SQLite commit succeeds.
    if (restrictive) state = next;
    persistence = { pending: true, error: null };
    notify();
    const operation = tail.then(async () => {
      if (retired || request !== version) return false;
      const value = encode(next);
      await storage.setItem(storageKey, value);
      if (retired || request !== version) return false;
      if (storage.getItem(storageKey) !== value) throw new Error("Настройка не подтверждена хранилищем");
      // Never erase the only durable copy. A failed legacy removal is harmless:
      // future reads prefer SQLite and will never resurrect the old value.
      if (legacyValue !== null) {
        try { if (legacy?.getItem(storageKey) === legacyValue) legacy.removeItem(storageKey); } catch { /* Keep the legacy copy. */ }
        legacyValue = null;
      }
      state = next;
      return true;
    }).catch(() => {
      if (!retired && request === version) {
        persistence = { pending: true, error: "Не удалось сохранить выбор геопозиции. Перезапустите приложение и проверьте настройку." };
      }
      return false;
    }).finally(() => {
      pending -= 1;
      if (!retired && request === version) {
        persistence = { ...persistence, pending: pending > 0 };
        notify();
      }
    });
    tail = operation;
    activeWrite = operation;
    return operation;
  }

  if (saved === null && legacyValue !== null) {
    // A legacy ACTIVE belongs to the old WebView contract. Transfer only READY;
    // a new native lookup can grant this session's automatic use.
    void write(state, true);
  }

  return {
    storageKey,
    getSnapshot: () => state,
    getServerSnapshot: () => state,
    getPersistenceSnapshot: () => persistence,
    getServerPersistenceSnapshot: () => IDLE,
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    setEnabled(enabled) {
      const next = enabled ? READY : OFF;
      if (desired === next && persistence.pending && activeWrite) return activeWrite;
      if (state.enabled === enabled && !persistence.pending && !persistence.error && currentSession()) return Promise.resolve(true);
      return write(next, !enabled);
    },
    allowAutomaticStart() {
      if (!state.enabled || retired) return Promise.resolve(false);
      if (!currentSession()) {
        persistence = { pending: pending > 0, error: "Не удалось проверить сохранённый выбор геопозиции. Перезапустите приложение." };
        notify();
        return Promise.resolve(false);
      }
      if (desired === ACTIVE && persistence.pending && activeWrite) return activeWrite;
      if (state === ACTIVE && !persistence.pending && !persistence.error) return Promise.resolve(true);
      return write(ACTIVE, false);
    },
    suppressAutomaticStart() {
      if (!state.enabled) {
        if (persistence.pending && desired.enabled) return write(OFF, true);
        return Promise.resolve(true);
      }
      if (state === READY && !persistence.pending) return Promise.resolve(true);
      return write(READY, true);
    },
    isStartAllowed: () => currentSession() && state === ACTIVE && !persistence.pending && !persistence.error,
    dispose() { retired = true; ++version; state = OFF; listeners.clear(); },
  };
}
