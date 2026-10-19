import type { EarthSharingPrecision, EarthSharingMode } from "@/lib/earth-sharing-contract";

type StoredPosition = {
  latitude: number; longitude: number; accuracyMeters: number;
  updatedAt: number; expiresAt: number;
};
export type DevEarthOwner = {
  mode: EarthSharingMode; revision: number; precision: EarthSharingPrecision;
  recipientCircleIds: string[]; sharingUntil: number | null;
  publicationEpoch: string | null; publisherSession: string | null;
  sequence: number; capturedAt: number | null; position: StoredPosition | null;
  nextPublishAt: number;
};
export type DevEarthBudget = { startedAt: number; count: number };
type State = {
  owners: Map<string, DevEarthOwner>;
  reads: Map<string, DevEarthBudget>;
  enables: Map<string, DevEarthBudget>;
  cleanup: ReturnType<typeof setTimeout> | null;
};
const globals = globalThis as typeof globalThis & { __zhivDevEarthSharing?: State };
export function devEarthSharingState(): State {
  return globals.__zhivDevEarthSharing ??= { owners: new Map(), reads: new Map(), enables: new Map(), cleanup: null };
}
export function resetDevEarthSharingState() {
  if (globals.__zhivDevEarthSharing?.cleanup) clearTimeout(globals.__zhivDevEarthSharing.cleanup);
  delete globals.__zhivDevEarthSharing;
}
/** A re-created DIRECT circle has a new ID and never inherits this permission. */
export function revokeDevEarthCircle(circleId: string) {
  for (const record of devEarthSharingState().owners.values()) {
    if (!record.recipientCircleIds.includes(circleId)) continue;
    record.recipientCircleIds = record.recipientCircleIds.filter(id => id !== circleId);
    record.revision++;
    // Every audience change requires a new explicit publication and fresh fix.
    record.publicationEpoch = null; record.publisherSession = null; record.position = null;
    record.sequence = 0; record.capturedAt = null; record.nextPublishAt = 0;
  }
}
