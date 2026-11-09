import { economyCatalog, type EconomyView } from "@/features/economy/domain/model";
import type { FishingStandings, FishingVisibility } from "@/features/economy/sync/boat-records-model";
import type { GameLeaderboardScope, GameVisibilityRequest } from "@/features/game/game-api";
import { getDevFriendPublicIds, getDevIdentity, lookupDevUser } from "./api-store";
import { getDevEconomy } from "./economy-store";
import { devGameStore } from "./game-state";
import type { DevGameResult } from "./game-store";

type Participant = FishingVisibility & { weights: Record<string, number> };
type PublicationStore = WeakMap<ReturnType<typeof devGameStore>, Map<string, Participant>>;
const shared = globalThis as typeof globalThis & { __zhivDevFishingPublications?: PublicationStore };

function publications(): Map<string, Participant> {
  const stores: PublicationStore = shared.__zhivDevFishingPublications ??= new WeakMap();
  const game = devGameStore();
  let participants = stores.get(game);
  if (!participants) { participants = new Map<string, Participant>(); stores.set(game, participants); }
  return participants;
}

function confirmedWeights(state: EconomyView) {
  return Object.fromEntries(Object.entries(state.boat?.records ?? {}).map(([fishId, record]) => [fishId, record.weightGrams]));
}

/** The local authority publishes a projection of the already committed claim snapshot. */
export function publishDevFishingRecords(state: EconomyView) {
  const player = publications().get(state.ownerPublicId);
  if (player?.leaderboardOptIn) player.weights = confirmedWeights(state);
}

export function updateDevFishingVisibility(token: string | undefined, input: GameVisibilityRequest): DevGameResult<FishingVisibility> {
  const identity = getDevIdentity(token);
  if (!identity) return { kind: "error", code: "UNAUTHORIZED" };
  if (identity.user.publicId !== input.ownerPublicId) return { kind: "error", code: "GAME_OWNER_CHANGED" };
  const members = publications();
  const version = members.get(input.ownerPublicId)?.visibilityVersion ?? 0;
  if (version !== input.expectedVersion) {
    if (version !== input.expectedVersion + 1 || members.get(input.ownerPublicId)?.leaderboardOptIn !== input.leaderboardOptIn)
      return { kind: "error", code: "GAME_VISIBILITY_CONFLICT" };
  } else {
    const weights = input.leaderboardOptIn ? confirmedWeights(getDevEconomy(token)) : {};
    members.set(input.ownerPublicId, { ownerPublicId: input.ownerPublicId, leaderboardOptIn: input.leaderboardOptIn, visibilityVersion: version + 1, weights });
  }
  return { kind: "ok", value: { ownerPublicId: input.ownerPublicId, leaderboardOptIn: input.leaderboardOptIn,
    visibilityVersion: members.get(input.ownerPublicId)!.visibilityVersion } };
}

export function getDevFishingRecords(token: string | undefined, scope: GameLeaderboardScope): DevGameResult<FishingStandings> {
  const identity = getDevIdentity(token);
  if (!identity) return { kind: "error", code: "UNAUTHORIZED" };
  const ownerPublicId = identity.user.publicId;
  const profiles = publications();
  const own = profiles.get(ownerPublicId);
  const friends = scope === "friends" ? new Set([ownerPublicId, ...(getDevFriendPublicIds(token) ?? [])]) : null;
  const entries = new Map<string, FishingStandings["entries"][number]>();
  // Stable representative of a tie: self if present, otherwise the lowest public ID.
  const participants = [...profiles.values()].filter(player => player.leaderboardOptIn && (!friends || friends.has(player.ownerPublicId)))
    .sort((a, b) => a.ownerPublicId.localeCompare(b.ownerPublicId, "en"));
  const species = economyCatalog.boat?.weights ?? {};
  for (const player of participants) {
    const user = lookupDevUser(token, player.ownerPublicId);
    if (user.kind !== "ok") continue;
    const isMe = player.ownerPublicId === ownerPublicId;
    for (const [fishId, grams] of Object.entries(player.weights)) {
      if (!Object.hasOwn(species, fishId)) continue;
      const leader = entries.get(fishId);
      if (!leader || grams > leader.weightGrams) {
        entries.set(fishId, { fishId, weightGrams: grams, displayName: user.value.user.displayName, isMe, tiedCount: 1 });
      } else if (grams === leader.weightGrams) {
        leader.tiedCount++;
        if (isMe) { leader.displayName = user.value.user.displayName; leader.isMe = true; }
      }
    }
  }
  return { kind: "ok", value: { ownerPublicId, scope, entries: [...entries.values()].sort((a, b) => a.fishId.localeCompare(b.fishId)),
    leaderboardOptIn: own?.leaderboardOptIn ?? false, visibilityVersion: own?.visibilityVersion ?? 0 } };
}
