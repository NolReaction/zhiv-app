import { z } from "zod";
import { createUuidV4 } from "@/lib/browser-uuid";
import { gameJournalStore } from "@/features/game/game-sync-journal";
import { GameSyncClient, type GameTapInput, type GameSyncSnapshot } from "@/features/game/game-sync";

const inputSchema = z.object({ id: z.string().uuid(), ownerPublicId: z.string(), runId: z.string().uuid(),
  count: z.number().int().min(1).max(60), capturedAt: z.number().int().safe().nonnegative() });
type InboxStorage = Pick<Storage, "getItem" | "setItem" | "removeItem" | "key" | "length">;

/** Every key is immutable and unique: two tabs never overwrite each other's taps. */
export function gameTabInbox(owner: string, storage: InboxStorage = localStorage) {
  const prefix = `zhiv:game-input:v1:${owner}:`;
  const journal = gameJournalStore(owner, storage);
  const list = () => {
    const keys: string[] = [];
    for (let index = 0; index < storage.length; index++) {
      const key = storage.key(index);
      if (key?.startsWith(prefix)) keys.push(key);
    }
    return keys.flatMap(key => {
      const raw = storage.getItem(key);
      if (!raw) return [];
      const input = inputSchema.parse(JSON.parse(raw));
      if (input.ownerPublicId !== owner || key !== prefix + input.id) throw new Error("Input owner mismatch");
      return [input];
    }).sort((a, b) => a.capturedAt - b.capturedAt || a.id.localeCompare(b.id));
  };
  return {
    prefix,
    record(count: number, runId: string, capturedAt = Date.now()): number {
      const saved = journal.read();
      const imported = new Set(saved?.inputReceipts ?? []);
      const queued = [...(saved?.queue ?? []), ...(saved?.deferredQueue ?? [])]
        .reduce((sum, item) => sum + item.count, saved?.pendingBatch?.tapCount ?? 0);
      const pending = list().reduce((sum, item) => sum + (imported.has(item.id) ? 0 : item.count), queued);
      if (pending + count > 30000) return 0;
      const input = inputSchema.parse({ id: createUuidV4(), ownerPublicId: owner, runId, count, capturedAt });
      storage.setItem(prefix + input.id, JSON.stringify(input));
      return count;
    },
    drain(client: GameSyncClient): boolean {
      const inputs = list();
      // Yield between bounded slices after a long offline interval. Renewals,
      // rendering and fresh input must not wait for thousands of storage writes.
      for (const input of inputs.slice(0, 128)) {
        // Recheck after enumeration; a previous owner may have finished before handoff.
        if (storage.getItem(prefix + input.id) === null) continue;
        if (!client.importInput(input)) return false;
        storage.removeItem(prefix + input.id);
        client.forgetInput(input.id);
      }
      // Recover a crash between removing an input and pruning its receipt.
      for (const id of journal.read()?.inputReceipts ?? []) {
        if (storage.getItem(prefix + id) === null) client.forgetInput(id);
      }
      return inputs.length > 128;
    },
    snapshot(online: boolean, runId?: string, current?: GameSyncClient | null): GameSyncSnapshot {
      // A reader is never disposed or flushed: constructing a snapshot cannot write.
      const storageFailed = current?.snapshot().durable === false;
      const reader = (!storageFailed && current) || new GameSyncClient(owner, online, () => {}, () => {}, undefined,
        undefined, undefined, undefined, journal);
      const saved = journal.read();
      const imported = new Set(saved?.inputReceipts ?? []);
      const inputs: GameTapInput[] = list().filter(input => !imported.has(input.id));
      const state = reader.snapshot(runId);
      const pending = inputs.reduce((sum, item) => sum + item.count, 0);
      const runPending = inputs.reduce((sum, item) => sum + (item.runId === runId ? item.count : 0), 0);
      return { ...state, pendingTaps: state.pendingTaps + pending,
        ...(storageFailed ? { durable: false, errorCode: "STORAGE_FAILED" } : {}),
        status: storageFailed ? "error" : !online ? "offline" : pending && (state.status === "ready" || state.status === "loading") ? "syncing" : state.status,
        run: runId ? { runId, acceptedTaps: 0, rejectedTaps: 0, interrupted: false, ...state.run,
          pendingTaps: (state.run?.pendingTaps ?? 0) + runPending } : state.run };
    },
  };
}
