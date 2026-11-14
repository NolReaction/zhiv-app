import type { ClientJournalStorage } from "@/lib/client-journal-storage";

export type EarthPendingPrivacy = { mode: "GHOST" | "OFF"; key: string };
export const earthPendingPrivacyKey = (owner: string) => `zhiv:earth:pending-privacy:v1:${owner}`;
export function parsePendingPrivacy(value: unknown): EarthPendingPrivacy | null {
  if (!value || typeof value !== "object") return null;
  const intent = value as Partial<EarthPendingPrivacy>;
  return (intent.mode === "GHOST" || intent.mode === "OFF") && typeof intent.key === "string"
    && /^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/i.test(intent.key)
    ? { mode: intent.mode, key: intent.key } : null;
}
type LegacyStorage = Pick<Storage, "getItem" | "removeItem">;
function decode(value: string | null): EarthPendingPrivacy | null {
  if (value === null) return null;
  if (value.length > 256) throw new Error("Повреждена команда скрытия геопозиции");
  const parsed = parsePendingPrivacy(JSON.parse(value));
  if (!parsed) throw new Error("Повреждена команда скрытия геопозиции");
  return parsed;
}

/** Only restrictive intents live here; no coordinates, audience or permission grant.
 * Native storage already captures the account UUID and hydration epoch. */
export function createDurableEarthPrivacyStorage(owner: string, storage: ClientJournalStorage, legacy?: LegacyStorage) {
  const key = earthPendingPrivacyKey(owner), listeners = new Set<(intent: EarthPendingPrivacy | null) => void>();
  let tail: Promise<void> = Promise.resolve();
  let staged: EarthPendingPrivacy | null | undefined;
  const notify = () => { for (const listener of listeners) listener(staged ?? null); };
  const enqueue = (operation: () => Promise<void>) => {
    const result = tail.then(operation);
    tail = result.catch(() => {});
    return result;
  };
  const removeLegacy = (intentKey: string) => {
    if (decode(legacy?.getItem(key) ?? null)?.key !== intentKey) return;
    legacy!.removeItem(key);
    if (legacy!.getItem(key) !== null) throw new Error("Не удалось завершить перенос команды скрытия");
  };
  return {
    durablePending: true as const,
    loadPending() {
      // Even a staged intent must not escape a retired account/session fence.
      const committed = decode(storage.getItem(key));
      if (staged !== undefined) return staged;
      staged = committed ?? decode(legacy?.getItem(key) ?? null);
      return staged;
    },
    savePending(intent: EarthPendingPrivacy) {
      const valid = parsePendingPrivacy(intent);
      if (!valid) return Promise.reject(new Error("Неверная команда скрытия геопозиции"));
      staged = valid; notify();
      return enqueue(async () => {
        const encoded = JSON.stringify(valid);
        if (storage.getItem(key) !== encoded) await storage.setItem(key, encoded);
        if (storage.getItem(key) !== encoded) throw new Error("Сохранение команды скрытия не подтверждено");
        // Only this installed app's former WebView storage is accessible here.
        // Never remove its only copy before the SQLite commit is verified.
        try { removeLegacy(valid.key); } catch { /* Retain the SQLite copy until cleanup can finish. */ }
      });
    },
    clearPending(intentKey: string) {
      return enqueue(async () => {
        if (decode(storage.getItem(key))?.key !== intentKey) return;
        // Cleanup first: otherwise a failed legacy delete could resurrect it after restart.
        removeLegacy(intentKey);
        await storage.removeItem(key);
        if (storage.getItem(key) !== null) throw new Error("Удаление команды скрытия не подтверждено");
        if (staged?.key === intentKey) { staged = null; notify(); }
      });
    },
    onPendingChange(callback: (intent: EarthPendingPrivacy | null) => void) {
      listeners.add(callback); return () => { listeners.delete(callback); };
    },
  };
}

// Strict Mode can replace an effect while a commit is pending. Keep its immediate
// restriction and FIFO attached to the stable hydrated owner port across mounts.
const stores = new WeakMap<ClientJournalStorage, ReturnType<typeof createDurableEarthPrivacyStorage>>();
export function durableEarthPrivacyStorage(owner: string, storage: ClientJournalStorage, legacy?: LegacyStorage) {
  let store = stores.get(storage);
  if (!store) { store = createDurableEarthPrivacyStorage(owner, storage, legacy); stores.set(storage, store); }
  return store;
}
