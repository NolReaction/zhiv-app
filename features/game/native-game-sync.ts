import type { ClientJournalStorage } from "@/lib/client-journal-storage";
import { gameplayStorageKey } from "@/lib/gameplay-generation";
import { createGameSession, getGameProgress, submitGameBatch, type GameProgress } from "./game-api";
import { GameSyncClient, type GameSyncSnapshot, type GameTapInput, type GameTransport } from "./game-sync";
import { gameJournalStore, type GameJournal } from "./game-sync-journal";
import { gameInputSchema } from "./game-tab-inbox";

type LegacyStorage = Pick<Storage, "getItem" | "removeItem" | "length" | "key">;
type Options = {
  online: boolean;
  changed: (snapshot: GameSyncSnapshot) => void;
  sessionLost: () => void;
  legacy?: LegacyStorage;
  api?: GameTransport;
  now?: () => number;
  uuid?: () => string;
  wait?: (delay: number, signal: AbortSignal) => Promise<void>;
  wallNow?: () => number;
};
const transport: GameTransport = { progress: getGameProgress, session: createGameSession, batch: submitGameBatch };
const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value));
const aborted = () => new DOMException("Game controller closed", "AbortError");

function parseJournal(owner: string, raw: string | null): GameJournal | null {
  return gameJournalStore(owner, { getItem: () => raw, setItem: () => { throw new Error("Read-only journal"); } }).read();
}

/** One native process owns the tap stream. The existing protocol engine computes
 * a draft only; this coordinator commits it before input acknowledgement, visible
 * counters and every request. A synchronous draft is never reported as durable. */
