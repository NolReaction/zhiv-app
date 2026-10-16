import type { PixelDirection } from "@/features/mochlik/pixel-sprite";
import type { ForestVillagerAction } from "@/features/world/characters/forest-villager-types";
import { desiredSteeringSpeed, prepareSteeringPath, type SteeringPath } from "@/features/world/navigation/steering";
import { canTraverseResidents, residentRequestingPassage, residentWalkingStep, residentYieldPoint,
  type ResidentOccupant } from "@/features/world/navigation/resident-traffic";
import type { WorldPoint } from "@/features/world/tiled/types";
import { FOREST_VILLAGER_PROFILES, forestVillagerRoute, villagerDistance, type VillagerPlaces, type VillagerStop } from "./villager-navigation";
import { FOREST_VILLAGER_LIMITS, type ForestVillagerMind } from "./villager-state";

export const villagerDirection = (a: WorldPoint, b: WorldPoint): PixelDirection => Math.abs(b.x - a.x) > Math.abs(b.y - a.y)
  ? b.x > a.x ? "right" : "left" : b.y > a.y ? "front" : "back";
export function setVillagerAction(mind: ForestVillagerMind, action: ForestVillagerAction) {
  if (mind.action !== action) { mind.action = action; mind.age = 0; }
}
export function stopVillager(mind: ForestVillagerMind, action: ForestVillagerAction) {
  mind.route = null; mind.distance = 0; mind.speed = 0; mind.trafficWaiting = false; mind.stalledAt = null;
  if (mind.target) mind.direction = villagerDirection(mind.position, mind.target.lookAt);
  setVillagerAction(mind, action); mind.wait = FOREST_VILLAGER_LIMITS.decisionSeconds;
}
export function selectVillagerRoute(mind: ForestVillagerMind, places: VillagerPlaces, candidates: readonly VillagerStop[],
  intent: ForestVillagerMind["intent"], afterWalk: ForestVillagerAction, occupants?: readonly ResidentOccupant[]): boolean {
  const profile = FOREST_VILLAGER_PROFILES[mind.id];
  const free = candidates.filter(stop => canTraverseResidents(stop.position, stop.position, profile.size, occupants, mind.id));
  const selected = forestVillagerRoute(places, mind.position, free, profile.size, intent === "wander" ? profile.speed * 18 : Infinity);
  mind.decisions++; mind.wait = FOREST_VILLAGER_LIMITS.decisionSeconds;
  if (!selected) return false;
  mind.target = selected.target; mind.route = selected.route; mind.distance = 0; mind.speed = 0; mind.trafficWaiting = false;
  mind.intent = intent; mind.afterWalk = afterWalk;
  mind.recentStops = [...mind.recentStops.filter(id => id !== selected.target.id), selected.target.id].slice(-3);
  if (mind.route.length < .001) stopVillager(mind, afterWalk);
  else setVillagerAction(mind, afterWalk === "carry" ? "carry" : "walk");
  return true;
}
/** Optional conversations and fauna poses never reserve a work corridor. A
 * successful route publishes walking immediately, so their directors release
 * the old hold on reconciliation; stale hold snapshots cannot cancel yielding. */
export function yieldForestVillagerPassage(mind: ForestVillagerMind, places: VillagerPlaces,
  occupants: readonly ResidentOccupant[], options: { optionalHold?: boolean; partnerId?: string } = {}): boolean {
  if (mind.route || mind.doorPhase !== "outside" || mind.elapsed < mind.retryAt) return false;
  const profile = FOREST_VILLAGER_PROFILES[mind.id];
  // An ordinary stroll finds its own way around a conversation or perched
  // animal. A real work/arrival route may interrupt; the agreed partner may not.
  const requesters = options.optionalHold || options.partnerId ? occupants.filter(other => other.id !== options.partnerId
    && (!options.optionalHold || (other.intent?.priority ?? 0) >= 2)) : occupants;
  const requester = residentRequestingPassage(mind.position, profile.size, requesters, mind.id, mind.job ? 2 : 0);
  if (!requester) return false;
  mind.retryAt = mind.elapsed + FOREST_VILLAGER_LIMITS.trafficRetry;
  const position = residentYieldPoint(places.navigation, mind.position, profile.size, occupants, mind.id, requester);
  if (!position || !selectVillagerRoute(mind, places, [{ id: `${mind.id}:yield`, position, lookAt: requester.position }],
    "yield", "idle", occupants)) return false;
  mind.socialVisit = null;
  return true;
}
function segment(path: SteeringPath, at: number): number {
  let low = 1, high = path.points.length - 1;
  while (low < high) { const mid = (low + high) >> 1; if (path.distances[mid] <= at + 1e-7) low = mid + 1; else high = mid; }
  return low;
}
function pointAt(path: SteeringPath, at: number): WorldPoint {
  const index = segment(path, at), a = path.points[index - 1], b = path.points[index];
  const ratio = Math.max(0, Math.min(1, (at - path.distances[index - 1]) / (path.distances[index] - path.distances[index - 1] || 1)));
  return { x: a.x + (b.x - a.x) * ratio, y: a.y + (b.y - a.y) * ratio };
}
/** A small look-ahead and axis hysteresis stop tiny rounded vertices from
 * alternately selecting front/right every frame on a diagonal. */
