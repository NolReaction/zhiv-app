import type { EconomyCommand, EconomyResult, EconomyView } from "./model";
import { getPlayerLevel } from "./player-levels";

export type PlayerXpGain = Readonly<{
  id: string; ownerPublicId: string; revision: number; xp: number;
  fromLevel: number; toLevel: number;
}>;
export const PLAYER_XP_GAIN_HISTORY_LIMIT = 8;
const awardedActions = new Set<EconomyCommand["action"]>([
  "claim_job", "claim_mining_batch", "claim_production", "claim_garden_collection", "complete_resident_order",
  "load_ship_cargo", "complete_ship_order", "claim_ship_voyage",
]);

/** Called only for an in-memory local intent, never for a restored receipt or GET. */
export function playerXpGainFromReceipt(before: EconomyView, result: EconomyResult, command: EconomyCommand): PlayerXpGain | null {
  const after = result.state, previousXp = before.progression?.player?.xp ?? 0, nextXp = after.progression?.player?.xp ?? 0;
  if (!awardedActions.has(command.action) || before.ownerPublicId !== after.ownerPublicId || command.ownerPublicId !== after.ownerPublicId
    || command.expectedRevision !== before.revision || result.acceptedRevision !== before.revision + 1
    || after.revision !== result.acceptedRevision || !Number.isSafeInteger(previousXp) || !Number.isSafeInteger(nextXp)
    || previousXp < 0 || nextXp <= previousXp) return null;
  return Object.freeze({ id: command.requestId, ownerPublicId: after.ownerPublicId, revision: result.acceptedRevision,
    xp: nextXp - previousXp, fromLevel: getPlayerLevel(previousXp).level, toLevel: getPlayerLevel(nextXp).level });
}
