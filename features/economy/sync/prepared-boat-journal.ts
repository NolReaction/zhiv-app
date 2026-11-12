import { z } from "zod";
import { gameplayStorageKey } from "@/lib/gameplay-generation";
import { BOAT_CAST_CYCLE_MS } from "@/features/economy/domain/boat-cast-aim";
import { BOAT_HOOK_WINDOW_MS, boatChallengeSchema, boatReelCommandSchema, type BoatReelCommand, type BoatVoyage } from "@/features/economy/domain/boat-model";
import { replayBoatReel } from "@/features/economy/domain/boat-reel";
import { startPreparedBoatCast } from "@/features/economy/domain/boat-prepared-cast";
import { economyCommandSchema } from "@/features/economy/domain/model";

const entrySchema = z.object({
  voyageId: z.uuid(), castNumber: z.number().int().min(1).max(11),
  castHeldMs: z.number().int().min(0).max(BOAT_CAST_CYCLE_MS), challenge: boatChallengeSchema,
  reel: boatReelCommandSchema.optional(), command: economyCommandSchema.optional(),
}).strict();
export type PreparedBoatEntry = z.infer<typeof entrySchema>;
export const preparedBoatJournalKey = (owner: string) => gameplayStorageKey(`zhiv:economy:boat-journal:v1:${owner}`);

export function parsePreparedBoatEntries(raw: string | null, owner: string): PreparedBoatEntry[] {
  if (!raw || raw.length > 256_000) return [];
  try {
    const record = z.object({ owner: z.literal(owner), version: z.literal(1), entries: z.array(entrySchema).max(2) }).strict().parse(JSON.parse(raw));
    const valid = record.entries.every((entry, index) => {
      const { reel, command, challenge } = entry;
      if (index > 0) {
        const last = record.entries[index - 1];
        if (!last.reel || entry.voyageId !== last.voyageId || entry.castNumber !== last.castNumber + 1 || challenge.id === last.challenge.id) return false;
      }
      if (reel && (reel.challengeId !== challenge.id || !reel.deferred || reel.prepared?.castNumber !== entry.castNumber
        || reel.prepared.startedAt !== challenge.startedAt || reel.prepared.castHeldMs !== entry.castHeldMs
        || preparedBoatOutcome(entry.challenge, reel) === null)) return false;
      return !command || index === 0 && !!reel && command.ownerPublicId === owner && command.targetId === entry.voyageId
        && command.action === "submit_boat_cast" && command.quantity === 1 && command.totalPrice === 0
        && JSON.stringify(command.reel) === JSON.stringify(reel);
    });
    return valid ? record.entries : [];
  } catch { return []; }
}

const outcomes = new WeakMap<BoatReelCommand, "caught" | "escaped" | null>();

export function preparedBoatOutcome(challenge: PreparedBoatEntry["challenge"], reel: BoatReelCommand): "caught" | "escaped" | null {
  if (challenge.id !== reel.challengeId) return null;
  if (reel.missedBite) return reel.endTick === 0 && !reel.inputs.length ? "escaped" : null;
  if (outcomes.has(reel)) return outcomes.get(reel) ?? null;
  try {
    const result = replayBoatReel(challenge, reel.inputs, reel.endTick);
    const terminal = result.status === "active" ? null : result.status;
    outcomes.set(reel, terminal);
    return terminal;
  } catch { return null; }
}

export function projectPreparedBoat(voyage: BoatVoyage | undefined, entries: readonly PreparedBoatEntry[], now: number,
  settledChallengeId?: string, legacyCaught = false) {
  const outstanding = entries.filter(entry => entry.voyageId === voyage?.id && entry.castNumber > voyage.castsUsed);
  const last = outstanding.at(-1);
  const active = last && !last.reel ? last : undefined;
  const localBoatCatches = outstanding.filter(entry => entry.reel && preparedBoatOutcome(entry.challenge, entry.reel) === "caught").length;
  const localBoatVoyage = voyage && last ? { ...voyage, castsUsed: last.castNumber, challenge: active?.challenge } : undefined;
  const count = last?.castNumber ?? voyage?.castsUsed;
  const template = voyage?.preparedCasts?.find(slot => slot.castNumber === (count ?? 0) + 1);
  const legacyActive = voyage?.challenge && voyage.challenge.id !== settledChallengeId;
  const next = voyage && template && !voyage.returnStartedAt && !legacyActive && !active && entries.length < 2 && outstanding.length === entries.length
    && voyage.catches.length + localBoatCatches + Number(legacyCaught) < voyage.maxCatches
    && now >= Date.parse(voyage.arrivesAt) && Date.parse(voyage.fishingUntil) - now >= template.biteDelayMs + BOAT_HOOK_WINDOW_MS
    ? startPreparedBoatCast(template, Math.floor(now), voyage.fishingUntil) : null;
  return { localBoatVoyage, localBoatCatches, preparedBoatChallengeId: active?.challenge.id, next, template };
}
