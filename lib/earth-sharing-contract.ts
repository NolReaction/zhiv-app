import { z } from "zod";
import type { PublicUser } from "./check-in-contract";
import { playerTagSchema } from "./player-tag";

export const EARTH_POSITION_TTL_MS = 24 * 60 * 60_000;
export const EARTH_POSITION_MAX_AGE_MS = 60_000;
export const EARTH_POSITION_FUTURE_MS = 10_000;
export const EARTH_POSITION_PUBLISH_MS = 30_000;
export const EARTH_PEOPLE_POLL_MS = 5_000;
export const EARTH_SETTINGS_POLL_MS = 30_000;
export const EARTH_SHARING_MAX_PEOPLE = 100;
export const EARTH_APPROXIMATE_ACCURACY_METERS = 1_500;

export type EarthSharingMode = "OFF" | "SHARING" | "GHOST";
export type EarthSharingPrecision = "APPROXIMATE" | "PRECISE";
export type EarthSharingDuration = 60 | 480 | null;

export type EarthSharingSettings = {
  ownerPublicId: string;
  mode: EarthSharingMode;
  revision: number;
  precision: EarthSharingPrecision;
  recipientCircleIds: string[];
  /** Owner-only preferences; recipients never receive a freeze flag. */
  frozenCircleIds: string[];
  sharingUntil: string | null;
  /** Granted by a SHARING write or a scoped resume; GET always returns null. */
  publicationEpoch: string | null;
  serverTime: string;
};

export type EarthSharingWrite = {
  expectedOwnerPublicId: string;
  expectedRevision: number;
  mode: EarthSharingMode;
  precision: EarthSharingPrecision;
  recipientCircleIds: string[];
  frozenCircleIds?: string[];
  /** Narrow privacy update: preserve the current lease, mode and deadline. */
  frozenOnly?: boolean;
  /** Add recipients while retaining existing precision, exact deadline and GHOST. */
  preserveSharingUntil?: boolean;
  durationMinutes: EarthSharingDuration;
};

/** Acquire a publisher for existing consent without changing its audience or deadline. */
export type EarthSharingResume = {
  expectedOwnerPublicId: string;
  expectedRevision: number;
  /** Only an explicit user action may leave GHOST. */
  resumeGhost?: boolean;
};

export type EarthPositionWrite = {
  expectedOwnerPublicId: string;
  publicationEpoch: string;
  sequence: number;
  latitude: number;
  longitude: number;
  accuracyMeters: number;
  capturedAt: string;
};

export type EarthPositionReceipt = {
  ownerPublicId: string;
  acceptedAt: string;
  expiresAt: string;
  serverTime: string;
};

export type EarthPositionStop = { expectedOwnerPublicId: string; publicationEpoch: string };
export type EarthPositionStopped = { ownerPublicId: string; serverTime: string };

export type EarthSharedPerson = {
  circleId: string;
  user: PublicUser;
  latitude: number;
  longitude: number;
  accuracyMeters: number;
  precision: EarthSharingPrecision;
  updatedAt: string;
  expiresAt: string;
};

/** Local RAM only. A monotonic deadline prevents wall-clock rollback extending access. */
export type EarthMapPerson = EarthSharedPerson & { expiresAtMonotonic: number };
export type EarthPeopleResponse = { ownerPublicId: string; people: EarthSharedPerson[]; serverTime: string };

const owner = z.string().regex(/^[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){2}$/);
const uuid = z.string().uuid();
const revision = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER - 1);
const precision = z.enum(["APPROXIMATE", "PRECISE"]);
const circleIds = z.array(uuid).max(EARTH_SHARING_MAX_PEOPLE).refine(ids => new Set(ids).size === ids.length);
const timestamp = z.string().datetime();

export const earthSharingSettingsSchema = z.object({
  ownerPublicId: owner, mode: z.enum(["OFF", "SHARING", "GHOST"]), revision, precision,
  recipientCircleIds: circleIds, frozenCircleIds: circleIds.default([]), sharingUntil: timestamp.nullable(), publicationEpoch: uuid.nullable(), serverTime: timestamp,
}).strict().refine(value => value.frozenCircleIds.every(id => value.recipientCircleIds.includes(id)));

