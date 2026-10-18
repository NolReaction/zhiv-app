import { canTraverse, createWorldNavigation, findWorldPath, isWalkable, type WorldNavigation } from "@/features/world/navigation/navigation";
import { canTraverseResidents } from "@/features/world/navigation/resident-traffic";
import { prepareSteeringPath } from "@/features/world/navigation/steering";
import type { FixedWorldScene, WorldPoint } from "@/features/world/tiled/types";
import { PLESK, measurePleskTrail, pleskTravelTime, type PleskPlaces, type PleskStop } from "./plesk-resident";
import type { PleskEnvironment, PleskMind } from "./plesk-mind";

export type PleskHome = { entry: WorldPoint; doorway: WorldPoint; navigation: WorldNavigation; stop: PleskStop; length: number };
export type PleskHomeState = { phase: "outside" | "approach" | "enter" | "inside" | "exit";
  progress: number; nextAt: number; until: number; door?: PleskHome };
const cache = new WeakMap<FixedWorldScene, PleskHome | null>();
const distance = (a: WorldPoint, b: WorldPoint) => Math.hypot(a.x - b.x, a.y - b.y);
function inside(point: WorldPoint, polygon: readonly WorldPoint[]) {
  let result = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i], b = polygon[j];
    if ((a.y > point.y) !== (b.y > point.y) && point.x < (b.x - a.x) * (point.y - a.y) / (b.y - a.y) + a.x) result = !result;
  }
  return result;
}
/** Only a bounded authored doorway can omit its own house collision. A private
 * strip supplies threshold ground, without opening ordinary routes or water. */
export function pleskPersonalHome(scene: FixedWorldScene, nav: WorldNavigation): PleskHome | null {
  if (cache.has(scene)) return cache.get(scene)!;
  const site = scene.sites.find(site => site.id === "plesk-shop");
  let result: PleskHome | null = null;
  if (site && site.doorway && scene.navigation && [site.entry, site.doorway].every(point => Number.isFinite(point.x) && Number.isFinite(point.y))
    && isWalkable(nav, site.entry) && inside(site.doorway, site.collision)) {
    const length = distance(site.entry, site.doorway);
    if (length >= 1 && length <= 52) {
      const dx = (site.doorway.x - site.entry.x) / length, dy = (site.doorway.y - site.entry.y) / length, pad = nav.radius + 2;
      const points = [[-pad, -pad], [length + pad, -pad], [length + pad, pad], [-pad, pad]]
        .map(([along, side]) => ({ x: site.entry.x + dx * along - dy * side, y: site.entry.y + dy * along + dx * side }));
      const navigation = createWorldNavigation({ ...scene, sites: scene.sites.filter(other => other !== site),
        navigation: { ...scene.navigation, areas: [...scene.navigation.areas, { id: "plesk-private-threshold", points }] } }, nav.radius);
      if (navigation && canTraverse(navigation, site.entry, site.doorway)) result = { entry: { ...site.entry }, doorway: { ...site.doorway },
        length, navigation, stop: { id: "plesk-home-entry", position: { ...site.entry } } };
    }
  }
  cache.set(scene, result); return result;
}
export function pleskRouteFrom(places: PleskPlaces, from: WorldPoint, target: PleskStop) {
  const points = findWorldPath(places.nav, from, target.position);
  const smooth = points && prepareSteeringPath(places.nav, points, PLESK.size);
  return smooth && smooth.points.length > 1 ? measurePleskTrail(smooth.points) : undefined;
}
export function beginPleskHome(mind: PleskMind, places: PleskPlaces): boolean {
  const door = pleskPersonalHome(mind.scene, places.nav);
  if (!door) return false;
  const trail = distance(mind.position, door.entry) > .01 ? pleskRouteFrom(places, mind.position, door.stop) : undefined;
  if (!trail && distance(mind.position, door.entry) > .01) { mind.home.nextAt = mind.elapsed + 30; return false; }
  mind.home = { ...mind.home, door, phase: trail ? "approach" : "enter", progress: 0 };
  mind.queue = []; mind.age = 0; mind.trafficWaiting = false;
  mind.stage = trail ? { action: "walk", target: door.stop, trail, duration: pleskTravelTime(trail) }
    : { action: "idle", target: door.stop, duration: 1 };
  return true;
}
export function pleskHomeGeometryMatches(mind: PleskMind, scene: FixedWorldScene, places: PleskPlaces): boolean {
  const previous = mind.home.door, current = pleskPersonalHome(scene, places.nav);
  const valid = !!previous && !!current && distance(previous.entry, current.entry) < .01 && distance(previous.doorway, current.doorway) < .01
    && canTraverse(current.navigation, mind.position, mind.position);
  if (valid) mind.home.door = current!;
  return valid;
}
export function reachPleskHome(mind: PleskMind) {
  mind.home.phase = "enter"; mind.home.progress = 0; mind.age = 0;
  mind.stage = { action: "idle", target: mind.home.door!.stop, duration: 1 };
}
/** The sole scene owner calls this with active time. Door reversal preserves
 * actual feet and opacity; a blocked exit never spawns an invisible occupant. */
