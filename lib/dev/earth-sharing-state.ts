import type { EarthSharingPrecision, EarthSharingMode } from "@/lib/earth-sharing-contract";

export type StoredPosition = {
  latitude: number; longitude: number; accuracyMeters: number;
  updatedAt: number; expiresAt: number;
};
export type StoredFrozenPosition = StoredPosition & { precision: EarthSharingPrecision; publisherSession: string };
export type DevEarthOwner = {
  mode: EarthSharingMode; revision: number; precision: EarthSharingPrecision;
  recipientCircleIds: string[]; sharingUntil: number | null;
  frozenCircleIds: string[]; frozenPositions: Map<string, StoredFrozenPosition>; awaitingFreshSince: Map<string, number>;
  publicationEpoch: string | null; publisherSession: string | null; lastPublisherSession: string | null;
  sequence: number; capturedAt: number | null; position: StoredPosition | null;
  nextPublishAt: number;
};
export type DevEarthBudget = { startedAt: number; count: number };
type State = {
  version: 3;
  owners: Map<string, DevEarthOwner>;
  reads: Map<string, DevEarthBudget>;
  enables: Map<string, DevEarthBudget>;
  cleanup: ReturnType<typeof setTimeout> | null;
};
const globals = globalThis as typeof globalThis & { __zhivDevEarthSharing?: State };
export function devEarthSharingState(): State {
  const state = globals.__zhivDevEarthSharing ??= { version: 3, owners: new Map(), reads: new Map(), enables: new Map(), cleanup: null };
  // The development process can survive a pull through HMR. Upgrade older
  // preference containers and capture-time fences without inventing snapshots.
  if (state.version !== 3) {
    for (const record of state.owners.values()) {
      record.frozenCircleIds ??= []; record.frozenPositions ??= new Map();
      const legacy = record as DevEarthOwner & { awaitingFreshCircleIds?: Set<string> };
      record.awaitingFreshSince ??= new Map([...(legacy.awaitingFreshCircleIds ?? [])].map(circle => [circle, Date.now()]));
      delete legacy.awaitingFreshCircleIds;
    }
    state.version = 3;
  }
  return state;
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
    record.frozenCircleIds = record.frozenCircleIds.filter(id => id !== circleId);
    record.frozenPositions.clear(); record.awaitingFreshSince.clear();
    record.revision++;
    // Every audience change requires a new explicit publication and fresh fix.
    record.publicationEpoch = null; record.publisherSession = null; record.lastPublisherSession = null; record.position = null;
    record.sequence = 0; record.capturedAt = null; record.nextPublishAt = 0;
  }
}
