import {
  EARTH_POSITION_FUTURE_MS, EARTH_POSITION_MAX_AGE_MS, EARTH_POSITION_PUBLISH_MS,
  EARTH_POSITION_TTL_MS, EARTH_SHARING_MAX_PEOPLE, earthSharedCoordinates,
  earthPositionStopSchema, earthPositionWriteSchema, earthSharingResumeSchema, earthSharingWriteSchema,
  type EarthPeopleResponse, type EarthPositionReceipt, type EarthPositionStop, type EarthPositionStopped,
  type EarthPositionWrite, type EarthSharingResume, type EarthSharingSettings, type EarthSharingWrite,
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
    record = { mode: "OFF", revision: 0, precision: "PRECISE", recipientCircleIds: [], frozenCircleIds: [],
      frozenPositions: new Map(), awaitingFreshSince: new Map(), sharingUntil: null,
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
function revoke(record: DevEarthOwner) {
  invalidate(record); record.frozenCircleIds = []; record.frozenPositions.clear(); record.awaitingFreshSince.clear();
  record.mode = "OFF"; record.recipientCircleIds = []; record.sharingUntil = null;
}
function expireConsent(record: DevEarthOwner, time: number) {
  if (record.mode !== "OFF" && record.sharingUntil !== null && record.sharingUntil <= time) {
    revoke(record); record.revision++;
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
/** Freeze only a point this exact recipient could already read, never a future fix. */
function updateRecipients(owner: string, record: DevEarthOwner, recipients: string[], frozen: string[], time: number) {
  const previousFrozen = new Set(record.frozenCircleIds), nextFrozen = new Set(frozen), nextRecipients = new Set(recipients);
  for (const circle of previousFrozen) {
    if (!nextFrozen.has(circle)) {
      record.frozenPositions.delete(circle);
      if (nextRecipients.has(circle)) record.awaitingFreshSince.set(circle, time);
    }
  }
  for (const circle of nextFrozen) {
    if (previousFrozen.has(circle)) continue;
    const point = record.position;
    if (record.recipientCircleIds.includes(circle) && point && point.updatedAt > (record.awaitingFreshSince.get(circle) ?? -Infinity)
      && point.expiresAt > time && pointActive(owner, record, time)) {
      record.frozenPositions.set(circle, { ...point, precision: record.precision, publisherSession: record.lastPublisherSession! });
    }
  }
  for (const circle of record.frozenPositions.keys()) if (!nextRecipients.has(circle)) record.frozenPositions.delete(circle);
  for (const circle of record.awaitingFreshSince.keys()) if (!nextRecipients.has(circle)) record.awaitingFreshSince.delete(circle);
  record.recipientCircleIds = [...recipients].sort(); record.frozenCircleIds = [...frozen].sort();
}
function armCleanup() {
  const state = devEarthSharingState();
  if (state.cleanup) return;
  let nextExpiry = Infinity;
  for (const record of state.owners.values()) {
    if (record.position) nextExpiry = Math.min(nextExpiry, record.position.expiresAt);
    for (const point of record.frozenPositions.values()) nextExpiry = Math.min(nextExpiry, point.expiresAt);
  }
  if (!Number.isFinite(nextExpiry)) return;
  state.cleanup = setTimeout(() => {
    state.cleanup = null;
    for (const [owner, record] of state.owners) {
      expireConsent(record, Date.now());
      if (record.position && !pointActive(owner, record, Date.now())) invalidate(record);
      else if (record.position && record.position.expiresAt <= Date.now()) record.position = null;
      for (const [circle, point] of record.frozenPositions) {
        if (point.expiresAt <= Date.now() || getDevIdentity(point.publisherSession)?.user.publicId !== owner) record.frozenPositions.delete(circle);
      }
    }
    armCleanup();
  }, Math.max(1, Math.min(60_000, nextExpiry - Date.now())));
  state.cleanup.unref?.();
}
function settings(owner: string, record: DevEarthOwner, epoch: string | null = null): EarthSharingSettings {
  return { ownerPublicId: owner, mode: record.mode, revision: record.revision, precision: record.precision,
    recipientCircleIds: [...record.recipientCircleIds], frozenCircleIds: [...record.frozenCircleIds], sharingUntil: record.sharingUntil === null ? null : iso(record.sharingUntil),
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
  const retry = budget(devEarthSharingState().reads, actor.owner, 1_800, 3_600_000);
  if (retry) return error(429, "EARTH_RATE_LIMITED", retry);
  return sharingProjection(actor.owner);
}
function sharingProjection(owner: string): DevEarthResult<EarthSharingSettings> {
  const record = ownerRecord(owner); expireConsent(record, Date.now());
  return { kind: "ok", value: settings(owner, record) };
}
/** Server-internal snapshot composition; never used by public read routes or to grant publication. */
export function projectDevEarthSharing(token: string | undefined): DevEarthResult<EarthSharingSettings> {
  const actor = context(token); if (actor.error) return actor.error;
  return sharingProjection(actor.owner);
}

export function putDevEarthSharing(token: string | undefined, body: EarthSharingWrite): DevEarthResult<EarthSharingSettings> {
  const parsed = earthSharingWriteSchema.safeParse(body);
  if (!parsed.success) return error(400, "INVALID_EARTH_SHARING");
  body = parsed.data;
  const actor = context(token, body.expectedOwnerPublicId); if (actor.error) return actor.error;
  const record = ownerRecord(actor.owner); expireConsent(record, Date.now());
  if (body.frozenOnly && body.mode === "SHARING") {
    if (record.revision !== body.expectedRevision) return error(409, "EARTH_REVISION_CONFLICT");
    if (record.mode === "OFF" || body.recipientCircleIds.some(id => !record.recipientCircleIds.includes(id)))
      return error(400, "INVALID_EARTH_SHARING");
    updateRecipients(actor.owner, record, body.recipientCircleIds, body.frozenCircleIds ?? [], Date.now());
    if (!record.recipientCircleIds.length) revoke(record);
    record.revision++; armCleanup();
    return { kind: "ok", value: settings(actor.owner, record) };
  }
  if (body.mode === "SHARING") {
    if (record.revision !== body.expectedRevision) return error(409, "EARTH_REVISION_CONFLICT");
    if (body.preserveSharingUntil && (record.mode === "OFF" || !record.recipientCircleIds.length || record.precision !== body.precision
      || (record.sharingUntil === null) !== (body.durationMinutes === null)
      || record.recipientCircleIds.some(circle => !body.recipientCircleIds.includes(circle)
        || record.frozenCircleIds.includes(circle) !== (body.frozenCircleIds ?? []).includes(circle))))
      return error(400, "INVALID_EARTH_SHARING");
    const people = listDevPeople(actor.token);
    if (people.kind !== "ok") return error(401, "UNAUTHORIZED");
    const direct = new Set(people.value.people.map(person => person.circleId));
    if (body.recipientCircleIds.some(circle => !direct.has(circle))) return error(400, "INVALID_EARTH_SHARING");
    const retry = budget(devEarthSharingState().enables, actor.owner, 10, 60_000);
    if (retry) return error(429, "EARTH_RATE_LIMITED", retry);
    const previousRecipients = new Set(record.recipientCircleIds), ghost = body.preserveSharingUntil && record.mode === "GHOST";
    updateRecipients(actor.owner, record, body.recipientCircleIds, body.frozenCircleIds ?? [], Date.now());
    if (ghost) pause(record); else invalidate(record);
    if (body.preserveSharingUntil) for (const circle of record.recipientCircleIds) {
      if (!previousRecipients.has(circle)) record.awaitingFreshSince.set(circle, Date.now());
    }
    record.mode = ghost ? "GHOST" : "SHARING"; record.revision++; record.precision = body.precision;
    if (!body.preserveSharingUntil) record.sharingUntil = body.durationMinutes === null ? null : Date.now() + body.durationMinutes * 60_000;
    for (const [circle, point] of record.frozenPositions) record.frozenPositions.set(circle, {
      ...point, expiresAt: Math.min(point.expiresAt, record.sharingUntil ?? Infinity),
    });
    if (!ghost) { record.publicationEpoch = crypto.randomUUID(); record.publisherSession = actor.token; }
    return { kind: "ok", value: settings(actor.owner, record, record.publicationEpoch) };
  }
  // Privacy changes have priority over CAS conflicts, enable and GPS quotas.
  if (body.mode === "OFF") revoke(record);
  else pause(record);
  record.mode = body.mode; record.revision++;
  return { kind: "ok", value: settings(actor.owner, record) };
}

export function resumeDevEarthSharing(token: string | undefined, body: EarthSharingResume): DevEarthResult<EarthSharingSettings> {
  const parsed = earthSharingResumeSchema.safeParse(body);
  if (!parsed.success) return error(400, "INVALID_EARTH_SHARING");
  body = parsed.data;
  const actor = context(token, body.expectedOwnerPublicId); if (actor.error) return actor.error;
  const record = ownerRecord(actor.owner), time = Date.now(); expireConsent(record, time);
  if (record.mode !== "SHARING" && !(record.mode === "GHOST" && body.resumeGhost))
    return error(409, "EARTH_PUBLICATION_CONFLICT");
  if (record.revision !== body.expectedRevision || record.revision >= Number.MAX_SAFE_INTEGER - 1)
    return error(409, "EARTH_REVISION_CONFLICT");
  const people = listDevPeople(actor.token);
  if (people.kind !== "ok") return error(401, "UNAUTHORIZED");
  const direct = new Set(people.value.people.map(person => person.circleId));
  const selected = record.recipientCircleIds.filter(circle => direct.has(circle));
  const live = selected.some(circle => !record.frozenCircleIds.includes(circle));
  if (!selected.length || !live && !(record.mode === "GHOST" && body.resumeGhost))
    return error(409, "EARTH_PUBLICATION_CONFLICT");
  const retry = budget(devEarthSharingState().enables, actor.owner, 10, 60_000);
  if (retry) return error(429, "EARTH_RATE_LIMITED", retry);
  // Keep the last published/frozen points and every confirmed consent choice.
  pause(record); record.mode = "SHARING"; record.revision++;
  if (live) { record.publicationEpoch = crypto.randomUUID(); record.publisherSession = actor.token; }
  return { kind: "ok", value: settings(actor.owner, record, record.publicationEpoch) };
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
  for (const [circle, since] of record.awaitingFreshSince) if (updatedAt > since) record.awaitingFreshSince.delete(circle);
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
  const retry = budget(devEarthSharingState().reads, actor.owner, 1_800, 3_600_000);
  if (retry) return error(429, "EARTH_RATE_LIMITED", retry);
  return peopleProjection(actor.owner, actor.token);
}
/** Reuses the exact authenticated feed projection without spending a second public-read quota on a DEV command result. */
export function projectDevEarthPeople(token: string | undefined): DevEarthResult<EarthPeopleResponse> {
  const actor = context(token); if (actor.error) return actor.error;
  return peopleProjection(actor.owner, actor.token);
}
function peopleProjection(viewer: string, token: string): DevEarthResult<EarthPeopleResponse> {
  const current = listDevPeople(token); if (current.kind !== "ok") return error(401, "UNAUTHORIZED");
  const time = Date.now();
  const people = current.value.people.flatMap(person => {
    const owner = person.user.publicId, record = devEarthSharingState().owners.get(owner);
    if (!record || !record.recipientCircleIds.includes(person.circleId)) return [];
    expireConsent(record, time);
    if (record.mode === "OFF") return [];
    if (record.position && !pointActive(owner, record, time)) invalidate(record);
    else if (record.position && record.position.expiresAt <= time) record.position = null;
    const frozen = record.frozenCircleIds.includes(person.circleId);
    const point = frozen ? record.frozenPositions.get(person.circleId) : record.position;
    const session = frozen ? record.frozenPositions.get(person.circleId)?.publisherSession : record.lastPublisherSession;
    if (!point || !session || getDevIdentity(session)?.user.publicId !== owner || point.expiresAt <= time) {
      if (frozen) record.frozenPositions.delete(person.circleId);
      return [];
    }
    const liveAfter = record.awaitingFreshSince.get(person.circleId);
    if (!frozen && liveAfter !== undefined && point.updatedAt <= liveAfter) return [];
    return [{ circleId: person.circleId, user: { ...person.user }, latitude: point.latitude, longitude: point.longitude,
      accuracyMeters: point.accuracyMeters, precision: frozen ? record.frozenPositions.get(person.circleId)!.precision : record.precision,
      updatedAt: iso(point.updatedAt), expiresAt: iso(Math.min(point.expiresAt, record.sharingUntil ?? Infinity)) }];
  }).sort((first, second) => first.circleId.localeCompare(second.circleId)).slice(0, EARTH_SHARING_MAX_PEOPLE);
  return { kind: "ok", value: { ownerPublicId: viewer, people, serverTime: iso(time) } };
}
