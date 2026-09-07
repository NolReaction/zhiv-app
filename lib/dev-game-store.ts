import { getDevIdentity, lookupDevUser } from "@/lib/dev-api-store";
import type { GameProgress, GameLeaderboard, GameSession, GameBatchResponse } from "@/lib/game-api";

const SESSION_LIFETIME_MS = 15 * 60_000;
const TAP_BUCKET_CAPACITY = 60;
const TAP_RATE_PER_SECOND = 12;
const RUN_IDLE_MS = 12_000;

type Receipt = {
  sequence: number;
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
  expiresAt: number;
  nextSequence: number;
  lastReceipt: Receipt | null;
  continuationClaimed: boolean;
  currentRun: { id: string; taps: number; lastAcceptedAt: number } | null;
};
type GameProfileRecord = {
  ownerPublicId: string;
  lifetimeTaps: number;
  bestSeries: number;
  leaderboardOptIn: boolean;
  visibilityVersion: number;
  monthlyTaps: Map<string, { taps: number; updatedAt: number }>;
  tokens: number;
  refilledAt: number;
};
type GameStore = {
  profiles: Map<string, GameProfileRecord>;
  sessions: Map<string, GameSessionRecord>;
  requests: Map<string, string>;
};

const state = globalThis as typeof globalThis & { __zhivDevGameStore?: GameStore };
function store(): GameStore {
  return state.__zhivDevGameStore ??= { profiles: new Map(), sessions: new Map(), requests: new Map() };
}
export function resetDevGameStoreForTests() {
  delete state.__zhivDevGameStore;
}

function profile(ownerPublicId: string, now: number): GameProfileRecord {
  let value = store().profiles.get(ownerPublicId);
  if (!value) {
    value = { ownerPublicId, lifetimeTaps: 0, bestSeries: 0, leaderboardOptIn: false,
      visibilityVersion: 0, monthlyTaps: new Map(), tokens: TAP_BUCKET_CAPACITY, refilledAt: now };
    store().profiles.set(ownerPublicId, value);
  }
  return value;
}
function monthKey(now: number): string {
  return new Date(now).toISOString().slice(0, 7);
}
function progress(value: GameProfileRecord, now: number): GameProgress {
  const month = monthKey(now);
  return {
    ownerPublicId: value.ownerPublicId,
    lifetimeTaps: value.lifetimeTaps,
    bestSeries: value.bestSeries,
    month,
    monthlyTaps: value.monthlyTaps.get(month)?.taps ?? 0,
    leaderboardOptIn: value.leaderboardOptIn,
    visibilityVersion: value.visibilityVersion,
    serverTime: new Date(now).toISOString(),
  };
}
export type DevGameErrorCode =
  | "UNAUTHORIZED" | "GAME_OWNER_CHANGED" | "GAME_SESSION_EXPIRED"
  | "GAME_SESSION_CONFLICT" | "GAME_SESSION_LIMIT" | "GAME_SEQUENCE_CONFLICT" | "GAME_VISIBILITY_CONFLICT";
export type DevGameResult<T> = { kind: "ok"; value: T } | { kind: "error"; code: DevGameErrorCode };
function error(code: DevGameErrorCode): { kind: "error"; code: DevGameErrorCode } {
  return { kind: "error", code };
}

export function getDevGameProgress(token: string | undefined, now = Date.now()): DevGameResult<GameProgress> {
  const identity = getDevIdentity(token);
  if (!identity) return error("UNAUTHORIZED");
  return { kind: "ok", value: progress(profile(identity.user.publicId, now), now) };
}

