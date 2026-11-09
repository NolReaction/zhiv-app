import { economyCatalog } from "@/features/economy/domain/model";
import type { FishingStandings, FishingVisibility } from "@/features/economy/sync/boat-records-model";
import type { GameLeaderboardScope, GameVisibilityRequest } from "@/features/game/game-api";
import { getDevFriendPublicIds, getDevIdentity, lookupDevUser } from "./api-store";
import { devFishingRecordWeights } from "./economy-store";
import type { DevGameResult } from "./game-store";

/** Older clients can still complete their settings request; confirmed records are ranked automatically. */
export function updateDevFishingVisibility(token: string | undefined, input: GameVisibilityRequest): DevGameResult<FishingVisibility> {
  const identity = getDevIdentity(token);
  if (!identity) return { kind: "error", code: "UNAUTHORIZED" };
  if (identity.user.publicId !== input.ownerPublicId) return { kind: "error", code: "GAME_OWNER_CHANGED" };
  return { kind: "ok", value: { ownerPublicId: input.ownerPublicId, leaderboardOptIn: true, visibilityVersion: 0 } };
}

export function getDevFishingRecords(token: string | undefined, scope: GameLeaderboardScope): DevGameResult<FishingStandings> {
  const identity = getDevIdentity(token);
  if (!identity) return { kind: "error", code: "UNAUTHORIZED" };
  const ownerPublicId = identity.user.publicId;
  const friends = scope === "friends" ? new Set([ownerPublicId, ...(getDevFriendPublicIds(token) ?? [])]) : null;
  const entries = new Map<string, FishingStandings["entries"][number] & { holderId: string }>();
  const species = economyCatalog.boat?.weights ?? {};
  const names = new Map<string, string | null>();
  for (const row of devFishingRecordWeights()) {
    if ((friends && !friends.has(row.ownerPublicId)) || !Object.hasOwn(species, row.fishId)) continue;
    if (!names.has(row.ownerPublicId)) {
      const found = lookupDevUser(token, row.ownerPublicId);
      names.set(row.ownerPublicId, found.kind === "ok" ? found.value.user.displayName : null);
    }
    const displayName = names.get(row.ownerPublicId);
    if (!displayName) continue;
    const leader = entries.get(row.fishId);
    const isMe = row.ownerPublicId === ownerPublicId;
    if (!leader || row.weightGrams > leader.weightGrams) {
      entries.set(row.fishId, { fishId: row.fishId, weightGrams: row.weightGrams, displayName, holderId: row.ownerPublicId, isMe, tiedCount: 1 });
    } else if (row.weightGrams === leader.weightGrams) {
      leader.tiedCount++;
      if (isMe || (!leader.isMe && row.ownerPublicId < leader.holderId)) {
        leader.displayName = displayName; leader.holderId = row.ownerPublicId; leader.isMe = isMe;
      }
    }
  }
  return { kind: "ok", value: { ownerPublicId, scope, leaderboardOptIn: true, visibilityVersion: 0,
    entries: [...entries.values()].sort((a, b) => a.fishId.localeCompare(b.fishId))
      .map(({ fishId, weightGrams, displayName, tiedCount, isMe }) => ({ fishId, weightGrams, displayName, tiedCount, isMe })) } };
}
