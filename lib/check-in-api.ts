import { z } from "zod";
import type {
  ApiErrorResponse,
  CheckInResponse,
  ClickerSeriesEvent,
  CooldownResponse,
  DisplayNameCooldownResponse,
  DirectRequestActionResponse,
  DirectRequestResponse,
  GroupMutationResponse,
  GroupsResponse,
  MeResponse,
  PeopleResponse,
  SharingMode,
  SharingResponse,
  UserLookupResponse,
} from "@/lib/check-in-contract";

const userSchema = z.object({
  publicId: z.string().regex(/^[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){2}$/),
  displayName: z.string().refine((value) => {
    const length = Array.from(value).length;
    return length >= 1 && length <= 50;
  }),
});

const dailyStreakSchema = z.object({
  currentDays: z.number().int().nonnegative().safe(),
  longestDays: z.number().int().nonnegative().safe(),
  checkedInToday: z.boolean(),
  nextDayAt: z.string().datetime(),
});

const profileStateSchema = z.object({
  avatarUrl: z.string().url().nullable(),
  displayNameChangedAt: z.string().datetime().nullable(),
  displayNameChangeAvailableAt: z.string().datetime().nullable(),
});

const meSchema: z.ZodType<MeResponse> = z.object({
  user: userSchema,
  lastCheckInAt: z.string().datetime().nullable(),
  checkInCount: z.number().int().nonnegative().safe(),
  streak: dailyStreakSchema,
  profile: profileStateSchema,
  serverTime: z.string().datetime(),
});

const checkInSchema: z.ZodType<CheckInResponse> = z.object({
  eventId: z.string().uuid(),
  checkedAt: z.string().datetime(),
  checkInCount: z.number().int().nonnegative().safe(),
  streak: dailyStreakSchema,
  serverTime: z.string().datetime(),
  nextAllowedAt: z.string().datetime(),
  replayed: z.boolean(),
});

const cooldownSchema: z.ZodType<CooldownResponse> = z.object({
  code: z.literal("CHECK_IN_COOLDOWN"),
  checkedAt: z.string().datetime(),
  streak: dailyStreakSchema,
  serverTime: z.string().datetime(),
  nextAllowedAt: z.string().datetime(),
});

const displayNameCooldownSchema: z.ZodType<DisplayNameCooldownResponse> = z.object({
  code: z.literal("DISPLAY_NAME_COOLDOWN"),
  message: z.string(),
  availableAt: z.string().datetime(),
  serverTime: z.string().datetime(),
});

const sharingModeSchema = z.enum(["OFF", "LATEST_ONLY"]);
const directRequestSchema = z.object({
  requestId: z.string().uuid(),
  direction: z.enum(["INCOMING", "OUTGOING"]),
  user: userSchema,
  createdAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
});
const personSchema = z.object({
  circleId: z.string().uuid(),
  user: userSchema,
  connectedAt: z.string().datetime(),
  mySharingMode: sharingModeSchema,
  theirSharingMode: sharingModeSchema,
  checkInState: z.enum([
    "HIDDEN",
    "WAITING_INITIAL",
    "WAITING_AFTER_REENABLE",
    "AVAILABLE",
  ]),
  lastCheckInAt: z.string().datetime().nullable(),
});
const peopleSchema: z.ZodType<PeopleResponse> = z.object({
  people: z.array(personSchema),
  incomingRequests: z.array(directRequestSchema),
  outgoingRequests: z.array(directRequestSchema),
  audienceCount: z.number().int().nonnegative(),
  serverTime: z.string().datetime(),
});
const lookupSchema: z.ZodType<UserLookupResponse> = z.object({
  user: userSchema,
  relationshipState: z.enum([
    "SELF",
    "NONE",
    "CONNECTED",
    "INCOMING_REQUEST",
    "OUTGOING_REQUEST",
  ]),
  serverTime: z.string().datetime(),
});
const directRequestResponseSchema: z.ZodType<DirectRequestResponse> = z.object({
  request: directRequestSchema,
  replayed: z.boolean(),
  serverTime: z.string().datetime(),
});
const directRequestActionSchema: z.ZodType<DirectRequestActionResponse> = z.object({
  requestId: z.string().uuid(),
  status: z.enum(["ACCEPTED", "REJECTED", "CANCELLED"]),
  person: personSchema.nullable(),
  replayed: z.boolean(),
  serverTime: z.string().datetime(),
});
const sharingResponseSchema: z.ZodType<SharingResponse> = z.object({
  circleId: z.string().uuid(),
  sharingMode: sharingModeSchema,
  serverTime: z.string().datetime(),
});
const groupTitleSchema = z.string().min(1).refine(
  (value) => Array.from(value).length <= 64,
  "Group title is too long",
);
const groupEmojiSchema = z.string().refine(
  (value) => Array.from(value).length <= 16,
  "Group emoji is too long",
).nullable();
const groupInviteSchema = z.object({
  inviteId: z.string().uuid(),
  direction: z.enum(["INCOMING", "OUTGOING"]),
  groupId: z.string().uuid(),
  groupTitle: groupTitleSchema,
  groupEmoji: groupEmojiSchema,
  user: userSchema,
  createdAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
});
const groupMemberSchema = z.object({
  membershipId: z.string().uuid(),
  user: userSchema,
  role: z.enum(["OWNER", "ADMIN", "MEMBER"]),
  sharingMode: sharingModeSchema,
  lastCheckInAt: z.string().datetime().nullable(),
  joinedAt: z.string().datetime(),
  isMe: z.boolean(),
});
const groupSchema = z.object({
  groupId: z.string().uuid(),
  title: groupTitleSchema,
  emoji: groupEmojiSchema,
  myRole: z.enum(["OWNER", "ADMIN", "MEMBER"]),
  mySharingMode: sharingModeSchema,
  createdAt: z.string().datetime(),
  members: z.array(groupMemberSchema),
  pendingInvites: z.array(groupInviteSchema),
});
const groupsSchema: z.ZodType<GroupsResponse> = z.object({
  groups: z.array(groupSchema),
  incomingInvites: z.array(groupInviteSchema),
  outgoingInvites: z.array(groupInviteSchema),
  serverTime: z.string().datetime(),
});
const groupMutationSchema: z.ZodType<GroupMutationResponse> = z.object({
  groupId: z.string().uuid(),
  replayed: z.boolean(),
  serverTime: z.string().datetime(),
});

