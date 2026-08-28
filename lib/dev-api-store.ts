import type { CheckInResponse, MeResponse, PublicUser } from "@/lib/check-in-contract";
import { normalizeDisplayName } from "@/lib/check-in-presentation";

export const SESSION_COOKIE = "zhiv_session_dev";
const COOLDOWN_MS = 30_000;
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

type UserRecord = PublicUser & { id: string; lastCheckInAt: string | null };
type SessionRecord = { userId: string; expiresAt: number };

type Store = {
  users: Map<string, UserRecord>;
  publicIds: Set<string>;
  sessions: Map<string, SessionRecord>;
  idempotency: Map<string, CheckInResponse>;
  bootstrapKeys: Map<string, string>;
};

const globalStore = globalThis as typeof globalThis & { __zhivDevStore?: Store };

function store(): Store {
  globalStore.__zhivDevStore ??= {
    users: new Map(),
    publicIds: new Set(),
    sessions: new Map(),
    idempotency: new Map(),
    bootstrapKeys: new Map(),
  };
  return globalStore.__zhivDevStore;
}

function randomToken(bytesCount = 32): string {
  const bytes = crypto.getRandomValues(new Uint8Array(bytesCount));
  return Buffer.from(bytes).toString("base64url");
}

function newPublicId(): string {
  const currentStore = store();
  for (;;) {
    const bytes = crypto.getRandomValues(new Uint8Array(12));
    const raw = Array.from(bytes, (value) => CROCKFORD[value % CROCKFORD.length]).join("");
    const publicId = `${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8, 12)}`;
    if (!currentStore.publicIds.has(publicId)) return publicId;
  }
}

function asMe(user: UserRecord): MeResponse {
  return {
    user: { publicId: user.publicId, displayName: user.displayName },
    lastCheckInAt: user.lastCheckInAt,
    serverTime: new Date().toISOString(),
  };
}

export function createDevIdentity(
  displayName: string,
  bootstrapKey: string,
): { token: string; me: MeResponse } {
  const currentStore = store();
  const existingUserId = currentStore.bootstrapKeys.get(bootstrapKey);
  const existingUser = existingUserId ? currentStore.users.get(existingUserId) : undefined;
  if (existingUser) {
    const token = randomToken();
    currentStore.sessions.set(token, {
      userId: existingUser.id,
      expiresAt: Date.now() + 365 * 24 * 60 * 60 * 1_000,
    });
    return { token, me: asMe(existingUser) };
  }

  const user: UserRecord = {
    id: crypto.randomUUID(),
    publicId: newPublicId(),
    displayName: normalizeDisplayName(displayName),
    lastCheckInAt: null,
  };
  const token = randomToken();

  currentStore.users.set(user.id, user);
  currentStore.publicIds.add(user.publicId);
  currentStore.bootstrapKeys.set(bootstrapKey, user.id);
  currentStore.sessions.set(token, {
    userId: user.id,
    expiresAt: Date.now() + 365 * 24 * 60 * 60 * 1_000,
  });

  return { token, me: asMe(user) };
}

export function getDevIdentity(token: string | undefined): MeResponse | null {
  if (!token) return null;
  const currentStore = store();
  const session = currentStore.sessions.get(token);
  if (!session || session.expiresAt <= Date.now()) return null;
  const user = currentStore.users.get(session.userId);
  return user ? asMe(user) : null;
}

export type DevCheckInResult =
  | { kind: "accepted"; value: CheckInResponse }
  | {
      kind: "cooldown";
      checkedAt: string;
      serverTime: string;
      nextAllowedAt: string;
    }
  | { kind: "unauthorized" };

export function createDevCheckIn(
  token: string | undefined,
  idempotencyKey: string,
): DevCheckInResult {
  if (!token) return { kind: "unauthorized" };
  const currentStore = store();
  const session = currentStore.sessions.get(token);
  if (!session || session.expiresAt <= Date.now()) return { kind: "unauthorized" };
  const user = currentStore.users.get(session.userId);
  if (!user) return { kind: "unauthorized" };

  const replayKey = `${user.id}:${idempotencyKey}`;
  const replay = currentStore.idempotency.get(replayKey);
  if (replay) return { kind: "accepted", value: { ...replay, replayed: true } };

  const serverTime = new Date();
  const nextAllowedMs = user.lastCheckInAt
    ? Date.parse(user.lastCheckInAt) + COOLDOWN_MS
    : 0;

  if (nextAllowedMs > serverTime.getTime()) {
    return {
      kind: "cooldown",
      checkedAt: user.lastCheckInAt!,
      serverTime: serverTime.toISOString(),
      nextAllowedAt: new Date(nextAllowedMs).toISOString(),
    };
  }

  const checkedAt = serverTime.toISOString();
  const response: CheckInResponse = {
    eventId: crypto.randomUUID(),
    checkedAt,
    serverTime: checkedAt,
    nextAllowedAt: new Date(serverTime.getTime() + COOLDOWN_MS).toISOString(),
    replayed: false,
  };
  user.lastCheckInAt = checkedAt;
  currentStore.idempotency.set(replayKey, response);
  return { kind: "accepted", value: response };
}