export function getDevGameLeaderboard(token: string | undefined, now = Date.now()): DevGameResult<GameLeaderboard> {
  const identity = getDevIdentity(token);
  if (!identity) return error("UNAUTHORIZED");
  const ownerPublicId = identity.user.publicId;
  const own = profile(ownerPublicId, now);
  const month = monthKey(now);
  const eligible = [...store().profiles.values()].flatMap(candidate => {
    const monthly = candidate.monthlyTaps.get(month);
    const taps = monthly?.taps ?? 0;
    if (!candidate.leaderboardOptIn || taps === 0) return [];
    const found = lookupDevUser(token, candidate.ownerPublicId);
    if (found.kind !== "ok") return [];
    return [{ ownerPublicId: candidate.ownerPublicId, displayName: found.value.user.displayName, taps, updatedAt: monthly!.updatedAt }];
  }).sort((left, right) => right.taps - left.taps || left.updatedAt - right.updatedAt || left.ownerPublicId.localeCompare(right.ownerPublicId));
  const position = eligible.findIndex(entry => entry.ownerPublicId === ownerPublicId);
  return { kind: "ok" as const, value: {
    ownerPublicId, month, serverTime: new Date(now).toISOString(),
    entries: eligible.slice(0, 100).map((entry, index) => ({
      rank: index + 1, displayName: entry.displayName, taps: entry.taps, isMe: entry.ownerPublicId === ownerPublicId,
    })),
    myRank: position < 0 ? null : position + 1,
    monthlyTaps: own.monthlyTaps.get(month)?.taps ?? 0,
    leaderboardOptIn: own.leaderboardOptIn,
  } };
}

export function createDevGameSession(token: string | undefined, ownerPublicId: string, requestId: string, now = Date.now()): DevGameResult<GameSession> {
  const identity = getDevIdentity(token);
  if (!identity) return error("UNAUTHORIZED");
  if (identity.user.publicId !== ownerPublicId) return error("GAME_OWNER_CHANGED");
  const own = profile(ownerPublicId, now);
  // Keep receipts for one day, including safe retries after game-session expiry.
  for (const [id, value] of store().sessions) {
    if (value.expiresAt + 86_400_000 <= now) {
      store().sessions.delete(id);
      for (const [key, sessionId] of store().requests) if (sessionId === id) store().requests.delete(key);
    }
  }
  const requestKey = `${ownerPublicId}:${requestId}`;
  const existingId = store().requests.get(requestKey);
  let session = existingId ? store().sessions.get(existingId) : undefined;
  if (session && session.authToken !== token) return error("GAME_SESSION_CONFLICT");
  if (session && now >= session.expiresAt) return error("GAME_SESSION_EXPIRED");
  if (!session) {
    const active = [...store().sessions.values()].filter(value => value.ownerPublicId === ownerPublicId && value.expiresAt > now);
    if (active.length >= 8) return error("GAME_SESSION_LIMIT");
    const current = new Date(now);
    const nextMonth = Date.UTC(current.getUTCFullYear(), current.getUTCMonth() + 1, 1);
    session = { id: crypto.randomUUID(), ownerPublicId, authToken: token!, month: monthKey(now),
      expiresAt: Math.min(now + SESSION_LIFETIME_MS, nextMonth), nextSequence: 1, lastReceipt: null, continuationClaimed: false, currentRun: null };
    store().sessions.set(session.id, session);
    store().requests.set(requestKey, session.id);
  }
  return { kind: "ok" as const, value: {
    sessionId: session.id, nextSequence: session.nextSequence,
    expiresAt: new Date(session.expiresAt).toISOString(), progress: progress(own, now),
  } };
}