export const earthSharingWriteSchema = z.object({
  expectedOwnerPublicId: owner, expectedRevision: revision, mode: z.enum(["OFF", "SHARING", "GHOST"]), precision,
  recipientCircleIds: circleIds, frozenCircleIds: circleIds.default([]), frozenOnly: z.boolean().default(false), preserveSharingUntil: z.boolean().default(false),
  durationMinutes: z.union([z.literal(60), z.literal(480)]).nullable(),
}).strict().refine(value => (value.mode !== "SHARING" || value.recipientCircleIds.length > 0 || value.frozenOnly)
  && (value.mode !== "SHARING" || value.frozenCircleIds.every(id => value.recipientCircleIds.includes(id))));

export const earthSharingResumeSchema = z.object({
  expectedOwnerPublicId: owner, expectedRevision: revision, resumeGhost: z.boolean().default(false),
}).strict();

export const earthPositionWriteSchema: z.ZodType<EarthPositionWrite> = z.object({
  expectedOwnerPublicId: owner, publicationEpoch: uuid, sequence: z.number().int().positive().safe(),
  latitude: z.number().finite().min(-90).max(90), longitude: z.number().finite().min(-180).max(180),
  accuracyMeters: z.number().finite().min(0).max(100_000), capturedAt: timestamp,
}).strict();

export const earthPositionStopSchema: z.ZodType<EarthPositionStop> = z.object({
  expectedOwnerPublicId: owner, publicationEpoch: uuid,
}).strict();

export const earthPositionReceiptSchema: z.ZodType<EarthPositionReceipt> = z.object({
  ownerPublicId: owner, acceptedAt: timestamp, expiresAt: timestamp, serverTime: timestamp,
}).strict();

export const earthPositionStoppedSchema: z.ZodType<EarthPositionStopped> = z.object({ ownerPublicId: owner, serverTime: timestamp }).strict();

export const earthSharedPersonSchema: z.ZodType<EarthSharedPerson> = z.object({
  circleId: uuid,
  user: z.object({ publicId: owner, displayName: z.string().min(1).max(100), tag: playerTagSchema.nullable().optional() }),
  latitude: z.number().finite().min(-90).max(90), longitude: z.number().finite().min(-180).max(180),
  accuracyMeters: z.number().finite().min(0).max(100_000), precision, updatedAt: timestamp, expiresAt: timestamp,
}).strict().refine(value => Date.parse(value.expiresAt) > Date.parse(value.updatedAt)
  && Date.parse(value.expiresAt) - Date.parse(value.updatedAt) <= EARTH_POSITION_TTL_MS
  && (value.precision !== "APPROXIMATE" || value.accuracyMeters >= EARTH_APPROXIMATE_ACCURACY_METERS
    && Math.abs(value.latitude * 100 - Math.round(value.latitude * 100)) < 1e-7
    && Math.abs(value.longitude * 100 - Math.round(value.longitude * 100)) < 1e-7));

export const earthPeopleResponseSchema: z.ZodType<EarthPeopleResponse> = z.object({
  ownerPublicId: owner, people: z.array(earthSharedPersonSchema).max(EARTH_SHARING_MAX_PEOPLE), serverTime: timestamp,
}).strict().refine(value => new Set(value.people.map(person => person.circleId)).size === value.people.length);

/** Also applied server-side; approximate consent never requires sending a precise fix. */
export function earthSharedCoordinates(position: { latitude: number; longitude: number; accuracyMeters: number }, value: EarthSharingPrecision) {
  return value === "APPROXIMATE"
    ? { latitude: Math.round(position.latitude * 100) / 100, longitude: Math.round(position.longitude * 100) / 100,
      accuracyMeters: Math.max(EARTH_APPROXIMATE_ACCURACY_METERS, position.accuracyMeters) }
    : { ...position };
}
