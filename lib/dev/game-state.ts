type Receipt = {
  sequence: number;
  tapTimes?: number[];
  rejectionCode?: string | null;
  tapCount: number;
  runId: string;
  acceptedTaps: number;
  rejectedTaps: number;
};
type GameSessionRecord = {
  id: string;
  ownerPublicId: string;
  authToken: string;
  month: string;
  createdAt: number;
  closedAt: number | null;
  eventTokens: number;
  eventAt: number;
  expiresAt: number;
  nextSequence: number;
  lastReceipt: Receipt | null;
  continuationClaimed: boolean;
  currentRun: { id: string; taps: number; lastAcceptedAt: number } | null;
};
export type GameProfileRecord = {
  ownerPublicId: string;
  lifetimeTaps: number;
  bestSeries: number;
  leaderboardOptIn: boolean;
  visibilityVersion: number;
  monthlyTaps: Map<string, { taps: number; updatedAt: number }>;
  tokens: number;
  refilledAt: number;
  writerId?: string;
  writerUntil?: number;
};
type GameStore = {
  profiles: Map<string, GameProfileRecord>;
  sessions: Map<string, GameSessionRecord>;
  requests: Map<string, string>;
};

const state = globalThis as typeof globalThis & { __zhivDevGameStore?: GameStore };
export function devGameStore(): GameStore {
  return state.__zhivDevGameStore ??= { profiles: new Map(), sessions: new Map(), requests: new Map() };
}
export function resetDevGameStoreForTests() {
  delete state.__zhivDevGameStore;
}

/** A guest read never creates a game profile; private leaderboard records stay private. */
export function devSharedTapStats(ownerPublicId: string) {
  const value = state.__zhivDevGameStore?.profiles.get(ownerPublicId);
  return value?.leaderboardOptIn ? { lifetimeTaps: value.lifetimeTaps, bestSeries: value.bestSeries } : null;
}
