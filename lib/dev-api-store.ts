import type {
  CheckInResponse,
  DailyStreak,
  DirectRequest,
  DirectRequestActionResponse,
  DirectRequestResponse,
  DirectInviteLink,
  DirectInvitePreview,
  DirectInviteRedeemResponse,
  Group,
  GroupInvite,
  GroupMember,
  GroupMutationResponse,
  GroupsResponse,
  MeResponse,
  PeopleResponse,
  Person,
  PublicUser,
  SharingMode,
  SharingResponse,
  UserLookupResponse,
} from "@/lib/check-in-contract";
import { createHash } from "node:crypto";
import { normalizeDisplayName } from "@/lib/check-in-presentation";
import {
  calculateRollingStreak,
  formatLocalDate,
} from "@/lib/daily-streak";

export const SESSION_COOKIE = "zhiv_session_dev";
const COOLDOWN_MS = 30_000;
const REQUEST_TTL_MS = 7 * 24 * 60 * 60_000;
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

type UserRecord = PublicUser & {
  status?: { text: string; updatedAt: string } | null;
  statusWrites?: Map<string, string>;
  id: string;
  timezoneId: string;
  lastCheckInAt: string | null;
  displayNameChangedAt: string | null;
  displayNameChangeKey: string | null;
  avatarUrl: string | null;
};
type SessionRecord = { userId: string; expiresAt: number };
type CheckInRecord = { id: string; userId: string; checkedAt: string; localDate: string };
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
  recipientMembershipId: string | null;
};
type SharingRecord = {
  mode: SharingMode;
  enabledSince: string | null;
  resumed?: boolean;
};
type GroupRecord = {
  id: string;
  title: string;
  emoji: string | null;
  createdByUserId: string;
  creationIdempotencyKey: string;
  createdAt: string;
  archivedAt: string | null;
};
type GroupMembershipRecord = {
  id: string;
  groupId: string;
  userId: string;
  role: "OWNER" | "ADMIN" | "MEMBER";
  joinedAt: string;
  leftAt: string | null;
};
type GroupInviteRecord = {
  id: string;
  groupId: string;
  inviterUserId: string;
  inviteeUserId: string;
  idempotencyKey: string;
  status: "PENDING" | "ACCEPTED" | "REVOKED";
  createdAt: string;
  expiresAt: string;
  acceptedAt: string | null;
  revokedAt: string | null;
};
type DirectInviteLinkRecord = {
  id: string;
  inviterUserId: string;
  token: string;
  idempotencyKey: string;
  status: "PENDING" | "ACCEPTED" | "REVOKED" | "EXPIRED";
  acceptedByUserId: string | null;
  acceptedIdempotencyKey: string | null;
  resultCircleId: string | null;
  createdAt: string;
  expiresAt: string;
};
type RecoveryCodeRecord = {userId:string;active:boolean;consumedAt?:number;retryHash?:string;sessionToken?:string};

type Store = {
  recipientSharing: Map<string, SharingRecord>;
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
  groups: Map<string, GroupRecord>;
  groupMemberships: Map<string, GroupMembershipRecord>;
  groupInvites: Map<string, GroupInviteRecord>;
  directInviteLinks: Map<string, DirectInviteLinkRecord>;
  recoveryCodes: Map<string,RecoveryCodeRecord>;
};

export type DevResult<T> =
  | { kind: "ok"; value: T }
  | { kind: "unauthorized" }
  | { kind: "not-found" }
  | { kind: "self" }
  | { kind: "already-connected" }
  | { kind: "forbidden" }
  | { kind: "expired" }
  | { kind: "conflict" }
  | { kind: "limit-reached" };

const globalStore = globalThis as typeof globalThis & { __zhivDevStore?: Store };

