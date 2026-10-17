import { canTraverseResidents, type ResidentOccupant } from "@/features/world/navigation/resident-traffic";
import { FOREST_VILLAGER_PROFILES, forestVillagerRoute, villagerDistance, type VillagerPlaces, type VillagerStop } from "./villager-navigation";
import type { ForestVillagerMind } from "./villager-state";

export const VILLAGER_GOAL_LIMITS = { patience: 2.4, retries: 2, cooldown: 36, failedStops: 8 } as const;
export function coolVillagerStops(mind: ForestVillagerMind, stops: readonly VillagerStop[], seconds: number = VILLAGER_GOAL_LIMITS.cooldown) {
  const ids = new Set(stops.map(stop => stop.id));
  mind.failedStops = [...mind.failedStops.filter(stop => stop.until > mind.elapsed && !ids.has(stop.id)),
    ...stops.slice(0, 4).map(stop => ({ id: stop.id, until: mind.elapsed + seconds + mind.decisions % 5 }))]
    .slice(-VILLAGER_GOAL_LIMITS.failedStops);
}
export function villagerGoalEligible(mind: ForestVillagerMind): boolean {
  return !mind.job && !mind.socialVisit && mind.doorPhase === "outside" && (!mind.woodwork || mind.woodwork.phase === "idle");
}
export function rememberVillagerGoal(mind: ForestVillagerMind) {
  if (!villagerGoalEligible(mind) || !mind.target || !["wander", "home"].includes(mind.intent)) {
    if (mind.intent !== "yield") mind.goal = null;
    return;
  }
  const old = mind.goal?.target.id === mind.target.id ? mind.goal : null;
  mind.goal = { target: { ...mind.target, position: { ...mind.target.position }, lookAt: { ...mind.target.lookAt } },
    intent: mind.intent as "wander" | "home", afterWalk: mind.afterWalk, startedAt: old?.startedAt ?? mind.elapsed,
    retries: old?.retries ?? 0, retryAt: mind.elapsed, blockedFor: 0, phase: "walking" };
}
function waitOrRelease(mind: ForestVillagerMind) {
  const goal = mind.goal!;
  mind.route = null; mind.speed = 0; mind.distance = 0; mind.stalledAt = null; mind.trafficWaiting = false;
  if (mind.action !== "inspect") { mind.action = "inspect"; mind.age = 0; }
  if (goal.retries >= VILLAGER_GOAL_LIMITS.retries) {
    coolVillagerStops(mind, [goal.target]); mind.goal = null; mind.habit = null; mind.wait = 4 + mind.decisions % 4;
  } else {
    goal.phase = "waiting"; goal.retryAt = mind.elapsed + 1 + goal.retries * .6; goal.blockedFor = 0;
  }
}
/** A temporary obstruction keeps the same destination through two slow,
 * checked attempts. Long-lived failure cools that destination instead of
 * choosing a different intention every few animation frames. */
export function blockVillagerGoal(mind: ForestVillagerMind, dt: number): boolean {
  if (!mind.goal || !villagerGoalEligible(mind)) return false;
  mind.goal.blockedFor += dt;
  if (mind.goal.blockedFor < VILLAGER_GOAL_LIMITS.patience) return false;
  waitOrRelease(mind); return true;
}
export function resumeVillagerGoal(mind: ForestVillagerMind, places: VillagerPlaces, occupants: readonly ResidentOccupant[]): boolean {
  const goal = mind.goal;
  if (!goal) return false;
  if (!villagerGoalEligible(mind)) { mind.goal = null; return false; }
  if (mind.route) return false;
  if (villagerDistance(mind.position, goal.target.position) < .1) { mind.goal = null; return false; }
  if (goal.phase === "walking") { goal.phase = "waiting"; goal.retryAt = mind.elapsed + 1; }
  if (mind.elapsed < goal.retryAt) return true;
  goal.retries++; mind.decisions++;
  const size = FOREST_VILLAGER_PROFILES[mind.id].size;
  const selected = canTraverseResidents(goal.target.position, goal.target.position, size, occupants, mind.id)
    && forestVillagerRoute(places, mind.position, [goal.target], size, goal.intent === "wander" ? FOREST_VILLAGER_PROFILES[mind.id].speed * 18 : Infinity);
  if (!selected) { waitOrRelease(mind); return true; }
  mind.target = selected.target; mind.route = selected.route; mind.distance = 0; mind.speed = 0; mind.trafficWaiting = false;
  mind.intent = goal.intent; mind.afterWalk = goal.afterWalk; goal.phase = "walking"; goal.blockedFor = 0;
  if (mind.action !== "walk") { mind.action = "walk"; mind.age = 0; }
  return false;
}