export async function createNativeGameSync(owner: string, storage: ClientJournalStorage, options: Options) {
  const key = gameplayStorageKey(`zhiv:game-outbox:v1:${owner}`);
  const inputPrefix = gameplayStorageKey(`zhiv:game-input:v1:${owner}:`);
  let stored = storage.getItem(key);
  if (stored === null && options.legacy) {
    const legacy = options.legacy.getItem(key);
    if (legacy !== null) {
      parseJournal(owner, legacy);
      await storage.setItem(key, legacy);
      stored = storage.getItem(key);
      if (stored !== legacy) throw new Error("Journal commit was not acknowledged");
      try { if (options.legacy.getItem(key) === legacy) options.legacy.removeItem(key); } catch { /* SQLite now owns the journal. */ }
    }
  }
  const initial = parseJournal(owner, stored);
  let draft = stored, revision = 0, committedRevision = 0;
  let closing = false, fault = false, importing = true;
  let writes: Promise<void> = Promise.resolve(), inputs: Promise<unknown> = Promise.resolve();
  let inputCount = 0;
  const commits = new Map<number, Promise<void>>();
  let visible: GameSyncSnapshot;

  const fail = () => {
    if (fault) return;
    fault = true;
    engine.dispose();
    visible = { ...visible, status: "error", durable: false, errorCode: "STORAGE_FAILED" };
    if (!closing && !importing) options.changed(clone(visible));
  };
  const check = (signal?: AbortSignal) => {
    if (closing || signal?.aborted) throw aborted();
    if (fault) throw new Error("Не удалось сохранить нажатия на устройстве");
  };
  function commit(): Promise<void> {
    check();
    const current = revision;
    if (current === committedRevision) {
      visible = clone(engine.snapshot());
      if (!closing && !importing) options.changed(clone(visible));
      return Promise.resolve();
    }
    const pending = commits.get(current);
    if (pending) return pending;
    const raw = draft;
    if (raw === null) return Promise.resolve();
    const snapshot = clone(engine.snapshot());
    if (snapshot.durable === false) { fail(); return Promise.reject(new Error("Invalid draft journal")); }
    const operation = writes.then(async () => {
      // Already-enqueued commits may finish during disposal. The next native
      // controller waits for dispose(), so they cannot overwrite a new writer.
      if (fault) throw new Error("Journal is blocked after a failed commit");
      await storage.setItem(key, raw);
      committedRevision = current;
      visible = snapshot;
      if (!closing && !importing) options.changed(clone(visible));
    });
    writes = operation;
    commits.set(current, operation);
    void operation.then(() => commits.delete(current), () => { commits.delete(current); fail(); });
    return operation;
  }
  const dispatch = async <T,>(signal: AbortSignal, request: () => Promise<T>): Promise<T> => {
    await commit();
    check(signal);
    const result = await request();
    check(signal);
    return result;
  };
  const api = options.api ?? transport;
  const engine = new GameSyncClient(owner, false, () => {
    if (engine.snapshot().durable === false) { fail(); return; }
    if (!closing && !importing) void commit().catch(() => {});
  }, () => { closing = true; options.sessionLost(); }, {
    progress: signal => dispatch(signal, () => api.progress(signal)),
    session: (body, signal) => dispatch(signal, () => api.session(body, signal)),
    batch: (body, signal) => dispatch(signal, () => api.batch(body, signal)),
  }, options.now, options.uuid, options.wait, {
    read: () => initial ? clone(initial) : null,
    write(value) {
      if (fault) throw new Error("Journal is blocked");
      const next = JSON.stringify(value);
      if (next.length > 2_000_000 || value.archivedQueues.length > 100) throw new Error("Journal too large");
      if (next !== draft) { draft = next; revision += 1; }
    },
  }, options.wallNow);
  visible = clone(engine.snapshot());

  try {
    // Import old same-owner, same-generation WebView input with durable receipts.
    // A crash before deletion replays the receipt, never the tap itself.
    if (options.legacy) {
      const keys: string[] = [];
      for (let index = 0; index < options.legacy.length; index++) {
        const inputKey = options.legacy.key(index);
        if (inputKey?.startsWith(inputPrefix)) keys.push(inputKey);
        if (keys.length > 30_000) throw new Error("Input journal too large");
      }
      const legacyInputs = keys.flatMap(inputKey => {
        const raw = options.legacy!.getItem(inputKey);
        if (raw === null) return [];
        const input = gameInputSchema.parse(JSON.parse(raw));
        if (input.ownerPublicId !== owner || inputKey !== inputPrefix + input.id) throw new Error("Input owner mismatch");
        return [{ key: inputKey, raw, input }];
      }).sort((a, b) => a.input.capturedAt - b.input.capturedAt || a.input.id.localeCompare(b.input.id));
      for (let start = 0; start < legacyInputs.length; start += 128) {
        const batch = legacyInputs.slice(start, start + 128);
        for (const { input } of batch) if (!engine.importInput(input as GameTapInput)) throw new Error("Could not preserve legacy input");
        await commit();
        for (const row of batch) {
          // Failed cleanup keeps the input receipt in the SQLite journal.
          try {
            if (options.legacy.getItem(row.key) === row.raw) options.legacy.removeItem(row.key);
            if (options.legacy.getItem(row.key) === null) engine.forgetInput(row.input.id);
          } catch { /* A later open retries deletion using the persisted receipt. */ }
        }
        await commit();
      }
    }
    importing = false;
    engine.setOnline(options.online);
    await commit();
    options.changed(clone(visible));
  } catch (error) {
    closing = true;
    engine.dispose();
    await writes.catch(() => {});
    throw error;
  }

  return {
    snapshot: () => clone(visible),
    recordTap(steps: number, runId: string, capturedAt = Date.now()): Promise<number> {
      if (closing || fault || inputCount >= 128 || !Number.isSafeInteger(capturedAt) || capturedAt < 0) return Promise.resolve(0);
      inputCount += 1;
      const operation = inputs.then(async () => {
        check();
        const count = engine.recordTap(steps, runId, capturedAt);
        await commit();
        check();
        return count;
      }).catch(() => 0).finally(() => { inputCount -= 1; });
      inputs = operation;
      return operation;
    },
    setOnline(online: boolean) { if (!closing && !fault) engine.setOnline(online); },
    adoptProgress(progress: GameProgress) { if (!closing && !fault) engine.adoptProgress(progress); },
    async flush() {
      if (closing || fault) return;
      await inputs;
      try { await commit(); await engine.flush(); if (!closing) await commit(); } catch { /* Commit failure is visible and blocks dispatch. */ }
    },
    async refresh() {
      if (closing || fault) return;
      try { await commit(); await engine.refresh(); if (!closing) await commit(); } catch { /* The last committed state remains readable. */ }
    },
    async dispose() {
      if (!closing) { closing = true; engine.dispose(); }
      await inputs.catch(() => {});
      await writes.catch(() => {});
    },
  };
}

export type NativeGameSync = Awaited<ReturnType<typeof createNativeGameSync>>;