function store(): Store {
  globalStore.__zhivDevStore ??= {
    recipientSharing: new Map(),
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
    groups: new Map(),
    groupMemberships: new Map(),
    groupInvites: new Map(),
    directInviteLinks: new Map(),
    recoveryCodes: new Map(),
  };
  globalStore.__zhivDevStore.directInviteLinks ??= new Map();
  globalStore.__zhivDevStore.recoveryCodes ??= new Map();
  globalStore.__zhivDevStore.recipientSharing ??= new Map();
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

function streakForUser(user: UserRecord, serverTime: Date): DailyStreak {
  const currentStore = store();
  return calculateRollingStreak(
    [...currentStore.checkIns.values()]
      .filter((event) => event.userId === user.id)
      .map((event) => event.checkedAt),
    serverTime,
  );
}

function asMe(user: UserRecord, serverTime = new Date()): MeResponse {
  const availableAt = user.displayNameChangedAt
    ? new Date(Date.parse(user.displayNameChangedAt) + 24 * 60 * 60_000)
    : null;
  return {
    status: user.status ?? null,
    user: publicUser(user),
    lastCheckInAt: user.lastCheckInAt,
    checkInCount: [...store().checkIns.values()].filter((event) => event.userId === user.id).length,
    streak: streakForUser(user, serverTime),
    profile: {
      avatarUrl: user.avatarUrl,
      displayNameChangedAt: user.displayNameChangedAt,
      displayNameChangeAvailableAt:
        availableAt && availableAt.getTime() > serverTime.getTime()
          ? availableAt.toISOString()
          : null,
    },
    serverTime: serverTime.toISOString(),
  };
}

function sessionUser(token: string | undefined): UserRecord | null {
  if (!token) return null;
  const currentStore = store();
  const session = currentStore.sessions.get(token);
  if (!session || session.expiresAt <= Date.now()) return null;
  return currentStore.users.get(session.userId) ?? null;
}

function effectiveRecipientSharing(actor: string, recipient: string): SharingRecord {
  const paths: Array<SharingRecord & { epoch: string }> = [];
  const direct = activeCircleForPair(actor, recipient);
  if (direct) paths.push({ ...(store().sharing.get(sharingKey(direct.id, actor)) ?? { mode: "OFF", enabledSince: null }), epoch: direct.createdAt });
  for (const membership of activeGroupMembershipsForUser(actor)) {
    const group = store().groups.get(membership.groupId);
    const other = activeGroupMembership(membership.groupId, recipient);
    if (!group || group.archivedAt || !other || actor === recipient) continue;
    paths.push({ ...(store().sharing.get(sharingKey(group.id, actor)) ?? { mode: "OFF", enabledSince: null }),
      epoch: [group.createdAt, membership.joinedAt, other.joinedAt].sort().at(-1)! });
  }
  if (paths.length === 0 || actor === recipient) return { mode: "OFF", enabledSince: null };
  const key = actor + ":" + recipient;
  const override = store().recipientSharing.get(key);
  if (override?.mode === "OFF") return override;
  if (!override && paths.some(path => path.mode === "OFF")) {
    const denied: SharingRecord = { mode: "OFF", enabledSince: null };
    store().recipientSharing.set(key, denied);
    return denied;
  }
  const since = override?.enabledSince ?? paths.map(path => path.enabledSince ?? path.epoch).sort().at(-1)!;
  const epoch = paths.map(path => path.epoch).sort()[0];
  return { mode: "LATEST_ONLY", enabledSince: since > epoch ? since : epoch, resumed: override?.resumed ?? paths.some(path => path.resumed) };
}

function preserveRecipientDenies(relatedUser:string) {
  for(const id of store().users.keys()) {
    if(id===relatedUser)continue;
    effectiveRecipientSharing(id,relatedUser);
    effectiveRecipientSharing(relatedUser,id);
  }
}

function setRecipientSharing(actor: string, recipient: string, mode: SharingMode) {
  const previous = effectiveRecipientSharing(actor, recipient);
  const latest = Math.max(0, ...[...store().checkIns.values()].map(event => Date.parse(event.checkedAt)),
    ...[...store().users.values()].map(user => user.status ? Date.parse(user.status.updatedAt) : 0));
  store().recipientSharing.set(actor + ":" + recipient, {
    mode, resumed: previous.resumed || previous.mode === "OFF",
    enabledSince: mode === "OFF" ? null : previous.mode === "LATEST_ONLY" ? previous.enabledSince : new Date(Math.max(Date.now(), latest + 1)).toISOString(),
  });
}

function visibleStatus(user: UserRecord, recipient: string) {
  const permission = effectiveRecipientSharing(user.id, recipient);
  return permission.mode !== "OFF" && permission.enabledSince && user.status && user.status.updatedAt >= permission.enabledSince ? user.status : null;
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

function activeGroupMemberships(groupId: string): GroupMembershipRecord[] {
  return [...store().groupMemberships.values()].filter(
    (membership) => membership.groupId === groupId && membership.leftAt === null,
  );
}

function activeGroupMembershipsForUser(userId: string): GroupMembershipRecord[] {
  return [...store().groupMemberships.values()].filter(
    (membership) => membership.userId === userId && membership.leftAt === null,
  );
}

function activeGroupMembership(groupId: string, userId: string): GroupMembershipRecord | null {
  return activeGroupMemberships(groupId).find((membership) => membership.userId === userId) ?? null;
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
  recipientMembershipId?: string,
): string | null {
  if (!enabledSince) return null;
  const currentStore = store();
  let latest: string | null = null;
  for (const audience of currentStore.audiences) {
    if (
      audience.circleId !== circleId ||
      audience.actorUserId !== actorUserId ||
      audience.recipientUserId !== recipientUserId ||
      (recipientMembershipId !== undefined &&
        audience.recipientMembershipId !== recipientMembershipId)
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

function expireGroupInvites(nowMs = Date.now()) {
  for (const invite of store().groupInvites.values()) {
    if (invite.status === "PENDING" && Date.parse(invite.expiresAt) <= nowMs) {
      invite.status = "REVOKED";
      invite.revokedAt = new Date(nowMs).toISOString();
    }
  }
}

function groupInviteDto(invite: GroupInviteRecord, currentUserId: string): GroupInvite {
  const group = store().groups.get(invite.groupId);
  if (!group) throw new Error("Dev invite references a missing group");
  const incoming = invite.inviteeUserId === currentUserId;
  const relatedUser = store().users.get(incoming ? invite.inviterUserId : invite.inviteeUserId);
  if (!relatedUser) throw new Error("Dev invite references a missing user");
  return {
    inviteId: invite.id,
    direction: incoming ? "INCOMING" : "OUTGOING",
    groupId: group.id,
    groupTitle: group.title,
    groupEmoji: group.emoji,
    user: publicUser(relatedUser),
    createdAt: invite.createdAt,
    expiresAt: invite.expiresAt,
  };
}

function groupMemberDto(
  membership: GroupMembershipRecord,
  currentUserId: string,
  recipientMembershipId: string,
): GroupMember {
  const user = store().users.get(membership.userId);
  if (!user) throw new Error("Dev membership references a missing user");
  const sharing = membership.userId === currentUserId
    ? store().sharing.get(sharingKey(membership.groupId,currentUserId)) ?? { mode: "OFF" as const, enabledSince: null }
    : effectiveRecipientSharing(membership.userId,currentUserId);
  return {
    status: membership.userId === currentUserId ? user.status ?? null : visibleStatus(user,currentUserId),
    membershipId: membership.id,
    user: publicUser(user),
    role: membership.role,
    sharingMode: sharing.mode,
    lastCheckInAt:
      membership.userId === currentUserId || sharing.mode === "OFF"
        ? null
        : latestAudienceCheckIn(
            membership.groupId,
            membership.userId,
            currentUserId,
            sharing.enabledSince,
            recipientMembershipId,
          ),
    joinedAt: membership.joinedAt,
    isMe: membership.userId === currentUserId,
  };
}

function groupDto(group: GroupRecord, currentUserId: string): Group | null {
  const mine = activeGroupMembership(group.id, currentUserId);
  if (!mine || group.archivedAt !== null) return null;
  const mySharing = store().sharing.get(sharingKey(group.id, currentUserId)) ?? {
    mode: "OFF" as const,
    enabledSince: null,
  };
  const recipientModes = activeGroupMemberships(group.id).filter(m => m.userId !== currentUserId).map(m => effectiveRecipientSharing(currentUserId,m.userId).mode);
  const enabledCount = recipientModes.filter(mode => mode !== "OFF").length;
  const pendingInvites = [...store().groupInvites.values()]
    .filter(
      (invite) =>
        invite.groupId === group.id &&
        invite.inviterUserId === currentUserId &&
        invite.status === "PENDING",
    )
    .map((invite) => groupInviteDto(invite, currentUserId));
  return {
    groupId: group.id,
    title: group.title,
    emoji: group.emoji,
    myRole: mine.role,
    mySharingMode: recipientModes.length ? enabledCount === recipientModes.length ? "LATEST_ONLY" : "OFF" : mySharing.mode,
    sharingMixed: enabledCount > 0 && enabledCount < recipientModes.length,
    createdAt: group.createdAt,
    members: activeGroupMemberships(group.id)
      .map((membership) => groupMemberDto(membership, currentUserId, mine.id))
      .sort((first, second) => Number(second.isMe) - Number(first.isMe)
        || first.user.displayName.localeCompare(second.user.displayName, "ru")),
    pendingInvites,
  };
}

function targetFromDirectCircle(personCircleId: string, currentUserId: string): string | null {
  const circle = store().circles.get(personCircleId);
  if (
    !circle ||
    circle.archivedAt !== null ||
    (circle.lowUserId !== currentUserId && circle.highUserId !== currentUserId)
  ) return null;
  return otherUserId(circle, currentUserId);
}

function createGroupInviteRecord(
  groupId: string,
  inviterUserId: string,
  inviteeUserId: string,
  idempotencyKey: string,
  now: Date,
): GroupInviteRecord {
  const invite: GroupInviteRecord = {
    id: crypto.randomUUID(),
    groupId,
    inviterUserId,
    inviteeUserId,
    idempotencyKey,
    status: "PENDING",
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + REQUEST_TTL_MS).toISOString(),
    acceptedAt: null,
    revokedAt: null,
  };
  store().groupInvites.set(invite.id, invite);
  return invite;
}

function personDto(circle: DirectCircleRecord, currentUserId: string): Person {
  const relatedUserId = otherUserId(circle, currentUserId);
  const relatedUser = store().users.get(relatedUserId);
  if (!relatedUser) throw new Error("Dev relationship references a missing user");
  const mySharing = effectiveRecipientSharing(currentUserId,relatedUserId);
  const theirSharing = effectiveRecipientSharing(relatedUserId,currentUserId);
  const lastCheckInAt =
    theirSharing.mode === "OFF"
      ? null
      : latestAudienceCheckIn(
          circle.id,
          relatedUserId,
          currentUserId,
          theirSharing.enabledSince,
        );
  return {
    circleId: circle.id,
    user: publicUser(relatedUser),
    status: visibleStatus(relatedUser,currentUserId),
    connectedAt: circle.createdAt,
    mySharingMode: mySharing.mode,
    theirSharingMode: theirSharing.mode,
    checkInState:
      theirSharing.mode === "OFF"
        ? "HIDDEN"
        : lastCheckInAt
          ? "AVAILABLE"
          : theirSharing.resumed
            ? "WAITING_AFTER_REENABLE"
            : "WAITING_INITIAL",
    lastCheckInAt,
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
    timezoneId: "Europe/Moscow",
    lastCheckInAt: null,
    displayNameChangedAt: null,
    displayNameChangeKey: null,
    avatarUrl: null,
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

export type DevDisplayNameUpdateResult =
  | { kind: "ok"; value: MeResponse }
  | { kind: "unauthorized" }
  | { kind: "conflict" }
  | { kind: "cooldown"; availableAt: string; serverTime: string };

export function updateDevDisplayName(
  token: string | undefined,
  displayName: string,
  idempotencyKey: string,
  now = new Date(),
): DevDisplayNameUpdateResult {
  const user = sessionUser(token);
  if (!user) return { kind: "unauthorized" };
  const normalized = normalizeDisplayName(displayName);

  if (normalized === user.displayName) {
    return { kind: "ok", value: asMe(user, now) };
  }
  if (user.displayNameChangeKey === idempotencyKey) return { kind: "conflict" };

  const availableAt = user.displayNameChangedAt
    ? Date.parse(user.displayNameChangedAt) + 24 * 60 * 60_000
    : 0;
  if (availableAt > now.getTime()) {
    return {
      kind: "cooldown",
      availableAt: new Date(availableAt).toISOString(),
      serverTime: now.toISOString(),
    };
  }

  user.displayName = normalized;
  user.displayNameChangedAt = now.toISOString();
  user.displayNameChangeKey = idempotencyKey;
  return { kind: "ok", value: asMe(user, now) };
}

export type DevCheckInResult =
  | { kind: "accepted"; value: CheckInResponse }
  | {
      kind: "cooldown";
      checkedAt: string;
      streak: DailyStreak;
      serverTime: string;
      nextAllowedAt: string;
    }
  | { kind: "unauthorized" };

export function updateDevStatus(token: string | undefined, text: string, key: string): DevResult<MeResponse> {
  const user = sessionUser(token);
  if (!user) return { kind: "unauthorized" };
  user.statusWrites ??= new Map();
  if (user.statusWrites.has(key)) {
    return user.statusWrites.get(key) === text
      ? { kind: "ok", value: asMe(user) }
      : { kind: "conflict" };
  }
  if ((user.status?.text ?? "") !== text) {
    user.status = text ? { text, updatedAt: new Date().toISOString() } : null;
  }
  user.statusWrites.set(key, text);
  return { kind: "ok", value: asMe(user) };
}

export function createDevCheckIn(
  token: string | undefined,
  idempotencyKey: string,
): DevCheckInResult {
  const user = sessionUser(token);
  if (!user) return { kind: "unauthorized" };
  const currentStore = store();

  const replayKey = `${user.id}:${idempotencyKey}`;
  const replay = currentStore.idempotency.get(replayKey);
  if (replay) {
    const replayedAt = new Date();
    return {
      kind: "accepted",
      value: {
        ...replay,
        streak: streakForUser(user, replayedAt),
        serverTime: replayedAt.toISOString(),
        replayed: true,
      },
    };
  }

  const serverTime = new Date();
  const nextAllowedMs = user.lastCheckInAt
    ? Date.parse(user.lastCheckInAt) + COOLDOWN_MS
    : 0;

  if (nextAllowedMs > serverTime.getTime()) {
    return {
      kind: "cooldown",
      checkedAt: user.lastCheckInAt!,
      streak: streakForUser(user, serverTime),
      serverTime: serverTime.toISOString(),
      nextAllowedAt: new Date(nextAllowedMs).toISOString(),
    };
  }

  const checkedAt = serverTime.toISOString();
  const eventId = crypto.randomUUID();
  user.lastCheckInAt = checkedAt;
  currentStore.checkIns.set(eventId, {
    id: eventId,
    userId: user.id,
    checkedAt,
    localDate: formatLocalDate(serverTime, user.timezoneId),
  });
  const response: CheckInResponse = {
    eventId,
    checkedAt,
    checkInCount:
      [...currentStore.checkIns.values()].filter((event) => event.userId === user.id).length,
    streak: streakForUser(user, serverTime),
    serverTime: checkedAt,
    nextAllowedAt: new Date(serverTime.getTime() + COOLDOWN_MS).toISOString(),
    replayed: false,
  };

  for (const circle of activeCirclesForUser(user.id)) {
    const sharing = effectiveRecipientSharing(user.id,otherUserId(circle,user.id));
    if (sharing.mode === "OFF" || !sharing.enabledSince || sharing.enabledSince > checkedAt) continue;
    currentStore.audiences.push({
      eventId: response.eventId,
      actorUserId: user.id,
      recipientUserId: otherUserId(circle, user.id),
      circleId: circle.id,
      recipientMembershipId: null,
    });
  }

  for (const membership of activeGroupMembershipsForUser(user.id)) {
    const group = currentStore.groups.get(membership.groupId);
    if (!group || group.archivedAt !== null) continue;
    for (const recipient of activeGroupMemberships(membership.groupId)) {
      if (recipient.userId === user.id) continue;
      const sharing = effectiveRecipientSharing(user.id,recipient.userId);
      if (sharing.mode === "OFF" || !sharing.enabledSince || sharing.enabledSince > checkedAt) continue;
      currentStore.audiences.push({
        eventId: response.eventId,
        actorUserId: user.id,
        recipientUserId: recipient.userId,
        circleId: membership.groupId,
        recipientMembershipId: recipient.id,
      });
    }
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
  const audienceUserIds = new Set([...currentStore.users.keys()].filter(id => id !== currentUser.id && effectiveRecipientSharing(currentUser.id,id).mode !== "OFF"));

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
      audienceCount: audienceUserIds.size,
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
    preserveRecipientDenies(currentUser.id);
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
  setRecipientSharing(currentUser.id,otherUserId(circle,currentUser.id),sharingMode);
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

export function listDevGroups(token: string | undefined): DevResult<GroupsResponse> {
  const currentUser = sessionUser(token);
  if (!currentUser) return { kind: "unauthorized" };
  expireGroupInvites();
  const currentStore = store();
  const groups = [...currentStore.groups.values()]
    .map((group) => groupDto(group, currentUser.id))
    .filter((group): group is Group => group !== null)
    .sort((first, second) => first.title.localeCompare(second.title, "ru"));
  const pending = [...currentStore.groupInvites.values()].filter(
    (invite) =>
      invite.status === "PENDING" &&
      (invite.inviterUserId === currentUser.id || invite.inviteeUserId === currentUser.id),
  );
  return {
    kind: "ok",
    value: {
      groups,
      incomingInvites: pending
        .filter((invite) => invite.inviteeUserId === currentUser.id)
        .map((invite) => groupInviteDto(invite, currentUser.id)),
      outgoingInvites: pending
        .filter((invite) => invite.inviterUserId === currentUser.id)
        .map((invite) => groupInviteDto(invite, currentUser.id)),
      serverTime: new Date().toISOString(),
    },
  };
}

export function createDevGroup(
  token: string | undefined,
  title: string,
  emoji: string | null,
  inviteeCircleIds: string[],
  idempotencyKey: string,
): DevResult<GroupMutationResponse> {
  const currentUser = sessionUser(token);
  if (!currentUser) return { kind: "unauthorized" };
  const replay = [...store().groups.values()].find(
    (group) =>
      group.createdByUserId === currentUser.id &&
      group.creationIdempotencyKey === idempotencyKey,
  );
  if (replay) {
    return {
      kind: "ok",
      value: {
        groupId: replay.id,
        replayed: true,
        serverTime: new Date().toISOString(),
      },
    };
  }

  const activeOwnedGroups = [...store().groups.values()].filter(
    (group) => group.createdByUserId === currentUser.id && group.archivedAt === null,
  ).length;
  if (activeOwnedGroups >= 20) return { kind: "conflict" };

  const targets = [...new Set(inviteeCircleIds.map(
    (circleId) => targetFromDirectCircle(circleId, currentUser.id),
  ))];
  if (targets.some((target) => target === null)) return { kind: "forbidden" };
  if (targets.length > 20) return { kind: "conflict" };

  const now = new Date();
  const group: GroupRecord = {
    id: crypto.randomUUID(),
    title,
    emoji,
    createdByUserId: currentUser.id,
    creationIdempotencyKey: idempotencyKey,
    createdAt: now.toISOString(),
    archivedAt: null,
  };
  const ownerMembership: GroupMembershipRecord = {
    id: crypto.randomUUID(),
    groupId: group.id,
    userId: currentUser.id,
    role: "OWNER",
    joinedAt: group.createdAt,
    leftAt: null,
  };
  store().groups.set(group.id, group);
  store().groupMemberships.set(ownerMembership.id, ownerMembership);
  store().sharing.set(sharingKey(group.id, currentUser.id), {
    mode: "LATEST_ONLY",
    enabledSince: group.createdAt,
  });
  for (const target of targets) {
    if (target) createGroupInviteRecord(
      group.id,
      currentUser.id,
      target,
      crypto.randomUUID(),
      now,
    );
  }
  return {
    kind: "ok",
    value: { groupId: group.id, replayed: false, serverTime: group.createdAt },
  };
}

export function updateDevGroup(
  token: string | undefined,
  groupId: string,
  title: string,
  emoji: string | null,
): DevResult<GroupMutationResponse> {
  const currentUser = sessionUser(token);
  if (!currentUser) return { kind: "unauthorized" };
  const group = store().groups.get(groupId);
  const membership = activeGroupMembership(groupId, currentUser.id);
  if (!group || group.archivedAt !== null || !membership) return { kind: "not-found" };
  if (membership.role !== "OWNER") return { kind: "forbidden" };
  group.title = title;
  group.emoji = emoji;
  return {
    kind: "ok",
    value: { groupId, replayed: false, serverTime: new Date().toISOString() },
  };
}

export function updateDevGroupSharing(
  token: string | undefined,
  groupId: string,
  sharingMode: SharingMode,
): DevResult<GroupMutationResponse> {
  const currentUser = sessionUser(token);
  if (!currentUser) return { kind: "unauthorized" };
  const group = store().groups.get(groupId);
  if (!group || group.archivedAt !== null || !activeGroupMembership(groupId, currentUser.id)) {
    return { kind: "not-found" };
  }
  for (const member of activeGroupMemberships(groupId)) {
    if (member.userId !== currentUser.id) setRecipientSharing(currentUser.id,member.userId,sharingMode);
  }
  const previous = store().sharing.get(sharingKey(groupId, currentUser.id));
  const latestStoredCheckIn = Math.max(
    0,
    ...[...store().checkIns.values()].map((event) => Date.parse(event.checkedAt)),
  );
  store().sharing.set(sharingKey(groupId, currentUser.id), {
    mode: sharingMode,
    enabledSince:
      sharingMode === "OFF"
        ? null
        : previous?.mode === "LATEST_ONLY" && previous.enabledSince
          ? previous.enabledSince
          : new Date(Math.max(Date.now(), latestStoredCheckIn + 1)).toISOString(),
  });
  return {
    kind: "ok",
    value: { groupId, replayed: false, serverTime: new Date().toISOString() },
  };
}

export function inviteDevGroupMember(
  token: string | undefined,
  groupId: string,
  personCircleId: string,
  idempotencyKey: string,
): DevResult<GroupMutationResponse> {
  const currentUser = sessionUser(token);
  if (!currentUser) return { kind: "unauthorized" };
  const group = store().groups.get(groupId);
  const membership = activeGroupMembership(groupId, currentUser.id);
  if (!group || group.archivedAt !== null || !membership) return { kind: "not-found" };
  if (membership.role !== "OWNER") return { kind: "forbidden" };
  const targetUserId = targetFromDirectCircle(personCircleId, currentUser.id);
  if (!targetUserId) return { kind: "forbidden" };
  if (activeGroupMembership(groupId, targetUserId)) return { kind: "conflict" };

  const replay = [...store().groupInvites.values()].find(
    (invite) =>
      invite.inviterUserId === currentUser.id && invite.idempotencyKey === idempotencyKey,
  );
  if (replay) {
    if (replay.groupId !== groupId || replay.inviteeUserId !== targetUserId) {
      return { kind: "conflict" };
    }
    return {
      kind: "ok",
      value: { groupId, replayed: true, serverTime: new Date().toISOString() },
    };
  }
  expireGroupInvites();
  const existing = [...store().groupInvites.values()].find(
    (invite) =>
      invite.groupId === groupId &&
      invite.inviteeUserId === targetUserId &&
      invite.status === "PENDING",
  );
  if (existing) {
    return {
      kind: "ok",
      value: { groupId, replayed: true, serverTime: new Date().toISOString() },
    };
  }
  const activeMembersAndInvites = activeGroupMemberships(groupId).length
    + [...store().groupInvites.values()].filter(
      (invite) => invite.groupId === groupId && invite.status === "PENDING",
    ).length;
  if (activeMembersAndInvites >= 50) return { kind: "conflict" };
  const now = new Date();
  createGroupInviteRecord(groupId, currentUser.id, targetUserId, idempotencyKey, now);
  return {
    kind: "ok",
    value: { groupId, replayed: false, serverTime: now.toISOString() },
  };
}

export function actOnDevGroupInvite(
  token: string | undefined,
  inviteId: string,
  action: "ACCEPTED" | "REVOKED",
): DevResult<GroupMutationResponse> {
  const currentUser = sessionUser(token);
  if (!currentUser) return { kind: "unauthorized" };
  const invite = store().groupInvites.get(inviteId);
  if (!invite) return { kind: "not-found" };
  if (invite.inviteeUserId !== currentUser.id) return { kind: "forbidden" };
  if (invite.status !== "PENDING") {
    if (invite.status !== action) return { kind: "conflict" };
    return {
      kind: "ok",
      value: { groupId: invite.groupId, replayed: true, serverTime: new Date().toISOString() },
    };
  }
  if (Date.parse(invite.expiresAt) <= Date.now()) {
    invite.status = "REVOKED";
    invite.revokedAt = new Date().toISOString();
    return { kind: "expired" };
  }
  const group = store().groups.get(invite.groupId);
  if (!group || group.archivedAt !== null) return { kind: "not-found" };
  const now = new Date().toISOString();
  invite.status = action;
  if (action === "ACCEPTED") {
    invite.acceptedAt = now;
    if (!activeGroupMembership(invite.groupId, currentUser.id)) {
      const membership: GroupMembershipRecord = {
        id: crypto.randomUUID(),
        groupId: invite.groupId,
        userId: currentUser.id,
        role: "MEMBER",
        joinedAt: now,
        leftAt: null,
      };
      store().groupMemberships.set(membership.id, membership);
      store().sharing.set(sharingKey(invite.groupId, currentUser.id), {
        mode: "LATEST_ONLY",
        enabledSince: now,
      });
    }
    preserveRecipientDenies(currentUser.id);
  } else {
    invite.revokedAt = now;
  }
  return {
    kind: "ok",
    value: { groupId: invite.groupId, replayed: false, serverTime: now },
  };
}

export function revokeDevGroupInvite(
  token: string | undefined,
  groupId: string,
  inviteId: string,
): DevResult<{ serverTime: string }> {
  const currentUser = sessionUser(token);
  if (!currentUser) return { kind: "unauthorized" };
  const membership = activeGroupMembership(groupId, currentUser.id);
  const invite = store().groupInvites.get(inviteId);
  if (!membership || !invite || invite.groupId !== groupId) return { kind: "not-found" };
  if (membership.role !== "OWNER" || invite.inviterUserId !== currentUser.id) {
    return { kind: "forbidden" };
  }
  if (invite.status === "PENDING") {
    invite.status = "REVOKED";
    invite.revokedAt = new Date().toISOString();
  }
  return { kind: "ok", value: { serverTime: new Date().toISOString() } };
}

export function removeDevGroupMember(
  token: string | undefined,
  groupId: string,
  membershipId: string,
): DevResult<{ serverTime: string }> {
  const currentUser = sessionUser(token);
  if (!currentUser) return { kind: "unauthorized" };
  const target = store().groupMemberships.get(membershipId);
  if (!target || target.groupId !== groupId) {
    return { kind: "not-found" };
  }
  const removingSelf = target.userId === currentUser.id;
  const mine = activeGroupMembership(groupId, currentUser.id);
  if (target.leftAt !== null) {
    if (removingSelf || (mine?.role === "OWNER" && target.role !== "OWNER")) {
      return { kind: "ok", value: { serverTime: target.leftAt } };
    }
    return mine ? { kind: "forbidden" } : { kind: "not-found" };
  }
  if (!mine) return { kind: "not-found" };
  if ((!removingSelf && mine.role !== "OWNER") || target.role === "OWNER") {
    return { kind: "forbidden" };
  }
  const now = new Date().toISOString();
  store().sharing.set(sharingKey(groupId, target.userId), { mode: "OFF", enabledSince: null });
  target.leftAt = now;
  return { kind: "ok", value: { serverTime: now } };
}

export function deleteDevGroup(
  token: string | undefined,
  groupId: string,
): DevResult<{ serverTime: string }> {
  const currentUser = sessionUser(token);
  if (!currentUser) return { kind: "unauthorized" };
  const group = store().groups.get(groupId);
  const mine = activeGroupMembership(groupId, currentUser.id);
  if (!group || (!mine && group.archivedAt === null)) return { kind: "not-found" };
  if (group.createdByUserId !== currentUser.id) return { kind: "forbidden" };
  if (group.archivedAt) return { kind: "ok", value: { serverTime: group.archivedAt } };
  const now = new Date().toISOString();
  for (const membership of activeGroupMemberships(groupId)) {
    store().sharing.set(sharingKey(groupId, membership.userId), { mode: "OFF", enabledSince: null });
    membership.leftAt = now;
  }
  for (const invite of store().groupInvites.values()) {
    if (invite.groupId === groupId && invite.status === "PENDING") {
      invite.status = "REVOKED";
      invite.revokedAt = now;
    }
  }
  group.archivedAt = now;
  return { kind: "ok", value: { serverTime: now } };
}

function ensureDevDirectCircle(firstUserId: string, secondUserId: string, now: string) {
  let circle = activeCircleForPair(firstUserId, secondUserId);
  if (circle) return circle;
  const [lowUserId, highUserId] = orderedPair(firstUserId, secondUserId);
  circle = { id: crypto.randomUUID(), lowUserId, highUserId, createdAt: now, archivedAt: null };
  store().circles.set(circle.id, circle);
  store().sharing.set(sharingKey(circle.id, lowUserId), { mode: "LATEST_ONLY", enabledSince: now });
  store().sharing.set(sharingKey(circle.id, highUserId), { mode: "LATEST_ONLY", enabledSince: now });
  preserveRecipientDenies(firstUserId);
  return circle;
}

function expireDevCapabilityLinks(nowMs = Date.now()) {
  for (const link of store().directInviteLinks.values()) {
    if (link.status === "PENDING" && Date.parse(link.expiresAt) <= nowMs) link.status = "EXPIRED";
  }
}

export function createDevDirectInviteLink(
  sessionToken: string | undefined,
  capabilityToken: string,
  idempotencyKey: string,
  now = new Date(),
): DevResult<DirectInviteLink> {
  const inviter = sessionUser(sessionToken);
  if (!inviter) return { kind: "unauthorized" };
  expireDevCapabilityLinks(now.getTime());
  const replay = [...store().directInviteLinks.values()].find(
    (link) => link.inviterUserId === inviter.id && link.idempotencyKey === idempotencyKey,
  );
  if (replay) {
    if (replay.token !== capabilityToken) return { kind: "conflict" };
    return { kind: "ok", value: {
      inviteId: replay.id, expiresAt: replay.expiresAt, replayed: true, serverTime: now.toISOString(),
    } };
  }
  for (const link of store().directInviteLinks.values()) {
    if (link.inviterUserId === inviter.id && link.status === "PENDING") link.status = "REVOKED";
  }
  const link: DirectInviteLinkRecord = {
    id: crypto.randomUUID(), inviterUserId: inviter.id, token: capabilityToken, idempotencyKey,
    status: "PENDING", acceptedByUserId: null, acceptedIdempotencyKey: null, resultCircleId: null,
    createdAt: now.toISOString(), expiresAt: new Date(now.getTime() + REQUEST_TTL_MS).toISOString(),
  };
  store().directInviteLinks.set(link.id, link);
  return { kind: "ok", value: {
    inviteId: link.id, expiresAt: link.expiresAt, replayed: false, serverTime: link.createdAt,
  } };
}

export function previewDevDirectInvite(
  capabilityToken: string,
  now = new Date(),
): DevResult<DirectInvitePreview> {
  expireDevCapabilityLinks(now.getTime());
  const link = [...store().directInviteLinks.values()].find((item) => item.token === capabilityToken);
  if (!link) return { kind: "not-found" };
  if (link.status !== "PENDING") return { kind: "expired" };
  const inviter = store().users.get(link.inviterUserId);
  if (!inviter) return { kind: "not-found" };
  return { kind: "ok", value: {
    inviter: publicUser(inviter), expiresAt: link.expiresAt, serverTime: now.toISOString(),
  } };
}

export function redeemDevDirectInvite(
  sessionToken: string | undefined,
  capabilityToken: string,
  idempotencyKey: string,
  now = new Date(),
): DevResult<DirectInviteRedeemResponse> {
  const recipient = sessionUser(sessionToken);
  if (!recipient) return { kind: "unauthorized" };
  expireDevCapabilityLinks(now.getTime());
  const keyedLink = [...store().directInviteLinks.values()].find(
    (item) =>
      item.acceptedByUserId === recipient.id &&
      item.acceptedIdempotencyKey === idempotencyKey,
  );
  const link = [...store().directInviteLinks.values()].find((item) => item.token === capabilityToken);
  if (keyedLink && keyedLink.id !== link?.id) return { kind: "conflict" };
  if (!link) return { kind: "not-found" };
  if (link.inviterUserId === recipient.id) return { kind: "self" };
  if (link.status === "ACCEPTED") {
    if (
      link.acceptedByUserId !== recipient.id ||
      link.acceptedIdempotencyKey !== idempotencyKey ||
      !link.resultCircleId
    ) return { kind: "conflict" };
    const circle = store().circles.get(link.resultCircleId);
    if (!circle) return { kind: "conflict" };
    return { kind: "ok", value: {
      person: personDto(circle, recipient.id), replayed: true, serverTime: now.toISOString(),
    } };
  }
  if (link.status !== "PENDING") return { kind: "expired" };
  const acceptedAt = now.toISOString();
  const circle = ensureDevDirectCircle(link.inviterUserId, recipient.id, acceptedAt);
  const pending = pendingRequestForPair(link.inviterUserId, recipient.id);
  if (pending) { pending.status = "CANCELLED"; pending.respondedAt = acceptedAt; }
  link.status = "ACCEPTED";
  link.acceptedByUserId = recipient.id;
  link.acceptedIdempotencyKey = idempotencyKey;
  link.resultCircleId = circle.id;
  return {
    kind: "ok",
    value: { person: personDto(circle, recipient.id), replayed: false, serverTime: acceptedAt },
  };
}


function recoveryHash(value:string):string {return createHash("sha256").update(value).digest("hex")}
export function devRecoveryCodeState(token:string|undefined):{active:boolean}|null {
  const user=sessionUser(token);
  return user?{active:[...store().recoveryCodes.values()].some(r=>r.userId===user.id && r.active)}:null;
}
export function activateDevRecoveryCode(token:string|undefined,code:string):DevResult<{active:boolean}> {
  const user=sessionUser(token);
  if(!user)return {kind:"unauthorized"};
  const hash=recoveryHash(code),prior=store().recoveryCodes.get(hash);
  if(prior)return prior.userId===user.id && prior.active?{kind:"ok",value:{active:true}}:{kind:"conflict"};
  for(const row of store().recoveryCodes.values())if(row.userId===user.id)row.active=false;
  store().recoveryCodes.set(hash,{userId:user.id,active:true});
  return {kind:"ok",value:{active:true}};
}
export function redeemDevRecoveryCode(code:string,retrySecret:string):{token:string;me:MeResponse}|null {
  const row=store().recoveryCodes.get(recoveryHash(code));
  if(!row)return null;
  if(!row.active){
    if(row.consumedAt===undefined || Date.now()-row.consumedAt>=600_000 || row.retryHash!==recoveryHash(retrySecret) || !row.sessionToken)return null;
    const me=getDevIdentity(row.sessionToken);return me?{token:row.sessionToken,me}:null;
  }
  for(const [key,session]of store().sessions)if(session.userId===row.userId)store().sessions.delete(key);
  // A bootstrap retry must not resurrect a session after recovery.
  for(const [key,id]of store().bootstrapKeys)if(id===row.userId)store().bootstrapKeys.delete(key);
  const token=randomToken();
  store().sessions.set(token,{userId:row.userId,expiresAt:Date.now()+365*24*60*60_000});
  row.active=false;row.consumedAt=Date.now();row.retryHash=recoveryHash(retrySecret);row.sessionToken=token;
  return {token,me:asMe(store().users.get(row.userId)!)};
}
