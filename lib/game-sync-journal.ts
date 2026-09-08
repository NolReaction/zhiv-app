import { z } from "zod";
import { gameProgressSchema, gameSessionSchema } from "@/lib/game-api";

const count = z.number().int().safe().nonnegative();
const times = z.array(count).max(60);
export const gameJournalSchema = z.object({
  version: z.literal(1), ownerPublicId: z.string(), savedAt: count,
  progress: gameProgressSchema.nullable(), session: gameSessionSchema.nullable(),
  run: z.object({ runId: z.string().uuid(), acceptedTaps: count, rejectedTaps: count, interrupted: z.boolean() }).nullable(),
  queue: z.array(z.object({ runId: z.string().uuid(), count: count.min(1).max(60), times: times.optional() })
    .refine(value => !value.times || value.times.length === value.count)).max(30000),
  pendingBatch: z.object({ sessionId: z.string().uuid(), sequence: count.min(1), tapCount: count.min(1).max(60),
    runId: z.string().uuid(), tapTimes: times.optional() }).refine(value => !value.tapTimes || value.tapTimes.length === value.tapCount).nullable(),
  startRequest: z.object({ requestId: z.string().uuid(), ownerPublicId: z.string() }).nullable(),
  recordingStopped: z.boolean().default(false), lastEventAt: count.default(0),
  rejectedTaps: count, serverOffset: z.number().finite(), retryAfter: count, retryRemaining: count.max(3600000).default(0),
}).refine(value => value.queue.reduce((sum, item) => sum + item.count, value.pendingBatch?.tapCount ?? 0) <= 30000);
export type GameJournal = z.infer<typeof gameJournalSchema>;
export interface GameJournalStore { read(): GameJournal | null; write(value: GameJournal): void }

/** Temporary delivery journal only. Account totals always come from the API. */
export function gameJournalStore(owner: string, storage: Pick<Storage, "getItem" | "setItem"> = localStorage): GameJournalStore {
  const key = `zhiv:game-outbox:v1:${owner}`;
  return {
    read() {
      const raw = storage.getItem(key);
      if (!raw) return null;
      if (raw.length > 2_000_000) throw new Error("Journal too large");
      const data = gameJournalSchema.parse(JSON.parse(raw));
      if (data.ownerPublicId !== owner || data.progress && data.progress.ownerPublicId !== owner
        || data.session && data.session.progress.ownerPublicId !== owner || data.startRequest && data.startRequest.ownerPublicId !== owner) throw new Error("Journal owner mismatch");
      return data;
    },
    write(value) { storage.setItem(key, JSON.stringify(value)); },
  };
}
