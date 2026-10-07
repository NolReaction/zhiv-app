import { ApiError } from "@/lib/check-in-api";
import { createCapabilityToken, isCapabilityToken } from "@/lib/capability-token";
import { normalizeRecoveryCode } from "@/lib/recovery-code";

export const RECOVERY_ATTEMPT_KEY = "zhiv:recovery-attempts:v1";
export const RECOVERY_ATTEMPT_TTL_MS = 10 * 60_000;
const MAX_ATTEMPTS = 3;
type AttemptStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;
type Receipt = { fingerprint: string; retrySecret: string; createdAt: number };
export type RecoveryAttempt = { retrySecret: string; createdAt: number; persisted: boolean };
type MemoryAttempt = RecoveryAttempt & { code: string; fingerprint: string | null };

export function recoveryAttemptStorage(): AttemptStorage | undefined {
  try { return typeof window === "undefined" ? undefined : window.sessionStorage; }
  catch { return undefined; }
}

async function codeFingerprint(code: string): Promise<string | null> {
  try {
    if (!globalThis.crypto?.subtle) return null;
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(code));
    return Array.from(new Uint8Array(digest), value => value.toString(16).padStart(2, "0")).join("");
  } catch { return null; }
}

/** A short-lived receipt, never a stored recovery code or automatic login. */
export function createRecoveryAttemptStore(storage?: AttemptStorage, now = Date.now, fingerprint = codeFingerprint) {
  let memory: MemoryAttempt[] = [];
  const fresh = (createdAt: number) => Number.isSafeInteger(createdAt) && createdAt >= 0
    && createdAt <= now() && now() - createdAt < RECOVERY_ATTEMPT_TTL_MS;
  function save(receipts: Receipt[]): boolean {
    if (!storage) return false;
    try {
      if (receipts.length) storage.setItem(RECOVERY_ATTEMPT_KEY, JSON.stringify({ version: 1, attempts: receipts }));
      else storage.removeItem(RECOVERY_ATTEMPT_KEY);
      return true;
    } catch { return false; }
  }
  function read(): Receipt[] {
    memory = memory.filter(attempt => fresh(attempt.createdAt));
    if (!storage) return [];
    try {
      const raw = storage.getItem(RECOVERY_ATTEMPT_KEY);
      if (!raw) return [];
      const value: unknown = JSON.parse(raw);
      if (!value || typeof value !== "object" || !("version" in value) || value.version !== 1
        || !("attempts" in value) || !Array.isArray(value.attempts) || value.attempts.length > MAX_ATTEMPTS) {
        save([]); return [];
      }
      const receipts: Receipt[] = [];
      for (const row of value.attempts) {
        if (!row || typeof row !== "object" || typeof row.fingerprint !== "string"
          || !/^[a-f0-9]{64}$/.test(row.fingerprint) || typeof row.retrySecret !== "string"
          || !isCapabilityToken(row.retrySecret) || typeof row.createdAt !== "number"
          || Object.keys(row).some(key => !["fingerprint", "retrySecret", "createdAt"].includes(key))) {
          save([]); return [];
        }
        if (fresh(row.createdAt) && !receipts.some(attempt => attempt.fingerprint === row.fingerprint)) {
          receipts.push({ fingerprint: row.fingerprint, retrySecret: row.retrySecret, createdAt: row.createdAt });
        }
      }
      if (receipts.length !== value.attempts.length) save(receipts);
      return receipts;
    } catch { save([]); return []; }
  }
  return {
    prune: read,
    async prepare(rawCode: string): Promise<RecoveryAttempt> {
      const code = normalizeRecoveryCode(rawCode);
      if (!code) throw new Error("Проверьте код восстановления");
      const digest = await fingerprint(code);
      const receipts = read();
      const cached = digest ? receipts.find(attempt => attempt.fingerprint === digest) : undefined;
      const previous = cached ?? memory.find(attempt => attempt.code === code);
      const attempt: MemoryAttempt = { code, fingerprint: digest,
        retrySecret: previous?.retrySecret ?? createCapabilityToken(), createdAt: previous?.createdAt ?? now(), persisted: false };
      if (digest) {
        const next = receipts.filter(row => row.fingerprint !== digest);
        next.push({ fingerprint: digest, retrySecret: attempt.retrySecret, createdAt: attempt.createdAt });
        attempt.persisted = save(next.slice(-MAX_ATTEMPTS));
      }
      memory = [...memory.filter(row => row.code !== code), attempt].slice(-MAX_ATTEMPTS);
      return { retrySecret: attempt.retrySecret, createdAt: attempt.createdAt, persisted: attempt.persisted };
    },
    clear(attempt: RecoveryAttempt) {
      memory = memory.filter(row => row.retrySecret !== attempt.retrySecret);
      save(read().filter(row => row.retrySecret !== attempt.retrySecret));
    },
  };
}

export function recoveryAttemptRejected(error: unknown): boolean {
  return error instanceof ApiError && (error.body?.code === "INVALID_CODE" && [400, 401].includes(error.status)
    || error.status === 403 && error.body?.code === "ACCOUNT_BANNED");
}
