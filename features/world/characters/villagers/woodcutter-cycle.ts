import { canTraverseResidents, type ResidentOccupant } from "@/features/world/navigation/resident-traffic";
import type { ForestVillagerMind } from "./villager-state";
import type { VillagerPlaces, VillagerStop } from "./villager-navigation";
import { selectVillagerRoute, setVillagerAction, stopVillager } from "./villager-movement";
import { woodcutterSafeDrop } from "./woodcutter-navigation";
import type { FixedWorldScene } from "@/features/world/tiled/types";

export const WOODCUTTER_CYCLE_LIMITS = { chop: 8, unload: 1.1, rest: 8, retry: 3, attempts: 3, haul: 45 } as const;
export const woodcutterLoaded = (mind: ForestVillagerMind): boolean => mind.woodwork?.phase === "haul" || mind.woodwork?.phase === "unload";
const rotate = (stops: readonly VillagerStop[], index: number) => [...stops.slice(index % stops.length), ...stops.slice(0, index % stops.length)];

/** A visual work cycle owns no stock, reward, server job or independent clock. */
export function beginWoodcutterCycle(mind: ForestVillagerMind, places: VillagerPlaces, occupants?: readonly ResidentOccupant[],
  options: { chopSeconds?: number; workIndex?: number } = {}): boolean {
  const cycle = mind.woodwork, plan = places.woodcutting;
  if (mind.id !== "lopukh" || !mind.available || mind.doorPhase !== "outside" || mind.socialVisit
    || !cycle || !plan || woodcutterLoaded(mind)) return false;
  cycle.phase = "chop"; cycle.elapsed = 0; cycle.failures = 0; cycle.retryAt = mind.elapsed;
  cycle.chopSeconds = options.chopSeconds === 0 ? 0 : WOODCUTTER_CYCLE_LIMITS.chop;
  mind.socialVisit = null;
  const workIndex = Number.isSafeInteger(options.workIndex) && options.workIndex! >= 0 ? options.workIndex! : cycle.completedCycles;
  const started = selectVillagerRoute(mind, places, rotate(plan.work, workIndex), "work", "work", occupants);
  if (!started) { cycle.failures++; cycle.retryAt = mind.elapsed + WOODCUTTER_CYCLE_LIMITS.retry; setVillagerAction(mind, "inspect"); }
  return true;
}
function resting(mind: ForestVillagerMind) {
  const cycle = mind.woodwork!;
  cycle.phase = "rest"; cycle.elapsed = 0; cycle.failures = 0; mind.workNeed = .1;
  stopVillager(mind, "rest"); mind.wait = WOODCUTTER_CYCLE_LIMITS.rest;
}
function deliver(mind: ForestVillagerMind, places: VillagerPlaces, occupants: readonly ResidentOccupant[]) {
  const cycle = mind.woodwork!, plan = places.woodcutting!;
  const started = selectVillagerRoute(mind, places, rotate(plan.delivery, cycle.failures + cycle.completedCycles), "home", "unload", occupants);
  if (!started) { cycle.failures++; cycle.retryAt = mind.elapsed + WOODCUTTER_CYCLE_LIMITS.retry; stopVillager(mind, "carry"); }
}

/** Return false only when the ordinary movement/attention director should
 * continue. Reaching a delivery ends carry immediately, not after an idle wait. */
export function advanceWoodcutterCycle(mind: ForestVillagerMind, scene: FixedWorldScene, places: VillagerPlaces, dt: number,
  occupants: readonly ResidentOccupant[]): boolean {
  const cycle = mind.woodwork, plan = places.woodcutting;
  if (!cycle || !plan || cycle.phase === "idle" || mind.socialVisit) return false;
  if (mind.route && mind.intent === "yield") return false;
  if (mind.noticePending && !mind.job && !woodcutterLoaded(mind)) { cycle.phase = "idle"; return false; }
  mind.socialNeed = Math.min(1, mind.socialNeed + dt * .007);
  if (cycle.phase === "chop") {
    if (mind.route) return false;
    if (mind.action !== "work") {
      if (mind.elapsed < cycle.retryAt) return true;
      if (cycle.failures >= WOODCUTTER_CYCLE_LIMITS.attempts) { resting(mind); return true; }
      if (!selectVillagerRoute(mind, places, rotate(plan.work, ++cycle.failures), "work", "work", occupants))
        cycle.retryAt = mind.elapsed + WOODCUTTER_CYCLE_LIMITS.retry;
      return true;
    }
    cycle.elapsed += dt; mind.workNeed = Math.max(0, mind.workNeed - dt * .045);
    if (cycle.elapsed < cycle.chopSeconds) return true;
    cycle.phase = "haul"; cycle.elapsed = 0; cycle.failures = 0; deliver(mind, places, occupants); return true;
  }
  if (cycle.phase === "haul") {
    cycle.elapsed += dt;
    if (mind.route && cycle.elapsed <= WOODCUTTER_CYCLE_LIMITS.haul) return false;
    if (mind.route) { stopVillager(mind, "carry"); cycle.failures++; cycle.retryAt = mind.elapsed + WOODCUTTER_CYCLE_LIMITS.retry; }
    if (mind.action === "unload") { cycle.phase = "unload"; cycle.elapsed = dt; return true; }
    if (mind.elapsed < cycle.retryAt) return true;
    if (cycle.failures >= WOODCUTTER_CYCLE_LIMITS.attempts) {
      // An occupied yard cannot create an endless wall-walk. A safe outdoor
      // staging point may receive this cosmetic log; otherwise wait and retry.
      if (woodcutterSafeDrop(scene, places.navigation, mind.position, 44)
        && canTraverseResidents(mind.position, mind.position, 44, occupants, mind.id)) {
        cycle.phase = "unload"; cycle.elapsed = 0; setVillagerAction(mind, "unload"); return true;
      }
      cycle.failures = 0; cycle.retryAt = mind.elapsed + 15; return true;
    }
    deliver(mind, places, occupants); return true;
  }
  cycle.elapsed += dt;
  if (cycle.phase === "unload") {
    setVillagerAction(mind, "unload");
    if (cycle.elapsed + 1e-7 >= WOODCUTTER_CYCLE_LIMITS.unload) {
      const delivery = { position: { ...mind.position }, sequence: (cycle.lastDelivery?.sequence ?? 0) + 1 };
      cycle.deliveries = [...(cycle.deliveries ?? (cycle.lastDelivery ? [cycle.lastDelivery] : [])), delivery].slice(-3);
      cycle.lastDelivery = delivery;
      resting(mind);
    }
    return true;
  }
  setVillagerAction(mind, "rest"); mind.fatigue = Math.max(0, mind.fatigue - dt * .045);
  if (cycle.elapsed < WOODCUTTER_CYCLE_LIMITS.rest + cycle.completedCycles % 3 * 2) return true;
  cycle.completedCycles++; cycle.phase = "idle"; setVillagerAction(mind, "inspect"); mind.wait = 3;
  if (mind.job) beginWoodcutterCycle(mind, places, occupants);
  return true;
}