export function submitDevGameBatch(
  token: string | undefined,
  payload: { sessionId: string; sequence: number; tapCount: number; runId: string },
  now = Date.now(),
): DevGameResult<GameBatchResponse> {
  const identity = getDevIdentity(token);
  if (!identity) return error("UNAUTHORIZED");
  const session = store().sessions.get(payload.sessionId);
  if (!session || session.ownerPublicId !== identity.user.publicId) return error("GAME_SESSION_EXPIRED");
  if (session.authToken !== token) return error("GAME_SESSION_CONFLICT");
  const own = profile(identity.user.publicId, now);
  const receipt = session.lastReceipt;
  if (receipt?.sequence === payload.sequence) {
    if (receipt.tapCount !== payload.tapCount || receipt.runId !== payload.runId) return error("GAME_SEQUENCE_CONFLICT");
    return { kind: "ok" as const, value: {
      sessionId: session.id, sequence: payload.sequence,
      acceptedTaps: receipt.acceptedTaps, rejectedTaps: receipt.rejectedTaps,
      replayed: true, progress: progress(own, now),
    } };
  }
  if (now >= session.expiresAt || monthKey(now) !== session.month) return error("GAME_SESSION_EXPIRED");
  if (payload.sequence !== session.nextSequence) return error("GAME_SEQUENCE_CONFLICT");
  const elapsed = Math.max(0, now - own.refilledAt);
  own.tokens = Math.min(TAP_BUCKET_CAPACITY, own.tokens + elapsed * TAP_RATE_PER_SECOND / 1_000);
  own.refilledAt = Math.max(own.refilledAt, now);
  const acceptedTaps = Math.min(payload.tapCount, Math.floor(own.tokens));
  own.tokens -= acceptedTaps;
  if (acceptedTaps > 0) {
    own.lifetimeTaps += acceptedTaps;
    own.monthlyTaps.set(session.month, { taps: (own.monthlyTaps.get(session.month)?.taps ?? 0) + acceptedTaps, updatedAt: now });
    if (!session.currentRun) {
      // Renewal preserves an ongoing run, but each expired predecessor can be claimed only once.
      const predecessor = [...store().sessions.values()].filter(candidate =>
        candidate.ownerPublicId === session.ownerPublicId && candidate.authToken === session.authToken
        && candidate.expiresAt <= now && !candidate.continuationClaimed
        && candidate.currentRun?.id === payload.runId
        && candidate.currentRun.lastAcceptedAt <= now
        && now - candidate.currentRun.lastAcceptedAt <= RUN_IDLE_MS,
      ).sort((left, right) => right.currentRun!.lastAcceptedAt - left.currentRun!.lastAcceptedAt
        || right.expiresAt - left.expiresAt || right.id.localeCompare(left.id))[0];
      if (predecessor?.currentRun) {
        session.currentRun = { ...predecessor.currentRun };
        predecessor.continuationClaimed = true;
      }
    }
    if (session.currentRun?.id !== payload.runId || now - session.currentRun.lastAcceptedAt > RUN_IDLE_MS || now < session.currentRun.lastAcceptedAt) {
      session.currentRun = { id: payload.runId, taps: 0, lastAcceptedAt: now };
    }
    session.currentRun.taps += acceptedTaps;
    session.currentRun.lastAcceptedAt = now;
    own.bestSeries = Math.max(own.bestSeries, session.currentRun.taps);
  }
  session.lastReceipt = { ...payload, acceptedTaps, rejectedTaps: payload.tapCount - acceptedTaps };
  session.nextSequence++;
  return { kind: "ok" as const, value: {
    sessionId: session.id, sequence: payload.sequence,
    acceptedTaps, rejectedTaps: payload.tapCount - acceptedTaps,
    replayed: false, progress: progress(own, now),
  } };
}

export function updateDevGameVisibility(
  token: string | undefined, ownerPublicId: string, leaderboardOptIn: boolean, expectedVersion: number, now = Date.now(),
): DevGameResult<GameProgress> {
  const identity = getDevIdentity(token);
  if (!identity) return error("UNAUTHORIZED");
  if (identity.user.publicId !== ownerPublicId) return error("GAME_OWNER_CHANGED");
  const own = profile(ownerPublicId, now);
  if (own.visibilityVersion !== expectedVersion) {
    if (own.visibilityVersion === expectedVersion + 1 && own.leaderboardOptIn === leaderboardOptIn) {
      return { kind: "ok", value: progress(own, now) };
    }
    return error("GAME_VISIBILITY_CONFLICT");
  }
  own.leaderboardOptIn = leaderboardOptIn;
  own.visibilityVersion++;
  return { kind: "ok", value: progress(own, now) };
}
