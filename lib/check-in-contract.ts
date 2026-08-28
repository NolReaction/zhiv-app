export type PublicUser = {
  publicId: string;
  displayName: string;
};

export type MeResponse = {
  user: PublicUser;
  lastCheckInAt: string | null;
  serverTime: string;
};

export type CheckInResponse = {
  eventId: string;
  checkedAt: string;
  serverTime: string;
  nextAllowedAt: string;
  replayed: boolean;
};

export type CooldownResponse = {
  code: "CHECK_IN_COOLDOWN";
  checkedAt: string;
  serverTime: string;
  nextAllowedAt: string;
};

export type ApiErrorResponse = {
  code: string;
  message: string;
};

export type SharingMode = "OFF" | "LATEST_ONLY";

export type RelationshipState =
  | "SELF"
  | "NONE"
  | "CONNECTED"
  | "INCOMING_REQUEST"
  | "OUTGOING_REQUEST";

export type UserLookupResponse = {
  user: PublicUser;
  relationshipState: RelationshipState;
  serverTime: string;
};

export type DirectRequestDirection = "INCOMING" | "OUTGOING";

export type DirectRequest = {
  requestId: string;
  direction: DirectRequestDirection;
  user: PublicUser;
  createdAt: string;
  expiresAt: string;
};

export type Person = {
  circleId: string;
  user: PublicUser;
  connectedAt: string;
  mySharingMode: SharingMode;
  theirSharingMode: SharingMode;
  lastCheckInAt: string | null;
};

export type PeopleResponse = {
  people: Person[];
  incomingRequests: DirectRequest[];
  outgoingRequests: DirectRequest[];
  audienceCount: number;
  serverTime: string;
};

export type DirectRequestResponse = {
  request: DirectRequest;
  replayed: boolean;
  serverTime: string;
};

export type DirectRequestActionResponse = {
  requestId: string;
  status: "ACCEPTED" | "REJECTED" | "CANCELLED";
  person: Person | null;
  replayed: boolean;
  serverTime: string;
};

export type SharingResponse = {
  circleId: string;
  sharingMode: SharingMode;
  serverTime: string;
};
