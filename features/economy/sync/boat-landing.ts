import { economyCommandSchema, type EconomyCommand, type EconomyView } from "@/features/economy/domain/model";
import type { BoatReelCommand } from "@/features/economy/domain/boat-model";

export function isBoatLanding(command: EconomyCommand): command is EconomyCommand & { reel: BoatReelCommand } {
  return command.action === "submit_boat_cast" && command.reel?.deferred === true;
}

export function sameBoatAttempt(snapshot: EconomyView, command: EconomyCommand) {
  const voyage = snapshot.boat?.voyage;
  return isBoatLanding(command) && snapshot.ownerPublicId === command.ownerPublicId && voyage?.id === command.targetId
    && voyage.challenge?.id === command.reel.challengeId;
}

/** Only an issued attempt's input trace is recoverable. The server owns the fish. */
export function restoreBoatLanding(raw: string | null, owner: string) {
  if (!raw || raw.length > 32_000) return null;
  try {
    const parsed = economyCommandSchema.safeParse(JSON.parse(raw));
    return parsed.success && parsed.data.ownerPublicId === owner && isBoatLanding(parsed.data) ? parsed.data : null;
  } catch {
    return null;
  }
}
