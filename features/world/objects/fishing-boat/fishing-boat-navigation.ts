import type { FixedWorldScene, WorldPoint } from "@/features/world/tiled/types";
import { canTraverse, createWorldNavigation, findWorldPath, isWalkable, type WorldNavigation } from "@/features/world/navigation/navigation";
import { isForestWater } from "@/features/world/environment/water/forest-water";
import { prepareSteeringPath, type SteeringPath } from "@/features/world/navigation/steering";

/** Separate eastern mooring, clear of the trader landing and southern ship berth. */
export const FISHING_BOAT_MOORING = { land: { x: 1032, y: 918 }, dock: { x: 1064, y: 966 }, exit: { x: 1230, y: 950 }, width: 44, radius: 18 } as const;
export type FishingBoatRoute = { land: WorldPoint; dock: WorldPoint; water: WorldNavigation; gangway: SteeringPath; sail: SteeringPath };
const cache = new WeakMap<FixedWorldScene, FishingBoatRoute | null>();
function corridor(a: WorldPoint, b: WorldPoint, half: number) {
  const length = Math.hypot(b.x - a.x, b.y - a.y), x = (b.x - a.x) / length, y = (b.y - a.y) / length;
  return [{ x: a.x - x * half - y * half, y: a.y - y * half + x * half },
    { x: b.x + x * half - y * half, y: b.y + y * half + x * half },
    { x: b.x + x * half + y * half, y: b.y + y * half - x * half },
    { x: a.x - x * half + y * half, y: a.y - y * half - x * half }];
}
export function fishingBoatRoute(scene: FixedWorldScene): FishingBoatRoute | null {
  if (cache.has(scene)) return cache.get(scene)!;
  const remember = (value: FishingBoatRoute | null) => { cache.set(scene, value); return value; };
  if (!scene.water?.surfaces.length || !scene.actor) return remember(null);
  const scale = Math.min(scene.width, scene.height) / 1254;
  const point = (p: WorldPoint) => ({ x: p.x * scale, y: p.y * scale });
  const land = point(FISHING_BOAT_MOORING.land), dock = point(FISHING_BOAT_MOORING.dock), exit = point(FISHING_BOAT_MOORING.exit);
  const ground = createWorldNavigation(scene);
  if (!ground || !isWalkable(ground, land) || !findWorldPath(ground, scene.actor.spawn, land)) return remember(null);
  const water = createWorldNavigation({ ...scene, sites: [], campfires: [], lights: [], water: undefined,
    navigation: { version: 1, cellSize: 8 * scale, areas: scene.water.surfaces, obstacles: scene.water.exclusions, interests: [] } }, FISHING_BOAT_MOORING.radius * scale);
  if (!water || !isWalkable(water, dock)) return remember(null);
  let crossed = false;
  for (let i = 0; i <= 48; i++) {
    const p = { x: land.x + (dock.x - land.x) * i / 48, y: land.y + (dock.y - land.y) * i / 48 };
    if (isForestWater(scene, p)) crossed = true; else if (crossed) return remember(null);
  }
  const shore = createWorldNavigation({ ...scene, water: undefined, lights: [],
    navigation: { version: 1, cellSize: 4 * scale, areas: [{ id: "fishing-boat-gangway", points: corridor(land, dock, 7 * scale) }],
      obstacles: [...(scene.navigation?.obstacles ?? []), ...scene.water.exclusions], interests: [] } }, scene.actor.size * .1);
  const gangway = shore && prepareSteeringPath(shore, [land, dock], scene.actor.size);
  const points = findWorldPath(water, dock, exit), sail = points && prepareSteeringPath(water, points, scene.actor.size);
  return remember(gangway && sail && canTraverse(ground, land, land) ? { land, dock, water, gangway, sail } : null);
}
/** A bounded analytic projection; all segments came from checked navigation. */
export function fishingBoatPathPoint(path: SteeringPath, fraction: number) {
  const distance = Math.max(0, Math.min(1, fraction)) * path.length;
  let index = 1; while (index < path.distances.length - 1 && path.distances[index] < distance) index++;
  const a = path.points[index - 1], b = path.points[index] ?? a;
  const span = (path.distances[index] ?? 0) - path.distances[index - 1], t = span > 0 ? (distance - path.distances[index - 1]) / span : 0;
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, heading: Math.atan2(b.y - a.y, b.x - a.x) };
}