const errorSchema: z.ZodType<ApiErrorResponse> = z.object({
  code: z.string(),
  message: z.string(),
});

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body?: ApiErrorResponse | CooldownResponse | DisplayNameCooldownResponse,
  ) {
    super(message);
  }
}

export function isCheckInCooldownResponse(value: unknown): value is CooldownResponse {
  return cooldownSchema.safeParse(value).success;
}

export function isDisplayNameCooldownResponse(
  value: unknown,
): value is DisplayNameCooldownResponse {
  return displayNameCooldownSchema.safeParse(value).success;
}

async function request<T>(
  path: string,
  schema: z.ZodType<T>,
  init?: RequestInit,
): Promise<T> {
  const response = await fetch(path, {
    ...init,
    cache: "no-store",
    credentials: "same-origin",
    signal: init?.signal ?? AbortSignal.timeout(8_000),
    headers: {
      Accept: "application/json",
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
      ...init?.headers,
    },
  });

  const contentType = response.headers.get("content-type") ?? "";
  const body = contentType.includes("application/json")
    ? await response.json().catch(() => undefined)
    : undefined;

  if (!response.ok) {
    const knownError = cooldownSchema.safeParse(body).success
      ? cooldownSchema.parse(body)
      : displayNameCooldownSchema.safeParse(body).success
        ? displayNameCooldownSchema.parse(body)
        : errorSchema.safeParse(body).success
          ? errorSchema.parse(body)
          : undefined;
    const message =
      knownError && "message" in knownError
        ? knownError.message
        : "Не удалось связаться с сервером";
    throw new ApiError(message, response.status, knownError);
  }

  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw new ApiError("Сервер вернул некорректный ответ", 502);
  }
  return parsed.data;
}

export async function getMe(): Promise<MeResponse | null> {
  try {
    return await request<MeResponse>("/api/v1/me", meSchema);
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) return null;
    throw error;
  }
}

export function bootstrap(displayName: string, idempotencyKey: string): Promise<MeResponse> {
  return request<MeResponse>("/api/v1/bootstrap", meSchema, {
    method: "POST",
    headers: { "Idempotency-Key": idempotencyKey },
    body: JSON.stringify({ displayName }),
  });
}

export function createCheckIn(idempotencyKey: string): Promise<CheckInResponse> {
  return request<CheckInResponse>("/api/v1/check-ins", checkInSchema, {
    method: "POST",
    headers: { "Idempotency-Key": idempotencyKey },
  });
}

export async function reportClickerSeries(event: ClickerSeriesEvent): Promise<void> {
  const response = await fetch("/api/v1/game-events", {
    method: "POST",
    cache: "no-store",
    credentials: "same-origin",
    keepalive: true,
    signal: AbortSignal.timeout(4_000),
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(event),
  });
  if (!response.ok) {
    throw new ApiError("Не удалось записать игровое событие", response.status);
  }
}

export function updateMyDisplayName(
  displayName: string,
  idempotencyKey: string,
): Promise<MeResponse> {
  return request<MeResponse>("/api/v1/me", meSchema, {
    method: "PATCH",
    headers: { "Idempotency-Key": idempotencyKey },
    body: JSON.stringify({ displayName }),
  });
}

export function lookupUser(publicId: string): Promise<UserLookupResponse> {
  return request<UserLookupResponse>(
    `/api/v1/users/${encodeURIComponent(publicId)}`,
    lookupSchema,
  );
}