export function advancePleskHome(mind: PleskMind, step: number, env: PleskEnvironment): number {
  const home = mind.home, door = home.door;
  if (!door || home.phase === "outside" || home.phase === "approach") return 0;
  let remaining = step;
  const consume = (slice: number) => {
    mind.elapsed += slice; remaining -= slice;
    mind.needs.energy = Math.min(1, mind.needs.energy + slice * .015);
    mind.needs.patience = Math.min(1, mind.needs.patience + slice * .012);
  };
  for (let transitions = 0; remaining > 1e-8 && transitions < 5 && home.phase !== "outside"; transitions++) {
    const called = mind.noticePending || mind.tradePending;
    if (home.phase === "enter" && called) home.phase = "exit";
    if (home.phase === "inside") {
      mind.reason = "Дома сушит снасти и отдыхает перед следующей рыбалкой.";
      if (!called && (mind.elapsed < home.until || env.rain >= .6 || env.dusk >= .72)) {
        consume(env.rain >= .6 || env.dusk >= .72 ? remaining : Math.min(remaining, home.until - mind.elapsed));
        if (remaining < 1e-8) break;
      }
      home.phase = "exit";
    }
    const entering = home.phase === "enter", duration = door.length / PLESK.speed;
    const slice = Math.min(remaining, duration * (entering ? 1 - home.progress : home.progress));
    const progress = Math.max(0, Math.min(1, home.progress + slice / duration * (entering ? 1 : -1)));
    const next = { x: door.entry.x + (door.doorway.x - door.entry.x) * progress,
      y: door.entry.y + (door.doorway.y - door.entry.y) * progress };
    if (!canTraverse(door.navigation, mind.position, next)
      || !canTraverseResidents(mind.position, next, PLESK.size, env.occupants, PLESK.id)) {
      mind.trafficWaiting = true; consume(remaining); break;
    }
    consume(slice); mind.trafficWaiting = false; mind.position = next; home.progress = progress;
    mind.reason = entering ? "Заходит домой убрать снасти и передохнуть." : "Выходит из дома к гостям и рыбацким делам.";
    if (progress >= 1 - 1e-8 && entering) {
      home.progress = 1; home.phase = "inside"; home.until = mind.elapsed + 35 + mind.seed % 21;
      mind.stage = { action: "rest", target: door.stop, duration: home.until - mind.elapsed }; mind.age = 0;
    } else if (progress <= 1e-8 && !entering) {
      home.progress = 0; home.phase = "outside"; home.nextAt = mind.elapsed + 140 + mind.seed % 41;
      mind.stopId = door.stop.id; mind.age = 0; mind.walkAfter = mind.elapsed + 20;
      mind.stage = { action: "idle", duration: 1, target: door.stop }; mind.queue = [];
    }
  }
  return step - remaining;
}
export function pleskHomeFrame(mind: PleskMind) {
  const home = mind.home, door = home.door!;
  if (!door || !["enter", "exit"].includes(home.phase)) return null;
  const entering = home.phase === "enter", dx = (door.doorway.x - door.entry.x) * (entering ? 1 : -1);
  const dy = (door.doorway.y - door.entry.y) * (entering ? 1 : -1);
  const expected = { x: door.entry.x + (door.doorway.x - door.entry.x) * home.progress,
    y: door.entry.y + (door.doorway.y - door.entry.y) * home.progress };
  const threshold = home.progress >= 0 && home.progress <= 1 && distance(mind.position, expected) < 1e-5;
  return { opacity: Math.max(0, 1 - home.progress), direction: Math.abs(dx) > Math.abs(dy)
    ? dx > 0 ? "right" as const : "left" as const : dy > 0 ? "front" as const : "back" as const,
    ...(threshold ? { doorwayOcclusion: { siteId: "plesk-shop" as const, top: door.doorway.y - PLESK.size * .84 } } : {}) };
}
