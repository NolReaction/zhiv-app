import type { AudioEvent } from "@/features/audio/domain/types";
import type { createGameRewardsSession } from "./game-rewards-session";

type DailyClaimSession = Pick<ReturnType<typeof createGameRewardsSession>, "claimDaily">;

/** A direct manual claim owns its sound. Reads, restored receipts and recovery
 * never pass through this path. The shared session validates the request and
 * active account before returning; the UI mixer consumes muted/hidden events. */
export async function claimDailyWithAudio(
  ownerPublicId: string | null,
  session: DailyClaimSession,
  play: (event: AudioEvent) => void,
  now = Date.now,
) {
  const result = await session.claimDaily();
  if (result && ownerPublicId && !result.replayed && result.claim.kind === "daily"
    && result.rewards.ownerPublicId === ownerPublicId && result.economy.ownerPublicId === ownerPublicId) {
    try {
      play({ id: `daily-reward:${ownerPublicId}:${result.requestId}`, cueId: "ui.daily-reward", occurredAt: now() });
    } catch { /* Optional playback must never block the confirmed wallet refresh. */ }
  }
  return result;
}
