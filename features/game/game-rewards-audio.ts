import type { AudioEvent } from "@/features/audio/domain/types";
import type { createGameRewardsSession } from "./game-rewards-session";
import type { GameAchievementId } from "./game-api";

type DailyClaimSession = Pick<ReturnType<typeof createGameRewardsSession>, "claimDaily">;
type AchievementClaimSession = Pick<ReturnType<typeof createGameRewardsSession>, "claimAchievement">;

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

/** Achievement pearls use the same confirmed-claim path in both profiles. */
export async function claimAchievementWithAudio(
  ownerPublicId: string | null,
  session: AchievementClaimSession,
  achievementId: GameAchievementId,
  level: number,
  play: (event: AudioEvent) => void,
  now = Date.now,
) {
  const result = await session.claimAchievement(achievementId, level);
  if (result && ownerPublicId && !result.replayed && result.claim.kind === "achievement"
    && result.claim.achievementId === achievementId && result.claim.level === level && result.claim.reward.pearls > 0
    && result.rewards.ownerPublicId === ownerPublicId && result.economy.ownerPublicId === ownerPublicId) {
    try {
      play({ id: `achievement-reward:${ownerPublicId}:${result.requestId}`, cueId: "ui.reward", occurredAt: now() });
    } catch { /* Optional playback cannot prevent a confirmed reward refresh. */ }
  }
  return result;
}
