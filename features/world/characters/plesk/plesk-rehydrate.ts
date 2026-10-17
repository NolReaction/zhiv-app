import { canTraverse, isWalkable } from "@/features/world/navigation/navigation";
import type { FixedWorldScene, WorldPoint } from "@/features/world/tiled/types";
import { pleskPersonalHome, pleskRouteFrom } from "./plesk-home";
import { pleskLocalPlaces, pleskTravelTime, type PleskStop } from "./plesk-resident";
import { passageYields } from "./plesk-traffic";
import type { MindStage, PleskMind } from "./plesk-mind";

const distance = (a: WorldPoint, b: WorldPoint) => Math.hypot(a.x - b.x, a.y - b.y);
const cloneStage = (stage: MindStage): MindStage => ({ ...stage,
  target: { ...stage.target, position: { ...stage.target.position } },
  ...(stage.trail ? { trail: { ...stage.trail, points: stage.trail.points.map(point => ({ ...point })), distances: [...stage.trail.distances] } } : {}) });
const atDoor = (mind: PleskMind) => ["enter", "inside", "exit"].includes(mind.home.phase);

/** Local artwork handoff only. Server hydration retains its separate reset
 * policy; no saved account data or another camera's reservations are adopted. */
export function rehydratePleskState(scene: FixedWorldScene, previous: PleskMind): PleskMind {
  const next: PleskMind = { ...previous, scene, position: { ...previous.position }, needs: { ...previous.needs },
    recent: [...previous.recent], stage: cloneStage(previous.stage), queue: previous.queue.map(cloneStage),
    home: { ...previous.home }, socialVisit: undefined,
    ...(previous.castTarget ? { castTarget: { ...previous.castTarget } } : {}),
    observation: { ...previous.observation, needs: { ...previous.observation.needs } } };
  const report = () => {
    next.observation = { action: next.stage.action, intent: next.intent, reason: next.reason, needs: { ...next.needs },
      catchCount: next.catchCount, destinationId: next.stage.target.id, decisions: next.decisions };
    return next;
  };
  const unavailable = () => {
    // Keep the invalid old plan as a validation snapshot, never as an executed
    // route. acceptScene will keep rejecting it while its feet/goal/door/path
    // do not match the new geometry. Nothing teleports or completes its catch.
    next.available = false; next.reason = "Личное место изменилось: ждёт безопасного пути без переноса ног.";
    return report();
  };
  const places = pleskLocalPlaces(scene);
  if (!places) return unavailable();
  const door = pleskPersonalHome(scene, places.nav), previousDoor = previous.home.door;
  if (atDoor(previous)) {
    if (!door || !previousDoor || distance(door.entry, previousDoor.entry) > .01 || distance(door.doorway, previousDoor.doorway) > .01
      || !canTraverse(door.navigation, next.position, next.position)) return unavailable();
    const expected = { x: door.entry.x + (door.doorway.x - door.entry.x) * next.home.progress,
      y: door.entry.y + (door.doorway.y - door.entry.y) * next.home.progress };
    if (distance(expected, next.position) > .01) return unavailable();
    next.home.door = door; next.available = true; return report();
  }
  if (!isWalkable(places.nav, next.position)) return unavailable();
  if (previous.socialVisit) {
    // The former director owns that invitation. Resume ordinary life from the
    // actual visible feet, without claiming that the old meeting took place.
    const target = { id: "plesk-leisure-pause", position: { ...next.position } };
    next.stage = { action: "idle", duration: 2, target }; next.age = 0; next.queue = [];
    next.stopId = target.id; next.intent = "look"; next.trafficWaiting = false;
    next.walkBlockedFor = 0; next.available = true;
    next.reason = "Осматривается после перемены на поляне, затем продолжит свои дела.";
    return report();
  }
  const savedYield = passageYields.get(previous);
  const stage = savedYield ? cloneStage(savedYield.stage) : next.stage;
  const age = savedYield?.age ?? next.age;
  const localStops = [places.base, places.trade, places.rest, door?.stop].filter((stop): stop is PleskStop => Boolean(stop));
  const stopFor = (target: PleskStop) => {
    const stop = localStops.find(stop => stop.id === target.id) ?? target;
    return { ...stop, position: { ...stop.position } };
  };
  const target = stopFor(stage.target), moved = distance(stage.target.position, target.position) > .01;
  if (next.home.phase === "approach" && !door) return unavailable();
  // An existing catch/transfer is safe at an unchanged work stop. Relocating an
  // active cast, packing gesture or sale would invent a jump or replay work.
  if (moved && !stage.trail && (!["idle", "rest", "greet"].includes(stage.action) || stage.caught || stage.deposit || stage.sell || stage.outcome))
    return unavailable();
  if (!isWalkable(places.nav, target.position)) return unavailable();
  // Every future walk starts at the preceding physical endpoint. Merely
  // replacing its target would leave an old trail ending at the former stop,
  // and finishStage would snap the feet to the new one.
  const queue: MindStage[] = [];
  let from = target.position;
  for (const entry of next.queue) {
    const destination = stopFor(entry.target);
    if (!isWalkable(places.nav, destination.position)) return unavailable();
    const stationary = { ...entry, target: destination };
    const safeTrail = entry.trail && distance(entry.trail.points[0], from) < .01
      && distance(entry.trail.points.at(-1)!, destination.position) < .01
      && entry.trail.points.every((point, index, points) => !index || canTraverse(places.nav, points[index - 1], point));
    if (safeTrail) queue.push(stationary);
    else {
      if (distance(from, destination.position) > .01) {
        const trail = pleskRouteFrom(places, from, destination);
        if (!trail) return unavailable();
        queue.push({ action: "walk", target: destination, trail, duration: pleskTravelTime(trail) });
      }
      if (!entry.trail) queue.push(stationary);
    }
    from = destination.position;
  }
  const safeOriginal = !savedYield && !moved && stage.trail && distance(stage.trail.points.at(-1)!, target.position) < .01
    && stage.trail.points.every((point, index, points) => !index || canTraverse(places.nav, points[index - 1], point));
  if (stage.trail && safeOriginal) {
    next.stage = stage; next.age = age; next.queue = queue;
  } else if (distance(next.position, target.position) > .01) {
    const trail = pleskRouteFrom(places, next.position, target);
    if (!trail) return unavailable();
    const resume = stage.trail ? [] : [{ ...stage, target, duration: Math.max(.1, stage.duration - age) }];
    next.stage = { action: "walk", target, trail, duration: pleskTravelTime(trail) }; next.age = 0;
    next.queue = [...resume, ...queue]; next.trafficWaiting = false; next.walkBlockedFor = 0;
    next.walkBlockedX = next.position.x; next.walkBlockedY = next.position.y;
  } else {
    next.stage = stage.trail ? { action: "idle", target, duration: .05 } : { ...stage, target };
    next.age = stage.trail ? 0 : age; next.stopId = target.id; next.queue = queue;
  }
  next.home.door = door ?? undefined;
  next.available = true; return report();
}