export function getPeople(signal?: AbortSignal): Promise<PeopleResponse> {
  return request<PeopleResponse>("/api/v1/people", peopleSchema, { signal });
}

export function sendDirectRequest(
  publicId: string,
  idempotencyKey: string,
): Promise<DirectRequestResponse> {
  return request<DirectRequestResponse>(
    "/api/v1/direct-requests",
    directRequestResponseSchema,
    {
      method: "POST",
      headers: { "Idempotency-Key": idempotencyKey },
      body: JSON.stringify({ publicId }),
    },
  );
}

export function actOnDirectRequest(
  requestId: string,
  action: "accept" | "reject" | "cancel",
  idempotencyKey: string,
): Promise<DirectRequestActionResponse> {
  return request<DirectRequestActionResponse>(
    `/api/v1/direct-requests/${requestId}/${action}`,
    directRequestActionSchema,
    {
      method: "POST",
      headers: { "Idempotency-Key": idempotencyKey },
    },
  );
}

export function updatePersonSharing(
  circleId: string,
  sharingMode: SharingMode,
  idempotencyKey: string,
): Promise<SharingResponse> {
  return request<SharingResponse>(
    `/api/v1/people/${circleId}/sharing`,
    sharingResponseSchema,
    {
      method: "PATCH",
      headers: { "Idempotency-Key": idempotencyKey },
      body: JSON.stringify({ sharingMode }),
    },
  );
}

export function removePerson(circleId: string, idempotencyKey: string): Promise<void> {
  return request<void>(`/api/v1/people/${circleId}`, z.void(), {
    method: "DELETE",
    headers: { "Idempotency-Key": idempotencyKey },
  });
}

export function getGroups(signal?: AbortSignal): Promise<GroupsResponse> {
  return request<GroupsResponse>("/api/v1/groups", groupsSchema, { signal });
}

export function createGroup(
  title: string,
  emoji: string | null,
  inviteeCircleIds: string[],
  idempotencyKey: string,
): Promise<GroupMutationResponse> {
  return request<GroupMutationResponse>("/api/v1/groups", groupMutationSchema, {
    method: "POST",
    headers: { "Idempotency-Key": idempotencyKey },
    body: JSON.stringify({ title, emoji, inviteeCircleIds }),
  });
}

export function updateGroup(
  groupId: string,
  title: string,
  emoji: string | null,
  idempotencyKey: string,
): Promise<GroupMutationResponse> {
  return request<GroupMutationResponse>(`/api/v1/groups/${groupId}`, groupMutationSchema, {
    method: "PATCH",
    headers: { "Idempotency-Key": idempotencyKey },
    body: JSON.stringify({ title, emoji }),
  });
}

export function updateGroupSharing(
  groupId: string,
  sharingMode: SharingMode,
  idempotencyKey: string,
): Promise<GroupMutationResponse> {
  return request<GroupMutationResponse>(
    `/api/v1/groups/${groupId}/sharing`,
    groupMutationSchema,
    {
      method: "PATCH",
      headers: { "Idempotency-Key": idempotencyKey },
      body: JSON.stringify({ sharingMode }),
    },
  );
}

export function inviteToGroup(
  groupId: string,
  personCircleId: string,
  idempotencyKey: string,
): Promise<GroupMutationResponse> {
  return request<GroupMutationResponse>(
    `/api/v1/groups/${groupId}/invites`,
    groupMutationSchema,
    {
      method: "POST",
      headers: { "Idempotency-Key": idempotencyKey },
      body: JSON.stringify({ personCircleId }),
    },
  );
}

export function actOnGroupInvite(
  inviteId: string,
  action: "accept" | "reject",
  idempotencyKey: string,
): Promise<GroupMutationResponse> {
  return request<GroupMutationResponse>(
    `/api/v1/group-invites/${inviteId}/${action}`,
    groupMutationSchema,
    { method: "POST", headers: { "Idempotency-Key": idempotencyKey } },
  );
}

export function revokeGroupInvite(
  groupId: string,
  inviteId: string,
  idempotencyKey: string,
): Promise<void> {
  return request<void>(`/api/v1/groups/${groupId}/invites/${inviteId}`, z.void(), {
    method: "DELETE",
    headers: { "Idempotency-Key": idempotencyKey },
  });
}

export function removeGroupMember(
  groupId: string,
  membershipId: string,
  idempotencyKey: string,
): Promise<void> {
  return request<void>(`/api/v1/groups/${groupId}/members/${membershipId}`, z.void(), {
    method: "DELETE",
    headers: { "Idempotency-Key": idempotencyKey },
  });
}

export function deleteGroup(groupId: string, idempotencyKey: string): Promise<void> {
  return request<void>(`/api/v1/groups/${groupId}`, z.void(), {
    method: "DELETE",
    headers: { "Idempotency-Key": idempotencyKey },
  });
}
