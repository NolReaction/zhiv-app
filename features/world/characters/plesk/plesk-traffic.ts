import { canTraverse } from "@/features/world/navigation/navigation";
import { canTraverseResidents, residentClearance, residentTrafficDetour, residentRequestingPassage, residentYieldPoint,
  residentPassageClear, RESIDENT_TRAFFIC_LIMITS, type ResidentOccupant } from "@/features/world/navigation/resident-traffic";
import { PLESK, measurePleskTrail, pleskTravelTime, samplePleskTrail, type PleskPlaces } from "./plesk-resident";
import type { MindStage, PleskMind } from "./plesk-mind";
const clamp = (n: number) => Math.max(0, Math.min(1, Number.isFinite(n) ? n : 0));
type PassageYield = { stage: MindStage; age: number; phase: "aside" | "wait" | "resume"; retryAt: number; requesterId: string };
export const passageYields = new WeakMap<PleskMind, PassageYield>();
const yieldRetryAt = new WeakMap<PleskMind, number>();

/** The temporary route is cosmetic. Preserve the original queue and exact
 * action age, and never replay a fish deposit, sale or greeting on its behalf. */
export function beginPassageYield(mind: PleskMind, places: PleskPlaces, occupants?: readonly ResidentOccupant[], optionalHold = false, partnerId?: string) {
  if (!["walk", "idle", "rest"].includes(mind.stage.action) || mind.stage.deposit || mind.stage.sell
    || mind.elapsed < (yieldRetryAt.get(mind) ?? 0)) return;
  const traffic = optionalHold ? occupants?.filter(other => other.id !== partnerId && (other.intent?.priority ?? 0) >= 2) : occupants;
  const requester = residentRequestingPassage(mind.position, PLESK.size, traffic, PLESK.id,
    mind.stage.action === "walk" ? mind.intent === "trade" ? 2 : 1 : 0);
  if (!requester) return;
  if (mind.stage.action === "walk" && Math.hypot(mind.stage.target.position.x - requester.position.x,
    mind.stage.target.position.y - requester.position.y) > residentClearance(PLESK.size, requester.size)) return;
  yieldRetryAt.set(mind, mind.elapsed + RESIDENT_TRAFFIC_LIMITS.retry);
  const position = residentYieldPoint(places.nav, mind.position, PLESK.size, occupants, PLESK.id, requester);
  if (!position) return;
  passageYields.set(mind, { stage: mind.stage, age: mind.age, phase: "aside", retryAt: 0, requesterId: requester.id });
  const trail = measurePleskTrail([{ ...mind.position }, position]);
  mind.stage = { action: "walk", target: { ...mind.stage.target, id: "plesk-yield", position }, trail, duration: pleskTravelTime(trail) };
  mind.age = 0; mind.trafficWaiting = false;
}

export function advancePassageYield(mind: PleskMind, places: PleskPlaces, step: number, occupants?: readonly ResidentOccupant[]) {
  const saved = passageYields.get(mind)!;
  mind.elapsed += step;
  mind.needs.energy = clamp(mind.needs.energy - step * .0014);
  mind.needs.patience = clamp(mind.needs.patience + step * .013);
  mind.needs.social = clamp(mind.needs.social + step * .002);
  if (saved.phase === "wait") {
    if (mind.elapsed < saved.retryAt) return;
    saved.retryAt = mind.elapsed + RESIDENT_TRAFFIC_LIMITS.retry;
    const requester = occupants?.find(other => other.id === saved.requesterId);
    if (requester?.moving && !residentPassageClear(saved.stage.target.position, PLESK.size, requester, places.nav.cellSize)) return;
    const points = residentTrafficDetour({ owner: mind, navigation: places.nav, from: mind.position,
      target: saved.stage.target.position, size: PLESK.size, occupants, selfId: PLESK.id, time: mind.elapsed });
    if (!points || points.length < 2) return;
    const trail = measurePleskTrail(points);
    mind.stage = { action: "walk", target: { ...saved.stage.target, id: "plesk-yield" }, trail, duration: pleskTravelTime(trail) };
    mind.age = 0; saved.phase = "resume";
    return;
  }
  const age = Math.min(mind.stage.duration, mind.age + step), trail = mind.stage.trail!;
  const next = samplePleskTrail(trail, age);
  if (!canTraverse(places.nav, mind.position, next) || !canTraverseResidents(mind.position, next, PLESK.size, occupants, PLESK.id)) {
    const points = residentTrafficDetour({ owner: mind, navigation: places.nav, from: mind.position,
      target: mind.stage.target.position, size: PLESK.size, occupants, selfId: PLESK.id, time: mind.elapsed });
    mind.trafficWaiting = true;
    if (points && points.length > 1) {
      const detour = measurePleskTrail(points);
      mind.stage = { ...mind.stage, trail: detour, duration: pleskTravelTime(detour) }; mind.age = 0;
    }
    return;
  }
  mind.position = { x: next.x, y: next.y }; mind.age = age; mind.trafficWaiting = false;
  if (age < mind.stage.duration - 1e-8) return;
  if (saved.phase === "aside") {
    saved.phase = "wait"; saved.retryAt = mind.elapsed + 1.6;
    mind.stage = { action: "idle", target: mind.stage.target, duration: 1.6 }; mind.age = 0;
  } else {
    mind.stage = saved.stage; mind.age = saved.stage.action === "walk" ? saved.stage.duration : saved.age;
    passageYields.delete(mind); yieldRetryAt.set(mind, mind.elapsed + 1.6);
  }
}
