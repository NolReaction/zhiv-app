import { canTraverse, createWorldNavigation, isWalkable, type WorldNavigation } from "@/features/world/navigation/navigation";
import type { FixedWorldScene, WorldPoint } from "@/features/world/tiled/types";
import type { ForestVillagerId } from "@/features/world/characters/forest-villager-types";
import type { VillagerDoor, VillagerStop } from "./villager-navigation";

const distance = (a: WorldPoint, b: WorldPoint) => Math.hypot(a.x - b.x, a.y - b.y);
const finite = (point: WorldPoint | undefined): point is WorldPoint => !!point && Number.isFinite(point.x) && Number.isFinite(point.y);
function inside(point: WorldPoint, polygon: readonly WorldPoint[]): boolean {
  let result = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i], b = polygon[j];
    if ((a.y > point.y) !== (b.y > point.y) && point.x < (b.x - a.x) * (point.y - a.y) / (b.y - a.y) + a.x) result = !result;
  }
  return result;
}
function corridor(a: WorldPoint, b: WorldPoint, radius: number): WorldPoint[] {
  const length = distance(a, b), dx = (b.x - a.x) / length, dy = (b.y - a.y) / length, pad = radius + 2;
  return [[-pad, -pad], [length + pad, -pad], [length + pad, pad], [-pad, pad]]
    .map(([along, side]) => ({ x: a.x + dx * along - dy * side, y: a.y + dy * along + dx * side }));
}
function door(id: string, kind: VillagerDoor["kind"], points: WorldPoint[], fadeDistance: number, navigation: WorldNavigation): VillagerDoor {
  const distances = [0];
  for (let i = 1; i < points.length; i++) distances.push(distances[i - 1] + distance(points[i - 1], points[i]));
  return { id, kind, points, distances, length: distances.at(-1)!, fadeAt: fadeDistance / distances.at(-1)!, navigation,
    approach: { id: `${id}:door`, position: { ...points[0] }, lookAt: { ...points.at(-1)! } } };
}

/** A short private crossing uses only its own building exception. Its narrow
 * ground strip never changes ordinary paths; water and every other collider stay. */
export function forestVillagerDoor(scene: FixedWorldScene, id: ForestVillagerId, navigation: WorldNavigation,
  stops: readonly VillagerStop[]): VillagerDoor | null {
  const site = scene.sites.find(site => site.id === (id === "lopukh" ? "lopukh-home" : id === "kamneshmyg" ? "quarry" : "leaftail-caravan"));
  if (!site || !finite(site.entry) || !finite(site.anchor)) return null;
  if (id === "leaftail" && !finite(site.doorway)) {
    // The wagon has no authored doorway. Walk behind its actual silhouette,
    // keeping the complete ground collision, then conceal the resident there.
    const heading = Math.atan2(site.anchor.y - site.entry.y, site.anchor.x - site.entry.x);
    for (const length of [16, 12, 8, 4]) for (const offset of [0, -Math.PI / 4, Math.PI / 4, -Math.PI / 2, Math.PI / 2, Math.PI]) {
      const concealed = { x: site.entry.x + Math.cos(heading + offset) * length, y: site.entry.y + Math.sin(heading + offset) * length };
      if (inside(concealed, site.hitArea) && canTraverse(navigation, site.entry, concealed))
        return door(site.id, "concealment", [{ ...site.entry }, concealed], 0, navigation);
    }
    return null;
  }
  if (!finite(site.doorway) || site.collision.length < 3 || !inside(site.doorway, site.collision)
    || distance(site.entry, site.doorway) < 1 || distance(site.entry, site.doorway) > 52 || !scene.navigation) return null;
  const approaches = isWalkable(navigation, site.entry)
    ? [{ id: `${site.id}:entry`, position: site.entry, lookAt: site.doorway }, ...stops] : [...stops];
  for (const stop of approaches.sort((a, b) => distance(a.position, site.entry) - distance(b.position, site.entry)).slice(0, 4)) {
    const approach = distance(stop.position, site.entry), length = approach + distance(site.entry, site.doorway);
    if (approach > 55 || length > 90) continue;
    const points = [stop.position, site.entry, site.doorway].filter((point, index, all) => !index || distance(point, all[index - 1]) > .01);
    const strips = points.slice(1).map((point, index) => ({ id: `${site.id}:private-door:${index}`,
      points: corridor(points[index], point, navigation.radius) }));
    const local = createWorldNavigation({ ...scene, sites: scene.sites.filter(other => other !== site),
      navigation: { ...scene.navigation, areas: [...scene.navigation.areas, ...strips] } }, navigation.radius);
    if (local && points.slice(1).every((point, index) => canTraverse(local, points[index], point)))
      return door(site.id, "threshold", points.map(point => ({ ...point })), approach, local);
  }
  return null;
}
