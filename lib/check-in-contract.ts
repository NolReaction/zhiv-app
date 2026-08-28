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