function facePath(mind: ForestVillagerMind, path: SteeringPath) {
  const target = pointAt(path, Math.min(path.length, mind.distance + 7));
  const dx = target.x - mind.position.x, dy = target.y - mind.position.y;
  if (Math.hypot(dx, dy) < .01) return;
  const horizontal = mind.direction === "left" || mind.direction === "right";
  if (horizontal ? Math.abs(dy) > Math.abs(dx) * 1.2 : Math.abs(dx) > Math.abs(dy) * 1.2)
    mind.direction = horizontal ? dy > 0 ? "front" : "back" : dx > 0 ? "right" : "left";
  else mind.direction = horizontal ? dx >= 0 ? "right" : "left" : dy >= 0 ? "front" : "back";
}

/** Integrate time once, then consume that distance across every checked sample.
 * Samples are geometry, not new animation ticks or acceleration opportunities. */
export function walkForestVillager(mind: ForestVillagerMind, places: VillagerPlaces, dt: number,
  occupants: readonly ResidentOccupant[], running: boolean) {
  const profile = FOREST_VILLAGER_PROFILES[mind.id], maximum = profile.speed * (running ? FOREST_VILLAGER_LIMITS.arrivalSpeed : 1);
  let remaining = dt, checks = 0;
  while (mind.route && remaining > 1e-7 && checks < FOREST_VILLAGER_LIMITS.movementSteps) {
    const path = mind.route;
    if (path.length - mind.distance < .001) { stopVillager(mind, mind.afterWalk); return; }
    const slice = Math.min(1 / 60, remaining), acceleration = profile.size * 1.6;
    const desired = desiredSteeringSpeed(path, mind.distance, maximum, acceleration);
    const speed = Math.max(mind.speed - acceleration * slice, Math.min(desired, mind.speed + acceleration * slice));
    const end = Math.min(path.length, mind.distance + Math.max(.1, (mind.speed + speed) / 2) * slice);
    mind.speed = speed; remaining -= slice;
    while (mind.distance < end - 1e-7 && checks++ < FOREST_VILLAGER_LIMITS.movementSteps) {
      const at = Math.min(path.distances[segment(path, mind.distance)], end), position = pointAt(path, at);
      const traffic = residentWalkingStep({ owner: mind, navigation: places.navigation, from: mind.position,
        target: path.points.at(-1)!, size: profile.size, occupants, selfId: mind.id, time: mind.elapsed }, position);
      if (!traffic.clear) {
        mind.trafficWaiting = true; mind.speed = 0; mind.stalledAt ??= mind.elapsed;
        if (!running && !mind.job && !mind.socialVisit && mind.elapsed - mind.stalledAt > 2.4) {
          stopVillager(mind, "idle"); mind.wait = 3; return;
        }
        const detour = traffic.path && prepareSteeringPath(places.navigation, traffic.path, profile.size);
        if (detour) { mind.route = detour; mind.distance = 0; }
        return;
      }
      mind.trafficWaiting = false; mind.stalledAt = null;
      mind.walked += villagerDistance(mind.position, position); mind.position = position; mind.distance = at;
    }
    facePath(mind, path);
  }
  if (mind.route && mind.route.length - mind.distance < .001) stopVillager(mind, mind.afterWalk);
}
