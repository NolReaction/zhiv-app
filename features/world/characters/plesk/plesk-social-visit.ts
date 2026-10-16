import { canTraverseResidents, residentClearance, type ResidentOccupant } from "@/features/world/navigation/resident-traffic";
import { isWalkable } from "@/features/world/navigation/navigation";
import type { FixedWorldScene, WorldPoint } from "@/features/world/tiled/types";
import { PLESK, pleskLocalPlaces, pleskTravelTime, type PleskStop } from "./plesk-resident";
import { passageYields } from "./plesk-traffic";
import { pleskRouteFrom } from "./plesk-home";
import type { MindStage, PleskIntent, PleskMind } from "./plesk-mind";

export type PleskSocialVisit = { targetId: string; anchor: WorldPoint; phase: "approach" | "wait" | "return";
  saved: { stage: MindStage; age: number; queue: MindStage[]; intent: PleskIntent; stopId: string; position: WorldPoint }; until: number };
export function pleskAvailableForLeisure(mind: PleskMind | null): boolean {
  return !!mind?.available && mind.home.phase === "outside" && !mind.noticePending && !mind.tradePending
    && !mind.socialVisit && !passageYields.has(mind) && !["fish", "trade"].includes(mind.intent);
}
export function pleskCanPausePassing(mind: PleskMind | null): boolean {
  return pleskAvailableForLeisure(mind) && mind!.intent === "walk" && mind!.stage.action === "walk";
}
export function pleskCanReceiveVisit(mind: PleskMind | null): boolean {
  return !!mind?.available && mind.home.phase === "outside" && !mind.noticePending && !mind.tradePending && !mind.socialVisit && !passageYields.has(mind) && mind.intent !== "trade"
    && (["idle", "rest", "greet"].includes(mind.stage.action) && !mind.stage.deposit && !mind.stage.sell
      || mind.stage.action === "fish" && mind.age > 1);
}
/** An optional neighbour visit owns no economic catch or sale. Original harmless
 * travel resumes only after walking back to its exact paused foot position. */
export function requestPleskSocialVisit(mind: PleskMind | null, scene: FixedWorldScene,
  target: { id: string; position: WorldPoint; size?: number; approach?: WorldPoint }, occupants?: readonly ResidentOccupant[]): boolean {
  const places = pleskLocalPlaces(scene);
  if (!mind || !places || mind.scene !== scene || !pleskAvailableForLeisure(mind)
    || !["idle", "rest", "walk"].includes(mind.stage.action) || mind.stage.deposit || mind.stage.sell
    || ![target.position.x, target.position.y, target.size ?? PLESK.size].every(Number.isFinite) || (target.size ?? PLESK.size) <= 0) return false;
  const gap = residentClearance(PLESK.size, target.size ?? PLESK.size) + 8;
  const heading = Math.atan2(mind.position.y - target.position.y, mind.position.x - target.position.x);
  const candidates: PleskStop[] = [target.approach,
    ...[0, Math.PI / 4, -Math.PI / 4, Math.PI / 2, -Math.PI / 2, Math.PI].map(offset => ({
      x: target.position.x + Math.cos(heading + offset) * gap, y: target.position.y + Math.sin(heading + offset) * gap }))]
    .filter((position): position is WorldPoint => !!position && isWalkable(places.nav, position)
      && canTraverseResidents(position, position, PLESK.size, occupants, PLESK.id))
    .map(position => ({ id: `plesk-social:${target.id}`, position: { ...position } }));
  for (const stop of candidates) {
    const trail = pleskRouteFrom(places, mind.position, stop);
    if (!trail || trail.length > PLESK.speed * 45) continue;
    mind.socialVisit = { targetId: target.id, anchor: { ...target.position }, phase: "approach", until: mind.elapsed + 45,
      saved: { stage: mind.stage, age: mind.age, queue: [...mind.queue], intent: mind.intent, stopId: mind.stopId, position: { ...mind.position } } };
    mind.intent = "walk"; mind.reason = "Идёт к соседу обсудить рыбалку и лесные новости.";
    mind.stage = { action: "walk", target: stop, trail, duration: pleskTravelTime(trail) };
    mind.queue = []; mind.age = 0; mind.trafficWaiting = false; return true;
  }
  return false;
}
export function cancelPleskSocialVisit(mind: PleskMind | null): void {
  const visit = mind?.socialVisit, places = mind && pleskLocalPlaces(mind.scene);
  if (!mind || !visit || !places || visit.phase === "return") return;
  passageYields.delete(mind);
  const stop = { id: "plesk-social-return", position: visit.saved.position };
  const trail = pleskRouteFrom(places, mind.position, stop);
  visit.phase = "return"; mind.age = 0; mind.queue = []; mind.intent = "walk";
  if (trail && trail.length > .01) mind.stage = { action: "walk", target: stop, trail, duration: pleskTravelTime(trail) };
  else if (Math.hypot(mind.position.x - stop.position.x, mind.position.y - stop.position.y) < .01) finishPleskSocialStage(mind);
  else {
    mind.socialVisit = undefined; mind.stage = { action: "idle", target: { id: "plesk-social-stop", position: { ...mind.position } }, duration: 2 };
  }
}
export function finishPleskSocialStage(mind: PleskMind): boolean {
  const visit = mind.socialVisit;
  if (!visit) return false;
  if (visit.phase === "approach") {
    visit.phase = "wait"; mind.stage = { action: "greet", target: mind.stage.target, duration: 45 };
    mind.age = 0; mind.reason = "Обсуждает с соседом улов и дела у прилавка.";
  } else if (visit.phase === "return") {
    mind.stage = visit.saved.stage; mind.age = visit.saved.age; mind.queue = visit.saved.queue;
    mind.intent = visit.saved.intent; mind.stopId = visit.saved.stopId; mind.socialVisit = undefined;
  } else cancelPleskSocialVisit(mind);
  return true;
}
