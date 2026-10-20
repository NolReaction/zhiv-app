import {
  EARTH_POSITION_FUTURE_MS, EARTH_POSITION_MAX_AGE_MS, EARTH_POSITION_PUBLISH_MS,
  EARTH_POSITION_TTL_MS, EARTH_SHARING_MAX_PEOPLE, earthSharedCoordinates,
  earthPositionStopSchema, earthPositionWriteSchema, earthSharingWriteSchema,
  type EarthPeopleResponse, type EarthPositionReceipt, type EarthPositionStop, type EarthPositionStopped,
  type EarthPositionWrite, type EarthSharingSettings, type EarthSharingWrite,
} from "@/lib/earth-sharing-contract";
import { getDevIdentity, listDevPeople } from "./api-store";
import { devEarthSharingState, type DevEarthBudget, type DevEarthOwner } from "./earth-sharing-state";

export type DevEarthResult<T> = { kind: "ok"; value: T }
  | { kind: "error"; status: number; code: string; retryAfterSeconds?: number };
const error = (status: number, code: string, retryAfterSeconds?: number): DevEarthResult<never> => ({ kind: "error", status, code,
  ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }) });
const iso = (time: number) => new Date(time).toISOString();

function ownerRecord(owner: string): DevEarthOwner {
  const state = devEarthSharingState();
  let record = state.owners.get(owner);
  if (!record) {
    record = { mode: "OFF", revision: 0, precision: "APPROXIMATE", recipientCircleIds: [], sharingUntil: null,
      publicationEpoch: null, publisherSession: null, lastPublisherSession: null, sequence: 0, capturedAt: null, position: null, nextPublishAt: 0 };
    state.owners.set(owner, record);
  }
  return record;
}
function pause(record: DevEarthOwner) {
  record.publicationEpoch = null; record.publisherSession = null;
  record.sequence = 0; record.capturedAt = null; record.nextPublishAt = 0;
}
function invalidate(record: DevEarthOwner) {
  pause(record); record.lastPublisherSession = null; record.position = null;
}
function expireConsent(record: DevEarthOwner, time: number) {
  if (record.mode !== "OFF" && record.sharingUntil !== null && record.sharingUntil <= time) {
    invalidate(record); record.mode = "OFF"; record.recipientCircleIds = []; record.sharingUntil = null; record.revision++;
  }
}
function publisherActive(owner: string, record: DevEarthOwner, time: number) {
  return record.mode === "SHARING" && (record.sharingUntil === null || record.sharingUntil > time)
    && !!record.publicationEpoch && !!record.publisherSession && getDevIdentity(record.publisherSession)?.user.publicId === owner;
}
function pointActive(owner: string, record: DevEarthOwner, time: number) {
  return record.mode !== "OFF" && (record.sharingUntil === null || record.sharingUntil > time)
    && !!record.lastPublisherSession && getDevIdentity(record.lastPublisherSession)?.user.publicId === owner;
}
function armCleanup() {
  const state = devEarthSharingState();
  if (state.cleanup) return;
  let nextExpiry = Infinity;
  for (const record of state.owners.values()) if (record.position) nextExpiry = Math.min(nextExpiry, record.position.expiresAt);
  if (!Number.isFinite(nextExpiry)) return;
  state.cleanup = setTimeout(() => {
    state.cleanup = null;
    for (const [owner, record] of state.owners) {
      expireConsent(record, Date.now());
      if (record.position && !pointActive(owner, record, Date.now())) invalidate(record);
      else if (record.position && record.position.expiresAt <= Date.now()) record.position = null;
    }
    armCleanup();
  }, Math.max(1, Math.min(60_000, nextExpiry - Date.now())));
  state.cleanup.unref?.();
}
function settings(owner: string, record: DevEarthOwner, epoch: string | null = null): EarthSharingSettings {
  return { ownerPublicId: owner, mode: record.mode, revision: record.revision, precision: record.precision,
    recipientCircleIds: [...record.recipientCircleIds], sharingUntil: record.sharingUntil === null ? null : iso(record.sharingUntil),
    publicationEpoch: epoch, serverTime: iso(Date.now()) };
}
function budget(records: Map<string, DevEarthBudget>, owner: string, maximum: number, windowMs: number) {
  const time = Date.now();
  let entry = records.get(owner);
  if (!entry || time >= entry.startedAt + windowMs) { entry = { startedAt: time, count: 0 }; records.set(owner, entry); }
  if (entry.count >= maximum) return Math.max(1, Math.ceil((entry.startedAt + windowMs - time) / 1000));
  entry.count++;
  return null;
}
function context(token: string | undefined, expectedOwner?: string) {
  const identity = getDevIdentity(token);
  if (!identity) return { error: error(401, "UNAUTHORIZED") };
  if (expectedOwner !== undefined && identity.user.publicId !== expectedOwner) return { error: error(409, "EARTH_OWNER_MISMATCH") };
  return { owner: identity.user.publicId, token: token! };
}

export function getDevEarthSharing(token: string | undefined): DevEarthResult<EarthSharingSettings> {
  const actor = context(token); if (actor.error) return actor.error;
  const retry = budget(devEarthSharingState().reads, actor.owner, 600, 3_600_000);
  if (retry) return error(429, "EARTH_RATE_LIMITED", retry);
  const record = ownerRecord(actor.owner); expireConsent(record, Date.now());
  return { kind: "ok", value: settings(actor.owner, record) };
}

