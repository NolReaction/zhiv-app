import type {
  CheckInResponse,
  DirectRequest,
  DirectRequestActionResponse,
  DirectRequestResponse,
  MeResponse,
  PeopleResponse,
  Person,
  PublicUser,
  SharingMode,
  SharingResponse,
  UserLookupResponse,
} from "@/lib/check-in-contract";
import { normalizeDisplayName } from "@/lib/check-in-presentation";

export const SESSION_COOKIE = "zhiv_session_dev";
const COOLDOWN_MS = 30_000;
const REQUEST_TTL_MS = 7 * 24 * 60 * 60_000;
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

type UserRecord = PublicUser & { id: string; lastCheckInAt: string | null };
type SessionRecord = { userId: string; expiresAt: number };
type CheckInRecord = { id: string; userId: string; checkedAt: string };
type DirectCircleRecord = {
  id: string;
  lowUserId: string;
  highUserId: string;
  createdAt: string;
  archivedAt: string | null;
};
type RequestStatus = "PENDING" | "ACCEPTED" | "REJECTED" | "CANCELLED" | "EXPIRED";
type DirectRequestRecord = {
  id: string;
  requesterUserId: string;
  recipientUserId: string;
  idempotencyKey: string;
  status: RequestStatus;
  resultCircleId: string | null;
  createdAt: string;
  expiresAt: string;
  respondedAt: string | null;
};
type AudienceRecord = {
  eventId: string;
  actorUserId: string;
  recipientUserId: string;
  circleId: string;
};
type SharingRecord = { mode: SharingMode; enabledSince: string | null };

type Store = {
  users: Map<string, UserRecord>;
  publicIds: Map<string, string>;
  sessions: Map<string, SessionRecord>;
  idempotency: Map<string, CheckInResponse>;
  bootstrapKeys: Map<string, string>;
  checkIns: Map<string, CheckInRecord>;
  circles: Map<string, DirectCircleRecord>;
  directRequests: Map<string, DirectRequestRecord>;
  sharing: Map<string, SharingRecord>;
  audiences: AudienceRecord[];
};

export type DevResult<T> =
  | { kind: "ok"; value: T }
  | { kind: "unauthorized" }
  | { kind: "not-found" }
  | { kind: "self" }
  | { kind: "already-connected" }
  | { kind: "forbidden" }
  | { kind: "expired" }
  | { kind: "conflict" };

const globalStore = globalThis as typeof globalThis & { __zhivDevStore?: Store };

function store(): Store {
  globalStore.__zhivDevStore ??= {
    users: new Map(),
    publicIds: new Map(),
    sessions: new Map(),
    idempotency: new Map(),
    bootstrapKeys: new Map(),
    checkIns: new Map(),
    circles: new Map(),
    directRequests: new Map(),
    sharing: new Map(),
    audiences: [],
  };
  return globalStore.__zhivDevStore;
}

