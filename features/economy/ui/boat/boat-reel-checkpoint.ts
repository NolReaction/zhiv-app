import { gameplayStorageKey } from "@/lib/gameplay-generation";
import type { BoatChallenge, BoatReelCommand, BoatReelInput } from "@/features/economy/domain/boat-model";
import { initialBoatReel, replayBoatReel, type BoatReelState } from "@/features/economy/domain/boat-reel";

type CheckpointStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;
export const boatReelCheckpointKey = (owner: string, voyageId: string, challengeId: string) => gameplayStorageKey(`zhiv.boat-reel.v1.${owner}.${voyageId}.${challengeId}`);
export const boatReelCheckpointPointer = (owner: string) => gameplayStorageKey(`zhiv.boat-reel.current.${owner}`);
export const boatReelCheckpointPrefix = (owner: string) => gameplayStorageKey(`zhiv.boat-reel.v1.${owner}.`);

/** Keep one attempt per account so repeated fishing cannot fill browser storage. */
export function retainBoatReelCheckpoint(storage: CheckpointStorage | null, owner: string, key: string) {
  try {
    const pointer = boatReelCheckpointPointer(owner), previous = storage?.getItem(pointer);
    if (previous && previous !== key && previous.startsWith(boatReelCheckpointPrefix(owner))) storage?.removeItem(previous);
    storage?.setItem(pointer, key);
  } catch { /* Persistence is optional; the server attempt still exists. */ }
}

export type BoatReelCheckpoint = { reel: BoatReelState; inputs: BoatReelInput[]; hooked?: true; missedBite?: true; reelStartedAt?: number };

/** A malformed native draft must stop restoration, never silently replace evidence. */
export function decodeBoatReelCheckpoint(raw: string, challenge: BoatChallenge): BoatReelCheckpoint | null {
  try {
    if (!raw || raw.length > 30000) return null;
    const saved = JSON.parse(raw) as { reelStartedAt?: number; hooked?: boolean; missedBite?: boolean; challengeId?: string; seed?: number; startedAt?: string; rulesVersion?: number; resistance?: string; fishRarity?: string; motorResponse?: number; hullDamping?: number; endTick?: number; inputs?: BoatReelInput[] };
    if (saved.challengeId !== challenge.id || saved.seed !== challenge.seed || saved.startedAt !== challenge.startedAt
      || (saved.rulesVersion ?? 1) !== challenge.rulesVersion
      || challenge.rulesVersion >= 2 && saved.resistance !== challenge.resistance
      || challenge.rulesVersion >= 3 && saved.fishRarity !== challenge.fishRarity
      || challenge.rulesVersion >= 5 && (saved.motorResponse !== challenge.motorResponse || saved.hullDamping !== challenge.hullDamping)
      || !Array.isArray(saved.inputs) || !Number.isInteger(saved.endTick)) return null;
    const timing = typeof saved.reelStartedAt === "number" && Number.isFinite(saved.reelStartedAt)
      && saved.reelStartedAt >= Date.parse(challenge.biteAt ?? challenge.startedAt) && saved.reelStartedAt < Date.parse(challenge.expiresAt)
      ? { reelStartedAt: saved.reelStartedAt } : {};
    if (saved.missedBite === true) return challenge.rulesVersion >= 6 && saved.endTick === 0 && saved.inputs.length === 0 && !saved.hooked
      ? { reel: initialBoatReel(challenge), inputs: [], missedBite: true } : null;
    if (saved.hooked === true && saved.endTick === 0 && saved.inputs.length === 0)
      return { reel: initialBoatReel(challenge), inputs: [], hooked: true, ...timing };
    const reel = replayBoatReel(challenge, saved.inputs, saved.endTick!);
    return { reel, ...timing, inputs: saved.inputs.map(input => ({ tick: input.tick, held: input.held })) };
  } catch { return null; }
}

/** Local controls only. The server still replays the complete trace before a catch exists. */
export function readBoatReelCheckpoint(storage: CheckpointStorage | null, key: string, challenge: BoatChallenge): BoatReelCheckpoint {
  try {
    const raw = storage?.getItem(key);
    if (raw) { const saved = decodeBoatReelCheckpoint(raw, challenge); if (saved) return saved; }
  } catch { /* Browser checkpoints remain optional. */ }
  return { reel: initialBoatReel(challenge), inputs: [] };
}

export function boatReelSubmission(challenge: BoatChallenge, reel: BoatReelState, inputs: readonly BoatReelInput[]): BoatReelCommand {
  return { challengeId: challenge.id, endTick: reel.tick, inputs: inputs.filter(input => input.tick < reel.tick).map(input => ({ ...input })) };
}

export function encodeBoatReelCheckpoint(challenge: BoatChallenge, reel: BoatReelState, inputs: readonly BoatReelInput[], hooked = false, reelStartedAt?: number, missedBite = false) {
  if (reel.tick < 1 && !hooked && !missedBite) return null;
  return JSON.stringify({ ...boatReelSubmission(challenge, reel, inputs), reelStartedAt, ...(hooked && reel.tick === 0 ? { hooked: true } : {}),
    ...(missedBite ? { missedBite: true } : {}), seed: challenge.seed, startedAt: challenge.startedAt, rulesVersion: challenge.rulesVersion,
    resistance: challenge.resistance, ...(challenge.rulesVersion >= 3 ? { fishRarity: challenge.fishRarity } : {}),
    ...(challenge.rulesVersion >= 5 ? { motorResponse: challenge.motorResponse, hullDamping: challenge.hullDamping } : {}) });
}

export function writeBoatReelCheckpoint(storage: CheckpointStorage | null, key: string, challenge: BoatChallenge, reel: BoatReelState, inputs: readonly BoatReelInput[], hooked = false, reelStartedAt?: number, missedBite = false) {
  const raw = encodeBoatReelCheckpoint(challenge, reel, inputs, hooked, reelStartedAt, missedBite);
  try { if (raw !== null) storage?.setItem(key, raw); } catch { /* Fishing remains playable when browser storage is unavailable. */ }
}

/** Several events within one simulation tick still represent one final button state. */
export function changeBoatReelInput(inputs: BoatReelInput[], tick: number, held: boolean) {
  if (inputs.at(-1)?.tick === tick) inputs.pop();
  if ((inputs.at(-1)?.held ?? false) !== held) inputs.push({ tick, held });
}
