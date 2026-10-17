import { canTraverseResidents, type ResidentOccupant } from "@/features/world/navigation/resident-traffic";
import type { WorldPoint } from "@/features/world/tiled/types";
import { FOREST_VILLAGER_PROFILES, villagerDistance, type VillagerDoor, type VillagerPlaces } from "./villager-navigation";
import { selectVillagerRoute, setVillagerAction, villagerDirection } from "./villager-movement";
import type { ForestVillagerMind } from "./villager-state";

export function villagerDoorPosition(door: VillagerDoor, progress: number): WorldPoint {
  const at = Math.max(0, Math.min(1, progress)) * door.length;
  let index = 1;
  while (index < door.points.length - 1 && door.distances[index] < at) index++;
  const a = door.points[index - 1], b = door.points[index];
  const ratio = (at - door.distances[index - 1]) / (door.distances[index] - door.distances[index - 1] || 1);
  return { x: a.x + (b.x - a.x) * ratio, y: a.y + (b.y - a.y) * ratio };
}
export function validVillagerDoor(mind: ForestVillagerMind, door: VillagerDoor | null): boolean {
  return !!door && !!mind.door && door.id === mind.door.id && door.points.length === mind.door.points.length
    && door.points.every((point, index) => villagerDistance(point, mind.door!.points[index]) < .001)
    && Number.isFinite(mind.doorProgress) && mind.doorProgress >= 0 && mind.doorProgress <= 1
    && villagerDistance(mind.position, villagerDoorPosition(door, mind.doorProgress)) < .001;
}
export function approachVillagerDoor(mind: ForestVillagerMind, places: VillagerPlaces, occupants?: readonly ResidentOccupant[]): boolean {
  if (!places.door || !selectVillagerRoute(mind, places, [places.door.approach], mind.job ? "work" : "home", "idle", occupants)) return false;
  mind.door = places.door; mind.doorPhase = "approach"; mind.doorProgress = 0; mind.socialVisit = null;
  mind.doorPurpose = mind.job ? "work" : "rest";
  if (mind.woodwork) mind.woodwork.phase = "idle";
  return true;
}
export function villagerDoorOpacity(mind: ForestVillagerMind): number {
  if (mind.doorPhase === "inside") return 0;
  const fadeAt = mind.door?.fadeAt ?? 0;
  return ["enter", "exit"].includes(mind.doorPhase) ? 1 - Math.max(0, (mind.doorProgress - fadeAt) / (1 - fadeAt)) : 1;
}
/** The state is owned by the shared scene clock, including time inside. A
 * closed tab does not wake a trader or finish walking into the mine. */
export function advanceVillagerDoor(mind: ForestVillagerMind, places: VillagerPlaces, dt: number,
  occupants: readonly ResidentOccupant[], weather: boolean, socialHold = false): boolean {
  if (mind.doorPhase === "outside") return false;
  if (mind.doorPhase === "approach") {
    if (mind.route) return false;
    if (!mind.door || villagerDistance(mind.position, mind.door.approach.position) > .1) {
      mind.doorPhase = "outside"; mind.door = null; mind.wait = 3; return true;
    }
    mind.doorPhase = "enter"; setVillagerAction(mind, "walk");
  }
  const door = mind.door;
  if (!door) return true;
  if (mind.doorPhase === "inside") {
    mind.fatigue = Math.max(0, mind.fatigue - dt * .035);
    if (mind.id === "kamneshmyg" && mind.job) { mind.doorPurpose = "work"; setVillagerAction(mind, "work"); return true; }
    if (mind.id === "leaftail" && socialHold && !mind.noticePending) return true;
    mind.wait -= dt;
    if (mind.job || mind.doorPurpose === "work" || mind.noticePending || !weather && mind.wait <= 0) {
      mind.doorPhase = "exit"; setVillagerAction(mind, "walk");
    } else return true;
  }
  // A job ending or being cancelled reverses the actual in-flight crossing.
  if (mind.id === "kamneshmyg" && !mind.job && mind.doorPurpose === "work" && mind.doorPhase === "enter") mind.doorPhase = "exit";
  if (mind.id === "kamneshmyg" && mind.job && mind.doorPhase === "exit") { mind.doorPhase = "enter"; mind.doorPurpose = "work"; }
  if ((mind.noticePending || mind.id === "lopukh" && mind.job) && mind.doorPhase === "enter") mind.doorPhase = "exit";
  const entering = mind.doorPhase === "enter", profile = FOREST_VILLAGER_PROFILES[mind.id];
  const sign = entering ? 1 : -1, seconds = Math.max(1.1, door.length / (profile.speed * .8));
  const progress = Math.max(0, Math.min(1, mind.doorProgress + sign * dt / seconds));
  const position = villagerDoorPosition(door, progress);
  // Every piece of a bend is tested, rather than cutting its chord on large dt.
  const checkpoints = door.distances.map(distance => distance / door.length)
    .filter(at => entering ? at > mind.doorProgress && at < progress : at < mind.doorProgress && at > progress)
    .sort((a, b) => sign * (a - b));
  const path = [...checkpoints.map(at => villagerDoorPosition(door, at)), position];
  const from = mind.position;
  let previous = from;
  const safe = path.every(point => {
    const clear = canTraverseResidents(previous, point, profile.size, occupants, mind.id); previous = point; return clear;
  });
  const fullExit = !entering && mind.doorProgress >= 1 && door.points.slice(1).some((point, index) =>
    !canTraverseResidents(door.points[index], point, profile.size, occupants, mind.id));
  if (!safe || fullExit) { mind.trafficWaiting = true; return true; }
  mind.trafficWaiting = false;
  for (const point of path) { mind.walked += villagerDistance(mind.position, point); mind.position = { ...point }; }
  mind.direction = villagerDirection(path.length > 1 ? path.at(-2)! : from, position);
  mind.doorProgress = progress;
  if (entering && progress >= 1) {
    mind.doorPhase = "inside"; setVillagerAction(mind, mind.job ? "work" : "rest");
    mind.wait = 42 + mind.decisions % 4 * 8; mind.workNeed = .4;
  } else if (!entering && progress <= 0) {
    mind.doorPhase = "outside"; mind.door = null;
    mind.outdoorUntil = mind.elapsed + (mind.id === "leaftail" ? 28 : 140 + mind.decisions % 5 * 9);
    mind.fatigue = Math.min(mind.fatigue, .25); setVillagerAction(mind, "inspect"); mind.wait = .2;
  }
  return true;
}
