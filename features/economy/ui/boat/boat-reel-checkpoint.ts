import type { BoatChallenge, BoatReelCommand, BoatReelInput } from "@/features/economy/domain/boat-model";
import { initialBoatReel, replayBoatReel, type BoatReelState } from "@/features/economy/domain/boat-reel";

type CheckpointStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;
export const boatReelCheckpointKey = (owner: string, voyageId: string, challengeId: string) => `zhiv.boat-reel.v1.${owner}.${voyageId}.${challengeId}`;

/** Keep one attempt per account so repeated fishing cannot fill browser storage. */
export function retainBoatReelCheckpoint(storage: CheckpointStorage | null, owner: string, key: string) {
  try {
    const pointer = `zhiv.boat-reel.current.${owner}`, previous = storage?.getItem(pointer);
    if (previous && previous !== key && previous.startsWith(`zhiv.boat-reel.v1.${owner}.`)) storage?.removeItem(previous);
    storage?.setItem(pointer, key);
  } catch { /* Persistence is optional; the server attempt still exists. */ }
}

/** Local controls only. The server still replays the complete trace before a catch exists. */
export function readBoatReelCheckpoint(storage: CheckpointStorage | null, key: string, challenge: BoatChallenge): { reel: BoatReelState; inputs: BoatReelInput[] } {
  const empty = () => ({ reel: initialBoatReel(challenge), inputs: [] });
  try {
    const raw = storage?.getItem(key);
    if (!raw || raw.length > 30000) return empty();
    const saved = JSON.parse(raw) as { challengeId?: string; seed?: number; startedAt?: string; rulesVersion?: number; resistance?: string; fishRarity?: string; endTick?: number; inputs?: BoatReelInput[] };
    if (saved.challengeId !== challenge.id || saved.seed !== challenge.seed || saved.startedAt !== challenge.startedAt
      || (saved.rulesVersion ?? 1) !== challenge.rulesVersion
      || challenge.rulesVersion >= 2 && saved.resistance !== challenge.resistance
      || challenge.rulesVersion === 3 && saved.fishRarity !== challenge.fishRarity
      || !Array.isArray(saved.inputs) || !Number.isInteger(saved.endTick)) return empty();
    const reel = replayBoatReel(challenge, saved.inputs, saved.endTick!);
    return { reel, inputs: saved.inputs.map(input => ({ tick: input.tick, held: input.held })) };
  } catch { return empty(); }
}

export function boatReelSubmission(challenge: BoatChallenge, reel: BoatReelState, inputs: readonly BoatReelInput[]): BoatReelCommand {
  return { challengeId: challenge.id, endTick: reel.tick, inputs: inputs.filter(input => input.tick < reel.tick).map(input => ({ ...input })) };
}

export function writeBoatReelCheckpoint(storage: CheckpointStorage | null, key: string, challenge: BoatChallenge, reel: BoatReelState, inputs: readonly BoatReelInput[]) {
  if (reel.tick < 1) return;
  try { storage?.setItem(key, JSON.stringify({ ...boatReelSubmission(challenge, reel, inputs), seed: challenge.seed, startedAt: challenge.startedAt, rulesVersion: challenge.rulesVersion, resistance: challenge.resistance, ...(challenge.rulesVersion === 3 ? { fishRarity: challenge.fishRarity } : {}) })); } catch { /* Fishing remains playable when browser storage is unavailable. */ }
}

/** Several events within one simulation tick still represent one final button state. */
export function changeBoatReelInput(inputs: BoatReelInput[], tick: number, held: boolean) {
  if (inputs.at(-1)?.tick === tick) inputs.pop();
  if ((inputs.at(-1)?.held ?? false) !== held) inputs.push({ tick, held });
}
