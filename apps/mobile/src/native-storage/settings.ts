import type { ClientKeyValueStorage } from "@/lib/client-persistence";

export const NATIVE_SETTINGS_PREFIX = "mochlik.settings.v1.";
export type PreferencesPort = {
  keys(): Promise<{ keys: string[] }>;
  get(options: { key: string }): Promise<{ value: string | null }>;
  set(options: { key: string; value: string }): Promise<void>;
  remove(options: { key: string }): Promise<void>;
};
export type NativeSettingsStatus = Readonly<{ ready: boolean; pending: number; error: string | null }>;

/** Small, non-secret preferences only. The memory view is hydrated before the game mounts.
 * Writes are serialized; UI can observe pending/error and must not call this a durable queue. */
export function createNativeSettingsStorage(preferences: PreferencesPort) {
  const values = new Map<string, string>();
  const listeners = new Set<() => void>();
  const failures = new Set<string>();
  let status: NativeSettingsStatus = { ready: false, pending: 0, error: null };
  let writes = Promise.resolve();
  let hydration: Promise<void> | undefined;
  const publish = (patch: Partial<NativeSettingsStatus>) => {
    status = { ...status, ...patch };
    listeners.forEach(listener => listener());
  };
  function validate(key: string, value?: string) {
    if (!key || key.length > 512 || value !== undefined && value.length > 64_000) throw new Error("Настройка слишком большая");
  }
  function enqueue(key: string, operation: () => Promise<void>) {
    if (!status.ready) throw new Error("Настройки ещё не загружены");
    publish({ pending: status.pending + 1 });
    writes = writes.then(operation).then(() => {
      failures.delete(key);
      publish({ pending: status.pending - 1, error: failures.size ? "Не удалось сохранить часть настроек. Повторите изменение." : null });
    }, () => {
      failures.add(key);
      publish({ pending: status.pending - 1, error: "Не удалось сохранить настройки на устройстве. Повторите изменение." });
    });
  }
  const storage: ClientKeyValueStorage = {
    getItem(key) { if (!status.ready) throw new Error("Настройки ещё не загружены"); return values.get(key) ?? null; },
    setItem(key, value) {
      validate(key, value);
      enqueue(key, () => preferences.set({ key: NATIVE_SETTINGS_PREFIX + encodeURIComponent(key), value }));
      values.set(key, value);
    },
    removeItem(key) {
      validate(key);
      enqueue(key, () => preferences.remove({ key: NATIVE_SETTINGS_PREFIX + encodeURIComponent(key) }));
      values.delete(key);
    },
  };
  return {
    storage,
    hydrate() {
      if (hydration) return hydration;
      hydration = (async () => {
        const { keys } = await preferences.keys();
        const owned = keys.filter(key => key.startsWith(NATIVE_SETTINGS_PREFIX));
        if (owned.length > 4096) throw new Error("Слишком много настроек на устройстве");
        // Read in small batches, avoiding thousands of outstanding native calls.
        for (let index = 0; index < owned.length; index += 16) {
          await Promise.all(owned.slice(index, index + 16).map(async key => {
            const name = decodeURIComponent(key.slice(NATIVE_SETTINGS_PREFIX.length));
            const { value } = await preferences.get({ key });
            validate(name, value ?? undefined);
            if (value !== null) values.set(name, value);
          }));
        }
        publish({ ready: true, error: null });
      })().catch(error => {
        values.clear(); hydration = undefined;
        publish({ ready: false, error: "Не удалось прочитать настройки устройства. Повторите запуск." });
        throw error;
      });
      return hydration;
    },
    flush: () => writes,
    getSnapshot: () => status,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
  };
}
