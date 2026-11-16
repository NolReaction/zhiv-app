import { gameplayStorageKey } from "@/lib/gameplay-generation";
import type { ClientJournalStorage } from "@/lib/client-journal-storage";

export type PendingCheckIn = {
  version: 2;
  kind: "check-in";
  idempotencyKey: string;
  ownerPublicId: string;
  previousLastCheckInAt: string | null;
  createdAt: number;
  expiresAt: number;
};

type LegacyStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PUBLIC_ID = /^[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){2}$/;
export const CHECK_IN_STORAGE_ERROR = "Не удалось сохранить запись отметки на устройстве. Перезапустите приложение перед повторной отправкой.";

export function isPendingCheckIn(value: unknown): value is PendingCheckIn {
  if (!value || typeof value !== "object") return false;
  const row = value as Record<string, unknown>;
  return row.version === 2 && row.kind === "check-in"
    && typeof row.idempotencyKey === "string" && UUID.test(row.idempotencyKey)
    && typeof row.ownerPublicId === "string" && PUBLIC_ID.test(row.ownerPublicId)
    && (row.previousLastCheckInAt === null || typeof row.previousLastCheckInAt === "string")
    && typeof row.createdAt === "number" && Number.isFinite(row.createdAt)
    && typeof row.expiresAt === "number" && Number.isFinite(row.expiresAt) && row.expiresAt > row.createdAt;
}

/** One account's exact check-in receipt. Native mutations serialize, and an unknown
 * commit result blocks later writes until the database has been rehydrated. */
export function createCheckInJournal(owner: string, native?: ClientJournalStorage, legacy?: LegacyStorage) {
  const key = gameplayStorageKey(`zhiv:check-in:pending:v1:${owner}`);
  const legacyKey = gameplayStorageKey("zhiv.pending-check-in.v2");
  let tail: Promise<void> | undefined;
  let failure: Error | undefined;
  function legacyRemove(expected?: string) {
    try {
      const raw = legacy?.getItem(legacyKey);
      if (raw && (expected === undefined || expected === raw)) {
        const value: unknown = JSON.parse(raw);
        if (isPendingCheckIn(value) && value.ownerPublicId === owner) legacy?.removeItem(legacyKey);
      }
    } catch { /* Only a matching legacy copy is disposable after native commit. */ }
  }
  function enqueue(operation: () => Promise<void>) {
    const next = (tail ?? Promise.resolve()).then(() => {
      if (failure) throw failure;
      return operation();
    }).catch(() => { failure = new Error(CHECK_IN_STORAGE_ERROR); throw failure; });
    tail = next;
    void next.catch(() => {}); // Callers may enqueue a cleanup and await it before the next send.
    return next;
  }
  return {
    owner, native,
    read(now = Date.now()): PendingCheckIn | null {
      try {
        const committed = native?.getItem(key);
        let legacyRaw: string | null | undefined;
        try { legacyRaw = legacy?.getItem(legacyKey); } catch { /* Native storage does not require WebView storage. */ }
        const raw = committed ?? legacyRaw;
        if (!raw) return null;
        let value: unknown;
        try { value = JSON.parse(raw); }
        catch { if (committed != null) throw new Error(CHECK_IN_STORAGE_ERROR); return null; }
        if (!isPendingCheckIn(value) || value.ownerPublicId !== owner) {
          if (committed != null) throw new Error(CHECK_IN_STORAGE_ERROR);
          return null; // A browser's shared legacy key may belong to another account.
        }
        if (value.expiresAt <= now) {
          if (native) void enqueue(async () => { await native.removeItem(key); legacyRemove(raw); });
          else legacyRemove(raw);
          return null;
        }
        return value;
      } catch {
        if (native) { failure = new Error(CHECK_IN_STORAGE_ERROR); throw failure; }
        return null;
      }
    },
    save(value: PendingCheckIn): void | Promise<void> {
      if (!isPendingCheckIn(value) || value.ownerPublicId !== owner) throw new Error("Check-in receipt owner mismatch");
      const raw = JSON.stringify(value);
      if (native) return enqueue(async () => { await native.setItem(key, raw); legacyRemove(raw); });
      try { legacy?.setItem(legacyKey, raw); } catch { /* Browser receipt remains in memory. */ }
    },
    clear(): void | Promise<void> {
      if (native) return enqueue(async () => { await native.removeItem(key); legacyRemove(); });
      legacyRemove();
    },
    settled(): void | Promise<void> {
      if (failure) return Promise.reject(failure);
      return tail;
    },
    error: () => failure?.message ?? null,
  };
}

export type CheckInJournal = ReturnType<typeof createCheckInJournal>;
