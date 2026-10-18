import type { SceneOptions } from "@/features/mochlik/scene";
import type { ForestSessionState } from "@/features/world/state/forest-session";
import type { FixedWorldScene } from "@/features/world/tiled/types";
import type { ResidentOccupant } from "@/features/world/navigation/resident-traffic";
import { createLeaftailBoatArrival, configureLeaftailBoatArrival, advanceLeaftailBoatArrival,
  settleLeaftailBoatArrival } from "@/features/world/characters/leaftail/leaftail-boat-arrival";

function handOverMerchant(state: ForestSessionState) {
  const boat = state.leaftailBoat, mind = state.villagers?.residents.leaftail;
  if (!boat?.completed || !boat.route || !mind) return;
  // The ordinary mind takes over the same real feet after the complete landing
  // and greeting. A short outside pause lets one free neighbour approach.
  // A restored 'seen' preference uses normal home initialization.
  mind.position = { ...boat.position }; mind.initialized = true; mind.direction = boat.direction;
  mind.action = "inspect"; mind.age = 0; mind.wait = 8; mind.doorPhase = "outside";
  mind.door = null; mind.route = null; mind.target = null; mind.socialVisit = null;
  mind.noticePending = false; mind.distance = 0; mind.speed = 0;
  mind.outdoorUntil = mind.elapsed + 40;
}

export function syncSceneMerchantArrival(state: ForestSessionState, scene: FixedWorldScene, options: SceneOptions,
  active: boolean, still: boolean, occupants: readonly ResidentOccupant[] = []): boolean {
  const boat = state.leaftailBoat ??= createLeaftailBoatArrival(scene), access = state.economyResidents;
  configureLeaftailBoatArrival(boat, scene, {
    confirmed: Boolean(access), unlocked: (access?.buildings.home ?? 0) >= 3,
    seen: Boolean(options.devRehearsal && options.devRehearsal.scenario !== "leaftail-arrival" || options.merchantArrival?.seen),
    allowArrival: options.view === "world" && active && options.merchantArrival?.enabled === true,
  });
  if (still && boat.allowed && settleLeaftailBoatArrival(boat, occupants)) handOverMerchant(state);
  return boat.completed;
}

/** A shared claim survives a canvas remount or geometry handoff before React's
 * seen preference arrives. A stale callback relinquishes only its own claim. */
export function announceSceneMerchantArrival(state: ForestSessionState, onComplete: () => void, current: () => boolean) {
  const boat = state.leaftailBoat;
  if (!boat?.completed) return;
  const notice = boat.completionNotice ??= { delivered: false };
  if (notice.delivered) return;
  if (notice.pending) {
    // A replaced static canvas has no next animation tick to reclaim a stale
    // owner's pending notification after that owner's microtask releases it.
    queueMicrotask(() => {
      if (!notice.delivered && !notice.pending && current()) announceSceneMerchantArrival(state, onComplete, current);
    });
    return;
  }
  const token = {}; notice.pending = token;
  queueMicrotask(() => {
    if (notice.pending !== token) return;
    delete notice.pending;
    if (!current()) return;
    notice.delivered = true; onComplete();
  });
}

export function advanceSceneMerchantArrival(state: ForestSessionState, dt: number,
  occupants: readonly ResidentOccupant[]) {
  const boat = state.leaftailBoat;
  if (!boat || boat.completed) return;
  advanceLeaftailBoatArrival(boat, dt, { occupants });
  if (boat.completed) handOverMerchant(state);
}