export function putDevEarthSharing(token: string | undefined, body: EarthSharingWrite): DevEarthResult<EarthSharingSettings> {
  if (!earthSharingWriteSchema.safeParse(body).success) return error(400, "INVALID_EARTH_SHARING");
  const actor = context(token, body.expectedOwnerPublicId); if (actor.error) return actor.error;
  const record = ownerRecord(actor.owner); expireConsent(record, Date.now());
  if (body.mode === "SHARING") {
    if (record.revision !== body.expectedRevision) return error(409, "EARTH_REVISION_CONFLICT");
    const people = listDevPeople(actor.token);
    if (people.kind !== "ok") return error(401, "UNAUTHORIZED");
    const direct = new Set(people.value.people.map(person => person.circleId));
    if (body.recipientCircleIds.some(circle => !direct.has(circle))) return error(400, "INVALID_EARTH_SHARING");
    const retry = budget(devEarthSharingState().enables, actor.owner, 10, 60_000);
    if (retry) return error(429, "EARTH_RATE_LIMITED", retry);
    invalidate(record);
    record.mode = "SHARING"; record.revision++; record.precision = body.precision;
    record.recipientCircleIds = [...body.recipientCircleIds].sort();
    record.sharingUntil = body.durationMinutes === null ? null : Date.now() + body.durationMinutes * 60_000;
    record.publicationEpoch = crypto.randomUUID(); record.publisherSession = actor.token;
    return { kind: "ok", value: settings(actor.owner, record, record.publicationEpoch) };
  }
  // Privacy changes have priority over CAS conflicts, enable and GPS quotas.
  if (body.mode === "OFF") { invalidate(record); record.recipientCircleIds = []; record.sharingUntil = null; }
  else pause(record);
  record.mode = body.mode; record.revision++;
  return { kind: "ok", value: settings(actor.owner, record) };
}

export function putDevEarthPosition(token: string | undefined, body: EarthPositionWrite): DevEarthResult<EarthPositionReceipt> {
  if (!earthPositionWriteSchema.safeParse(body).success) return error(400, "INVALID_EARTH_POSITION");
  const actor = context(token, body.expectedOwnerPublicId); if (actor.error) return actor.error;
  const record = ownerRecord(actor.owner), time = Date.now(), capturedAt = Date.parse(body.capturedAt);
  expireConsent(record, time);
  if (!publisherActive(actor.owner, record, time) || record.publisherSession !== actor.token || record.publicationEpoch !== body.publicationEpoch)
    return error(409, "EARTH_PUBLICATION_CONFLICT");
  if (body.sequence <= record.sequence || record.capturedAt !== null && capturedAt <= record.capturedAt)
    return error(409, "EARTH_PUBLICATION_CONFLICT");
  if (capturedAt < time - EARTH_POSITION_MAX_AGE_MS || capturedAt > time + EARTH_POSITION_FUTURE_MS)
    return error(400, "INVALID_EARTH_POSITION");
  if (time < record.nextPublishAt) return error(429, "EARTH_RATE_LIMITED", Math.max(1, Math.ceil((record.nextPublishAt - time) / 1000)));
  const updatedAt = Math.min(time, capturedAt), expiresAt = Math.min(updatedAt + EARTH_POSITION_TTL_MS, record.sharingUntil ?? Infinity);
  // Keep only the fix fields, never a request body, publisher token or receipt.
  record.position = { ...earthSharedCoordinates({ latitude: body.latitude, longitude: body.longitude,
    accuracyMeters: body.accuracyMeters }, record.precision), updatedAt, expiresAt };
  record.lastPublisherSession = actor.token;
  record.sequence = body.sequence; record.capturedAt = capturedAt; record.nextPublishAt = time + EARTH_POSITION_PUBLISH_MS;
  armCleanup();
  return { kind: "ok", value: { ownerPublicId: actor.owner, acceptedAt: iso(time), expiresAt: iso(expiresAt), serverTime: iso(time) } };
}

export function stopDevEarthPosition(token: string | undefined, body: EarthPositionStop): DevEarthResult<EarthPositionStopped> {
  if (!earthPositionStopSchema.safeParse(body).success) return error(400, "INVALID_EARTH_POSITION");
  const actor = context(token, body.expectedOwnerPublicId); if (actor.error) return actor.error;
  const record = ownerRecord(actor.owner); expireConsent(record, Date.now());
  if (record.publicationEpoch === body.publicationEpoch && record.publisherSession === actor.token) pause(record);
  return { kind: "ok", value: { ownerPublicId: actor.owner, serverTime: iso(Date.now()) } };
}

export function getDevEarthPeople(token: string | undefined): DevEarthResult<EarthPeopleResponse> {
  const actor = context(token); if (actor.error) return actor.error;
  const retry = budget(devEarthSharingState().reads, actor.owner, 600, 3_600_000);
  if (retry) return error(429, "EARTH_RATE_LIMITED", retry);
  const current = listDevPeople(actor.token); if (current.kind !== "ok") return error(401, "UNAUTHORIZED");
  const time = Date.now();
  const people = current.value.people.flatMap(person => {
    const owner = person.user.publicId, record = devEarthSharingState().owners.get(owner);
    if (!record || !record.recipientCircleIds.includes(person.circleId)) return [];
    expireConsent(record, time);
    if (record.position && !pointActive(owner, record, time)) { invalidate(record); return []; }
    if (!record.position || record.position.expiresAt <= time) { record.position = null; return []; }
    const point = record.position;
    return [{ circleId: person.circleId, user: { ...person.user }, latitude: point.latitude, longitude: point.longitude,
      accuracyMeters: point.accuracyMeters, precision: record.precision, updatedAt: iso(point.updatedAt), expiresAt: iso(point.expiresAt) }];
  }).sort((first, second) => first.circleId.localeCompare(second.circleId)).slice(0, EARTH_SHARING_MAX_PEOPLE);
  return { kind: "ok", value: { ownerPublicId: actor.owner, people, serverTime: iso(time) } };
}
