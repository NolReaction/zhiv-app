import type { ClientJournalStorage } from "@/lib/client-journal-storage";

export type NativeJournalPort = {
  listJournals(options: { owner: string }): Promise<{ records: Array<{ key: string; value: string }> }>;
  writeJournal(options: { owner: string; key: string; expectedValue: string | null; value: string | null }): Promise<void>;
};

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const publicId = /^[0-9A-HJKMNP-TV-Z]{4}(?:-[0-9A-HJKMNP-TV-Z]{4}){2}$/;
const MAX_RECORDS = 256;
const MAX_VALUE_BYTES = 6_000_000;
const MAX_TOTAL_BYTES = 32_000_000;
const size = (value: string) => new TextEncoder().encode(value).length;

export function journalKeyOwner(key: string): string | null {
  if (key.length > 768) return null;
  const unscoped = key.replace(/^zhiv:gameplay:v1:(?:0|[1-9][0-9]{0,15}):/, "");
  const match = /^(?:zhiv:economy:(?:production|boat-journal|boat-landing|pending):v1:|zhiv:game-(?:outbox|input|rewards:pending):v1:|zhiv:world:pending:v1:|zhiv:check-in:pending:v1:|zhiv:earth:pending-privacy:v1:)([0-9A-HJKMNP-TV-Z]{4}(?:-[0-9A-HJKMNP-TV-Z]{4}){2})(?::[A-Za-z0-9._:-]{1,200})?$/.exec(unscoped)
    ?? /^zhiv\.earth-location\.v1:([0-9A-HJKMNP-TV-Z]{4}(?:-[0-9A-HJKMNP-TV-Z]{4}){2})$/.exec(unscoped)
    ?? /^zhiv\.boat-reel\.(?:v1|current)\.([0-9A-HJKMNP-TV-Z]{4}(?:-[0-9A-HJKMNP-TV-Z]{4}){2})(?:\.[A-Za-z0-9.-]{1,200})?$/.exec(unscoped);
  return match?.[1] ?? null;
}

/** One process-wide owner fence and FIFO for all journal mutations. Native CAS
 * protects against another WebView/process; a conflict never overwrites its data. */
export function createNativeJournalStorage(database: NativeJournalPort) {
  let epoch = 0;
  let owner: string | undefined;
  let records = new Map<string, string>();
  let ports = new Map<string, ClientJournalStorage>();
  let tail: Promise<void> = Promise.resolve();
  let fault: Error | undefined;

  return {
    async hydrate(nextOwner?: string) {
      const generation = ++epoch;
      owner = undefined; records = new Map(); ports = new Map(); fault = undefined;
      // Complete already-issued commits before reading their results for a new session.
      await tail.catch(() => {});
      if (generation !== epoch || !nextOwner) return;
      if (!uuid.test(nextOwner)) throw new Error("Не удалось определить аккаунт хранилища");
      const result = await database.listJournals({ owner: nextOwner });
      if (generation !== epoch) return;
      if (!Array.isArray(result.records) || result.records.length > MAX_RECORDS) throw new Error("Журнал устройства слишком большой");
      const restored = new Map<string, string>();
      let total = 0;
      for (const row of result.records) {
        if (!row || typeof row.key !== "string" || !journalKeyOwner(row.key) || typeof row.value !== "string"
          || restored.has(row.key) || size(row.value) > MAX_VALUE_BYTES) throw new Error("Повреждён журнал устройства");
        total += size(row.value);
        if (total > MAX_TOTAL_BYTES) throw new Error("Журнал устройства слишком большой");
        restored.set(row.key, row.value);
      }
      records = restored; owner = nextOwner;
    },
    forOwner(ownerPublicId: string): ClientJournalStorage {
      if (!publicId.test(ownerPublicId)) throw new Error("Не определён владелец игрового журнала");
      if (!owner) throw new Error("Хранилище аккаунта ещё не готово");
      const existing = ports.get(ownerPublicId);
      if (existing) return existing;
      const expectedOwner = owner, expectedEpoch = epoch;
      const check = (key?: string) => {
        if (!expectedOwner || owner !== expectedOwner || epoch !== expectedEpoch) throw new Error("Аккаунт изменился во время сохранения");
        if (fault) throw fault;
        if (key !== undefined && journalKeyOwner(key) !== ownerPublicId) throw new Error("Игровой журнал принадлежит другому аккаунту");
      };
      const mutate = (key: string, value: string | null) => {
        check(key);
        if (value !== null && (typeof value !== "string" || size(value) > MAX_VALUE_BYTES)) return Promise.reject(new Error("Игровой журнал слишком большой"));
        const operation = tail.then(async () => {
          check(key);
          const previous = records.get(key) ?? null;
          if (previous === value) return;
          if (value !== null) {
            if (previous === null && records.size >= MAX_RECORDS) throw new Error("Слишком много игровых журналов");
            const total = [...records].reduce((sum, [storedKey, stored]) => sum + (storedKey === key ? 0 : size(stored)), size(value));
            if (total > MAX_TOTAL_BYTES) throw new Error("Недостаточно места для игровых журналов");
          }
          await database.writeJournal({ owner: expectedOwner!, key, expectedValue: previous, value });
          check(key);
          if (value === null) records.delete(key); else records.set(key, value);
        }).catch(error => {
          // A lost native ACK is uncertain. Freeze this hydrated view rather than
          // guessing whether SQLite committed; reload reads the authoritative rows.
          if (epoch === expectedEpoch && owner === expectedOwner) fault = error instanceof Error ? error : new Error("Не удалось сохранить игровой журнал");
          throw error;
        });
        tail = operation.catch(() => {});
        return operation;
      };
      const port: ClientJournalStorage = {
        getItem(key) { check(key); return records.get(key) ?? null; },
        getKeys() { check(); return [...records.keys()].filter(key => journalKeyOwner(key) === ownerPublicId); },
        setItem: (key, value) => mutate(key, value),
        removeItem: key => mutate(key, null),
      };
      ports.set(ownerPublicId, port);
      return port;
    },
    flush: () => tail,
  };
}