export function resetDevStoreForTests() {
  delete globalStore.__zhivDevStore;
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

function publicUser(user: UserRecord): PublicUser {
  return { publicId: user.publicId, displayName: user.displayName };
}

function asMe(user: UserRecord): MeResponse {
  return {
    user: publicUser(user),
    lastCheckInAt: user.lastCheckInAt,
    serverTime: new Date().toISOString(),
  };
}

function sessionUser(token: string | undefined): UserRecord | null {
  if (!token) return null;
  const currentStore = store();
  const session = currentStore.sessions.get(token);
  if (!session || session.expiresAt <= Date.now()) return null;
  return currentStore.users.get(session.userId) ?? null;
}

function sharingKey(circleId: string, userId: string): string {
  return `${circleId}:${userId}`;
}

function orderedPair(firstUserId: string, secondUserId: string): [string, string] {
  return firstUserId < secondUserId
    ? [firstUserId, secondUserId]
    : [secondUserId, firstUserId];
}

function activeCircleForPair(firstUserId: string, secondUserId: string): DirectCircleRecord | null {
  const [lowUserId, highUserId] = orderedPair(firstUserId, secondUserId);
  return [...store().circles.values()].find(
    (circle) =>
      circle.archivedAt === null &&
      circle.lowUserId === lowUserId &&
      circle.highUserId === highUserId,
  ) ?? null;
}

function activeCirclesForUser(userId: string): DirectCircleRecord[] {
  return [...store().circles.values()].filter(
    (circle) =>
      circle.archivedAt === null &&
      (circle.lowUserId === userId || circle.highUserId === userId),
  );
}

function otherUserId(circle: DirectCircleRecord, userId: string): string {
  return circle.lowUserId === userId ? circle.highUserId : circle.lowUserId;
}

function expireRequests(nowMs = Date.now()) {
  for (const request of store().directRequests.values()) {
    if (request.status === "PENDING" && Date.parse(request.expiresAt) <= nowMs) {
      request.status = "EXPIRED";
      request.respondedAt = new Date(nowMs).toISOString();
    }
  }
}

function pendingRequestForPair(firstUserId: string, secondUserId: string): DirectRequestRecord | null {
  expireRequests();
  return [...store().directRequests.values()].find(
    (request) =>
      request.status === "PENDING" &&
      ((request.requesterUserId === firstUserId && request.recipientUserId === secondUserId) ||
        (request.requesterUserId === secondUserId && request.recipientUserId === firstUserId)),
  ) ?? null;
}

function requestDto(request: DirectRequestRecord, currentUserId: string): DirectRequest {
  const direction = request.requesterUserId === currentUserId ? "OUTGOING" : "INCOMING";
  const relatedUserId = direction === "OUTGOING" ? request.recipientUserId : request.requesterUserId;
  const relatedUser = store().users.get(relatedUserId);
  if (!relatedUser) throw new Error("Dev relationship references a missing user");
  return {
    requestId: request.id,
    direction,
    user: publicUser(relatedUser),
    createdAt: request.createdAt,
    expiresAt: request.expiresAt,
  };
}

function latestAudienceCheckIn(
  circleId: string,
  actorUserId: string,
  recipientUserId: string,
  enabledSince: string | null,
): string | null {
  if (!enabledSince) return null;
  const currentStore = store();
  let latest: string | null = null;
  for (const audience of currentStore.audiences) {
    if (
      audience.circleId !== circleId ||
      audience.actorUserId !== actorUserId ||
      audience.recipientUserId !== recipientUserId
    ) continue;
    const event = currentStore.checkIns.get(audience.eventId);
    if (
      event &&
      event.checkedAt >= enabledSince &&
      (latest === null || event.checkedAt > latest)
    ) latest = event.checkedAt;
  }
  return latest;
}

function personDto(circle: DirectCircleRecord, currentUserId: string): Person {
  const relatedUserId = otherUserId(circle, currentUserId);
  const relatedUser = store().users.get(relatedUserId);
  if (!relatedUser) throw new Error("Dev relationship references a missing user");
  const mySharing = store().sharing.get(sharingKey(circle.id, currentUserId)) ?? {
    mode: "LATEST_ONLY" as const,
    enabledSince: circle.createdAt,
  };
  const theirSharing = store().sharing.get(sharingKey(circle.id, relatedUserId)) ?? {
    mode: "LATEST_ONLY" as const,
    enabledSince: circle.createdAt,
  };
  return {
    circleId: circle.id,
    user: publicUser(relatedUser),
    connectedAt: circle.createdAt,
    mySharingMode: mySharing.mode,
    theirSharingMode: theirSharing.mode,
    lastCheckInAt:
      theirSharing.mode === "OFF"
        ? null
        : latestAudienceCheckIn(
            circle.id,
            relatedUserId,
            currentUserId,
            theirSharing.enabledSince,
          ),
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
      expiresAt: Date.now() + 365 * 24 * 60 * 60_000,
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
  currentStore.publicIds.set(user.publicId, user.id);
  currentStore.bootstrapKeys.set(bootstrapKey, user.id);
  currentStore.sessions.set(token, {
    userId: user.id,
    expiresAt: Date.now() + 365 * 24 * 60 * 60_000,
  });

  return { token, me: asMe(user) };
}

export function getDevIdentity(token: string | undefined): MeResponse | null {
  const user = sessionUser(token);
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
  const user = sessionUser(token);
  if (!user) return { kind: "unauthorized" };
  const currentStore = store();

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
  currentStore.checkIns.set(response.eventId, {
    id: response.eventId,
    userId: user.id,
    checkedAt,
  });

  for (const circle of activeCirclesForUser(user.id)) {
    const sharing = currentStore.sharing.get(sharingKey(circle.id, user.id)) ?? {
      mode: "LATEST_ONLY" as const,
      enabledSince: circle.createdAt,
    };
    if (sharing.mode === "OFF" || !sharing.enabledSince || sharing.enabledSince > checkedAt) continue;
    currentStore.audiences.push({
      eventId: response.eventId,
      actorUserId: user.id,
      recipientUserId: otherUserId(circle, user.id),
      circleId: circle.id,
    });
  }

  currentStore.idempotency.set(replayKey, response);
  return { kind: "accepted", value: response };
}

export function lookupDevUser(
  token: string | undefined,
  publicId: string,
): DevResult<UserLookupResponse> {
  const currentUser = sessionUser(token);
  if (!currentUser) return { kind: "unauthorized" };
  const targetId = store().publicIds.get(publicId);
  const target = targetId ? store().users.get(targetId) : undefined;
  if (!target) return { kind: "not-found" };

  const activeCircle = activeCircleForPair(currentUser.id, target.id);
  const pending = pendingRequestForPair(currentUser.id, target.id);
  const relationshipState = currentUser.id === target.id
    ? "SELF"
    : activeCircle
      ? "CONNECTED"
      : pending?.requesterUserId === currentUser.id
        ? "OUTGOING_REQUEST"
        : pending
          ? "INCOMING_REQUEST"
          : "NONE";

  return {
    kind: "ok",
    value: {
      user: publicUser(target),
      relationshipState,
      serverTime: new Date().toISOString(),
    },
  };
}

export function listDevPeople(token: string | undefined): DevResult<PeopleResponse> {
  const currentUser = sessionUser(token);
  if (!currentUser) return { kind: "unauthorized" };
  expireRequests();
  const currentStore = store();
  const people = activeCirclesForUser(currentUser.id)
    .map((circle) => personDto(circle, currentUser.id))
    .sort((first, second) => first.user.displayName.localeCompare(second.user.displayName, "ru"));
  const pending = [...currentStore.directRequests.values()].filter(
    (request) =>
      request.status === "PENDING" &&
      (request.requesterUserId === currentUser.id || request.recipientUserId === currentUser.id),
  );

  return {
    kind: "ok",
    value: {
      people,
      incomingRequests: pending
        .filter((request) => request.recipientUserId === currentUser.id)
        .map((request) => requestDto(request, currentUser.id)),
      outgoingRequests: pending
        .filter((request) => request.requesterUserId === currentUser.id)
        .map((request) => requestDto(request, currentUser.id)),
      audienceCount: people.filter((person) => person.mySharingMode !== "OFF").length,
      serverTime: new Date().toISOString(),
    },
  };
}

export function sendDevDirectRequest(
  token: string | undefined,
  publicId: string,
  idempotencyKey: string,
): DevResult<DirectRequestResponse> {
  const currentUser = sessionUser(token);
  if (!currentUser) return { kind: "unauthorized" };
  const targetId = store().publicIds.get(publicId);
  const target = targetId ? store().users.get(targetId) : undefined;
  if (!target) return { kind: "not-found" };
  if (target.id === currentUser.id) return { kind: "self" };
  if (activeCircleForPair(currentUser.id, target.id)) return { kind: "already-connected" };

  const replay = [...store().directRequests.values()].find(
    (request) =>
      request.requesterUserId === currentUser.id &&
      request.idempotencyKey === idempotencyKey,
  );
  if (replay) {
    if (replay.recipientUserId !== target.id) return { kind: "conflict" };
    return {
      kind: "ok",
      value: {
        request: requestDto(replay, currentUser.id),
        replayed: true,
        serverTime: new Date().toISOString(),
      },
    };
  }

  const existing = pendingRequestForPair(currentUser.id, target.id);
  if (existing) {
    return {
      kind: "ok",
      value: {
        request: requestDto(existing, currentUser.id),
        replayed: true,
        serverTime: new Date().toISOString(),
      },
    };
  }

  const createdAt = new Date();
  const request: DirectRequestRecord = {
    id: crypto.randomUUID(),
    requesterUserId: currentUser.id,
    recipientUserId: target.id,
    idempotencyKey,
    status: "PENDING",
    resultCircleId: null,
    createdAt: createdAt.toISOString(),
    expiresAt: new Date(createdAt.getTime() + REQUEST_TTL_MS).toISOString(),
    respondedAt: null,
  };
  store().directRequests.set(request.id, request);
  return {
    kind: "ok",
    value: {
      request: requestDto(request, currentUser.id),
      replayed: false,
      serverTime: createdAt.toISOString(),
    },
  };
}

export function actOnDevDirectRequest(
  token: string | undefined,
  requestId: string,
  action: "ACCEPTED" | "REJECTED" | "CANCELLED",
): DevResult<DirectRequestActionResponse> {
  const currentUser = sessionUser(token);
  if (!currentUser) return { kind: "unauthorized" };
  expireRequests();
  const request = store().directRequests.get(requestId);
  if (!request) return { kind: "not-found" };

  const authorized = action === "CANCELLED"
    ? request.requesterUserId === currentUser.id
    : request.recipientUserId === currentUser.id;
  if (!authorized) return { kind: "forbidden" };
  if (request.status === "EXPIRED") return { kind: "expired" };

  if (request.status !== "PENDING") {
    if (request.status !== action) return { kind: "conflict" };
    const circle = request.resultCircleId ? store().circles.get(request.resultCircleId) : undefined;
    return {
      kind: "ok",
      value: {
        requestId,
        status: action,
        person: circle && circle.archivedAt === null ? personDto(circle, currentUser.id) : null,
        replayed: true,
        serverTime: new Date().toISOString(),
      },
    };
  }

  const respondedAt = new Date().toISOString();
  request.status = action;
  request.respondedAt = respondedAt;
  let person: Person | null = null;

  if (action === "ACCEPTED") {
    let circle = activeCircleForPair(request.requesterUserId, request.recipientUserId);
    if (!circle) {
      const [lowUserId, highUserId] = orderedPair(
        request.requesterUserId,
        request.recipientUserId,
      );
      circle = {
        id: crypto.randomUUID(),
        lowUserId,
        highUserId,
        createdAt: respondedAt,
        archivedAt: null,
      };
      store().circles.set(circle.id, circle);
      store().sharing.set(sharingKey(circle.id, lowUserId), {
        mode: "LATEST_ONLY",
        enabledSince: respondedAt,
      });
      store().sharing.set(sharingKey(circle.id, highUserId), {
        mode: "LATEST_ONLY",
        enabledSince: respondedAt,
      });
    }
    request.resultCircleId = circle.id;
    person = personDto(circle, currentUser.id);
  }

  return {
    kind: "ok",
    value: {
      requestId,
      status: action,
      person,
      replayed: false,
      serverTime: respondedAt,
    },
  };
}

export function updateDevSharing(
  token: string | undefined,
  circleId: string,
  sharingMode: SharingMode,
): DevResult<SharingResponse> {
  const currentUser = sessionUser(token);
  if (!currentUser) return { kind: "unauthorized" };
  const circle = store().circles.get(circleId);
  if (!circle || circle.archivedAt !== null) return { kind: "not-found" };
  if (circle.lowUserId !== currentUser.id && circle.highUserId !== currentUser.id) {
    return { kind: "forbidden" };
  }
  const previous = store().sharing.get(sharingKey(circle.id, currentUser.id));
  const latestStoredCheckIn = Math.max(
    0,
    ...[...store().checkIns.values()].map((event) => Date.parse(event.checkedAt)),
  );
  store().sharing.set(sharingKey(circle.id, currentUser.id), {
    mode: sharingMode,
    enabledSince:
      sharingMode === "OFF"
        ? null
        : previous?.mode === "OFF" || !previous
          ? new Date(Math.max(Date.now(), latestStoredCheckIn + 1)).toISOString()
          : previous.enabledSince,
  });
  return {
    kind: "ok",
    value: { circleId, sharingMode, serverTime: new Date().toISOString() },
  };
}

export function removeDevPerson(
  token: string | undefined,
  circleId: string,
): DevResult<{ serverTime: string }> {
  const currentUser = sessionUser(token);
  if (!currentUser) return { kind: "unauthorized" };
  const circle = store().circles.get(circleId);
  if (!circle) return { kind: "not-found" };
  if (circle.lowUserId !== currentUser.id && circle.highUserId !== currentUser.id) {
    return { kind: "forbidden" };
  }
  if (circle.archivedAt !== null) {
    return { kind: "ok", value: { serverTime: circle.archivedAt } };
  }
  circle.archivedAt = new Date().toISOString();
  return { kind: "ok", value: { serverTime: circle.archivedAt } };
}
