import { isWalkable, type WorldNavigation } from "@/features/world/navigation/navigation";
import type { FixedWorldScene, WorldPoint } from "@/features/world/tiled/types";
import type { VillagerStop } from "./villager-navigation";

export type WoodcutterPlaces = { work: VillagerStop[]; delivery: VillagerStop[]; rest: VillagerStop[] };
const distance = (a: WorldPoint, b: WorldPoint) => Math.hypot(a.x - b.x, a.y - b.y);
const finite = (point: WorldPoint | undefined): point is WorldPoint => !!point && Number.isFinite(point.x) && Number.isFinite(point.y);
const belongsTo = (id: string, prefix: string) => id === prefix || id.startsWith(`${prefix}-`);
const hasWorkMarkers = (scene: FixedWorldScene) => scene.destinations?.some(stop => ["lopukh-work", "lopukh-delivery", "lopukh-rest"]
  .some(prefix => belongsTo(stop.id, prefix)));
function edgeDistance(point: WorldPoint, a: WorldPoint, b: WorldPoint) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const ratio = Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / (dx * dx + dy * dy || 1)));
  return distance(point, { x: a.x + dx * ratio, y: a.y + dy * ratio });
}
function safeOutdoorGround(scene: FixedWorldScene, navigation: WorldNavigation, point: WorldPoint, size: number): boolean {
  const house = scene.sites.find(site => site.id === "lopukh-home");
  return !!house && isWalkable(navigation, point) && house.collision.every((a, index, points) =>
      edgeDistance(point, a, points[(index + 1) % points.length]) >= size * .32);
}
function safeFrontGround(scene: FixedWorldScene, navigation: WorldNavigation, point: WorldPoint, size: number): boolean {
  const house = scene.sites.find(site => site.id === "lopukh-home");
  return !!house && point.y >= house.bounds.y + house.bounds.height + size * 45 / 48 + 2
    && safeOutdoorGround(scene, navigation, point, size);
}

/** Authored storage is the only unload target, including an occupied-yard retry.
 * Old maps without that marker retain their safe outdoor compatibility. */
export function woodcutterSafeDrop(scene: FixedWorldScene, navigation: WorldNavigation, point: WorldPoint, size: number): boolean {
  const storage = scene.destinations?.filter(stop => belongsTo(stop.id, "lopukh-delivery"));
  return storage?.length ? safeOutdoorGround(scene, navigation, point, size) && storage.some(stop => finite(stop.position)
    && safeOutdoorGround(scene, navigation, stop.position, size) && distance(stop.position, point) <= 3)
    : !hasWorkMarkers(scene) && safeFrontGround(scene, navigation, point, size);
}

/** Work, delivery and rest are different outdoor stops. The visual centre of
 * an oblique house is not its front axis: use its authored doorway instead. */
export function woodcutterPlaces(scene: FixedWorldScene, navigation: WorldNavigation, size: number): WoodcutterPlaces | null {
  const house = scene.sites.find(site => site.id === "lopukh-home");
  if (!house || house.collision.length < 3 || !finite(house.entry) || !finite(house.anchor)) return null;
  const inner = finite(house.doorway) && distance(house.entry, house.doorway) > 1 ? house.doorway : house.anchor;
  const length = distance(house.entry, inner), outward = length > .1
    ? { x: (house.entry.x - inner.x) / length, y: (house.entry.y - inner.y) / length } : { x: 0, y: 1 };
  const side = { x: -outward.y, y: outward.x };
  // Explicit Tiled stops may stand beside the house. Validate their real
  // ground and wall clearance; the image's bottom is not a ground boundary.
  // Only generated legacy stops need the conservative front-yard heuristic.
  const safe = (point: WorldPoint) => safeFrontGround(scene, navigation, point, size);
  const hasAuthoredZone = hasWorkMarkers(scene);
  const authored = (prefix: string): VillagerStop[] | undefined => {
    const markers = scene.destinations?.filter(stop => belongsTo(stop.id, prefix));
    // An edited but blocked marker must not silently choose a different yard.
    return markers?.length ? markers.slice(0, 6).filter(stop => finite(stop.position)
      && safeOutdoorGround(scene, navigation, stop.position, size))
      .map(stop => ({ id: stop.id, position: { ...stop.position }, lookAt: { ...house.entry } })) : hasAuthoredZone ? [] : undefined;
  };
  const front = (name: string, forward: readonly number[], across: readonly number[]) => forward.flatMap(ahead => across.map(across => ({
    x: house.entry.x + outward.x * size * ahead + side.x * size * across,
    y: house.entry.y + outward.y * size * ahead + side.y * size * across,
  }))).filter(safe).slice(0, 6).map((position, index) => ({ id: `lopukh-${name}:${index}`, position, lookAt: { ...house.entry } }));
  const delivery = authored("lopukh-delivery") ?? front("delivery", [.9, 1.15, 1.4, 1.7], [.35, -.35, 0, .85, -.85, 1.2, -1.2]);
  const rest = authored("lopukh-rest") ?? front("rest", [1.45, 1.7, 2], [.35, -.35, .85, -.85, 0, 1.2, -1.2]);
  if (!delivery.length || !rest.length) return null;
  const treeCandidates = (scene.treeInteractions ?? []).filter(tree => tree.points.length >= 3 && Number.isFinite(tree.frontY))
    .map(tree => ({ tree, proximity: Math.min(...tree.points.map(point => distance(point, house.entry))) }))
    .filter(tree => tree.proximity <= size * 8).sort((a, b) => a.proximity - b.proximity).slice(0, 4)
    .flatMap(({ tree }) => tree.points.filter((point, index) => finite(point) && index % Math.max(1, Math.ceil(tree.points.length / 48)) === 0).flatMap((point, index) => {
      const length = distance(point, house.entry), dx = (house.entry.x - point.x) / (length || 1), dy = (house.entry.y - point.y) / (length || 1);
      return [.4, .6, .8].map(offset => ({ id: `lopukh-tree:${tree.id}:${index}:${offset}`,
        position: { x: point.x + dx * size * offset, y: point.y + dy * size * offset }, lookAt: { ...point } }));
    })).filter(stop => distance(stop.position, house.entry) <= size * 5 && safe(stop.position))
    .sort((a, b) => distance(a.position, house.entry) - distance(b.position, house.entry));
  const treeStops: VillagerStop[] = [];
  for (const stop of treeCandidates) {
    if (treeStops.every(other => distance(other.position, stop.position) > size * .25)) treeStops.push(stop);
    if (treeStops.length >= 6) break;
  }
  // Compatibility maps without authored trees still have a safe outdoor
  // workbench; never fall back to a roof-side entrance offset.
  const markedWork = authored("lopukh-work");
  if (markedWork) for (const stop of markedWork) {
    const trees = (scene.treeInteractions ?? []).flatMap(tree => tree.points)
      .filter(finite).sort((a, b) => distance(a, stop.position) - distance(b, stop.position));
    if (trees[0]) stop.lookAt = { ...trees[0] };
  }
  const work = (markedWork ?? (treeStops.length ? treeStops.slice(0, 6)
    : front("workbench", [1.05, 1.35, 1.65], [1.75, -1.75, .35, -.35, 0, 2.15, -2.15])))
    .filter(stop => !scene.destinations?.some(marker => belongsTo(marker.id, "lopukh-delivery")
      && finite(marker.position) && distance(marker.position, stop.position) < size * .6));
  return work.length ? { work, delivery, rest } : null;
}
