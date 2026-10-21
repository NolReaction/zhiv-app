import { isWalkable } from "@/features/world/navigation/navigation";
import type { ResidentOccupant } from "@/features/world/navigation/resident-traffic";
import { selectVillagerRoute, setVillagerAction } from "./villager-movement";
import { villagerDistance, type VillagerPlaces, type VillagerStop } from "./villager-navigation";
import type { ForestVillagerMind, VillagerHabit } from "./villager-state";

const variation = (mind: ForestVillagerMind, spread: number) => (mind.decisions * 17 + mind.habitCycles * 31) % spread;
function finishHabit(mind: ForestVillagerMind) {
  if (mind.habit?.kind === "woodpile" && mind.habit.phase === "inspect") {
    mind.checkedDelivery = mind.woodwork?.lastDelivery?.sequence ?? mind.checkedDelivery;
    mind.socialNeed = Math.min(1, mind.socialNeed + .2);
  }
  mind.habit = null; mind.habitCycles++;
  mind.habitAfter = mind.elapsed + (mind.id === "leaftail" ? 48 : 32) + variation(mind, 25);
  mind.wait = 3 + variation(mind, 5);
}
function candidates(mind: ForestVillagerMind, places: VillagerPlaces): { kind: VillagerHabit["kind"]; stops: VillagerStop[] } | null {
  if (mind.id === "lopukh") {
    const delivery = mind.woodwork?.lastDelivery;
    if (!delivery || delivery.sequence <= mind.checkedDelivery || !places.woodcutting) return null;
    return { kind: "woodpile", stops: [...places.woodcutting.delivery]
      .sort((a, b) => villagerDistance(a.position, delivery.position) - villagerDistance(b.position, delivery.position))
      .map((stop, index) => ({ ...stop, id: `lopukh:woodpile:${delivery.sequence}:${index}`, lookAt: { ...delivery.position } })) };
  }
  if (mind.id === "kamneshmyg") return mind.postWorkWalk ? { kind: "post-work-walk",
    stops: places.wander.filter(stop => stop.id.includes(":neighbourhood:") && villagerDistance(stop.position, mind.position) > 24) } : null;
  return { kind: "shop-inspection", stops: places.work.filter(stop => villagerDistance(stop.position, mind.position) > 18
    && (!places.door || villagerDistance(stop.position, places.door.approach.position) > 24)) };
}

/** Each role finishes a small physical task. No report of production, sale or
 * inventory is synthesized: the woodpile must already exist and the miner's
 * post-shift walk is armed only by an observed expired confirmed job. */
export function advanceVillagerHabit(mind: ForestVillagerMind, places: VillagerPlaces,
  occupants: readonly ResidentOccupant[]): boolean {
  if (mind.job || mind.socialVisit || mind.doorPhase !== "outside" || mind.noticePending
    || mind.woodwork && mind.woodwork.phase !== "idle") { mind.habit = null; return false; }
  if (mind.habit) {
    if (mind.route || mind.goal) return false;
    if (mind.habit.phase === "walk") {
      if (!mind.target || villagerDistance(mind.position, mind.target.position) > .1) { finishHabit(mind); return false; }
      mind.habit.phase = "inspect"; mind.habit.until = mind.elapsed + 3 + variation(mind, 5);
    }
    setVillagerAction(mind, "inspect");
    if (mind.elapsed < mind.habit.until) return true;
    finishHabit(mind); return true;
  }
  if (mind.route || mind.goal || mind.elapsed < mind.habitAfter || mind.action === "greet" && mind.wait > 0) return false;
  const plan = candidates(mind, places);
  if (!plan) return false;
  const offset = mind.habitCycles % Math.max(1, plan.stops.length), stops = [...plan.stops.slice(offset), ...plan.stops.slice(0, offset)]
    .filter(stop => isWalkable(places.navigation, stop.position));
  mind.habitAfter = mind.elapsed + 12 + variation(mind, 7);
  if (!selectVillagerRoute(mind, places, stops, "wander", "inspect", occupants)) return false;
  mind.habit = { kind: plan.kind, phase: "walk", until: 0 };
  if (plan.kind === "post-work-walk") mind.postWorkWalk = false;
  return false;
}
