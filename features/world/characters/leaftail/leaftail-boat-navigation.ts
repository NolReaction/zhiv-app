import { canTraverse, createWorldNavigation, findWorldPath, isWalkable, type WorldNavigation } from "@/features/world/navigation/navigation";
import { prepareSteeringPath, type SteeringPath } from "@/features/world/navigation/steering";
import type { FixedWorldScene, WorldPoint } from "@/features/world/tiled/types";
import { forestVillagerPlaces } from "@/features/world/characters/villagers/villager-navigation";
import { isForestWater } from "@/features/world/environment/water/forest-water";

export type LeaftailBoatRoute = { water: WorldNavigation; shore: WorldNavigation; ground: WorldNavigation;
  sail: SteeringPath; landing: SteeringPath; walk: SteeringPath; dock: WorldPoint; land: WorldPoint; target: WorldPoint };
export const LEAFTAIL_BOAT_GEOMETRY = { radius: 12, size: 44, gangplankWidth: 12, maximumLanding: 48 } as const;
const cache = new WeakMap<FixedWorldScene, LeaftailBoatRoute | null>();
const distance = (a: WorldPoint, b: WorldPoint) => Math.hypot(a.x - b.x, a.y - b.y);
function corridor(from: WorldPoint, to: WorldPoint, width: number) {
  const length = distance(from, to), dx = (to.x - from.x) / length, dy = (to.y - from.y) / length, pad = width / 2;
  return [{ x: from.x - dx * pad - dy * pad, y: from.y - dy * pad + dx * pad },
    { x: to.x + dx * pad - dy * pad, y: to.y + dy * pad + dx * pad },
    { x: to.x + dx * pad + dy * pad, y: to.y + dy * pad - dx * pad },
    { x: from.x - dx * pad + dy * pad, y: from.y - dy * pad - dx * pad }];
}
function shoreCrossesOnce(scene: FixedWorldScene, from: WorldPoint, to: WorldPoint) {
  let reachedLand = false;
  for (let i = 0; i <= 96; i++) {
    const point = { x: from.x + (to.x - from.x) * i / 96, y: from.y + (to.y - from.y) * i / 96 };
    const water = isForestWater(scene, point);
    if (!water) reachedLand = true;
    else if (reachedLand) return false;
  }
  return reachedLand && isForestWater(scene, from) && !isForestWater(scene, to);
}

/** Flood the exact water component, not the full square map. A radius-12 hull
 * must clear every authored WaterExclusion, including tiny leaves and rocks. */
function waterEntrance(scene: FixedWorldScene, navigation: WorldNavigation, dock: WorldPoint) {
  const { grid, cellSize } = navigation;
  const point = (id: number) => ({ x: grid.origin.x + id % grid.columns * cellSize,
    y: grid.origin.y + Math.floor(id / grid.columns) * cellSize });
  const candidates: number[] = [];
  for (let id = 0; id < grid.walkable.length; id++) if (grid.walkable[id] && distance(point(id), dock) <= cellSize * 2
    && canTraverse(navigation, dock, point(id))) candidates.push(id);
  candidates.sort((a, b) => distance(point(a), dock) - distance(point(b), dock));
  if (!candidates.length) return null;
  const seed = candidates[0], parents = new Int32Array(grid.walkable.length).fill(-1), queue = new Int32Array(grid.walkable.length);
  queue[0] = seed; parents[seed] = seed; let count = 1, best = seed, bestScore = Infinity;
  for (let at = 0; at < count; at++) {
    const id = queue[at], current = point(id), column = id % grid.columns, row = Math.floor(id / grid.columns);
    const score = Math.min(scene.width - LEAFTAIL_BOAT_GEOMETRY.radius - current.x,
      scene.height - LEAFTAIL_BOAT_GEOMETRY.radius - current.y);
    if (distance(current, dock) >= 180 && score >= 0 && score < bestScore) { best = id; bestScore = score; }
    for (const [dx, dy] of [[0, 1], [1, 0], [-1, 0], [0, -1], [1, 1], [-1, 1], [1, -1], [-1, -1]]) {
      const x = column + dx, y = row + dy, next = y * grid.columns + x;
      if (x < 0 || x >= grid.columns || y < 0 || y >= grid.rows || !grid.walkable[next] || parents[next] >= 0
        || !canTraverse(navigation, current, point(next))) continue;
      parents[next] = id; queue[count++] = next;
    }
  }
  if (!Number.isFinite(bestScore)) return null;
  const points: WorldPoint[] = [];
  for (let id = best; ; id = parents[id]) { points.push(point(id)); if (id === seed) break; }
  points.push({ ...dock });
  const compact = points.filter((p, i) => !i || i === points.length - 1
    || Math.abs((p.x - points[i - 1].x) * (points[i + 1].y - p.y)
      - (p.y - points[i - 1].y) * (points[i + 1].x - p.x)) > 1e-7);
  return prepareSteeringPath(navigation, compact, LEAFTAIL_BOAT_GEOMETRY.size);
}

/** Prototype mooring on the clear central bank. Only this visible temporary
 * gangplank supports the shoreline crossing; ordinary WorldNavigation is never
 * enlarged and no river, site collider or Tiled point is changed. Invalid edited
 * geometry fails closed so a trader cannot appear on rocks or skate over land. */
export function leaftailBoatRoute(scene: FixedWorldScene): LeaftailBoatRoute | null {
  if (cache.has(scene)) return cache.get(scene)!;
  const remember = (value: LeaftailBoatRoute | null) => { cache.set(scene, value); return value; };
  const places = forestVillagerPlaces(scene, "leaftail");
  if (!places || !scene.water?.surfaces.length) return remember(null);
  const scale = Math.min(scene.width, scene.height) / 1254;
  const dock = { x: 892 * scale, y: 948 * scale }, land = { x: 892 * scale, y: 908 * scale };
  if (distance(dock, land) > LEAFTAIL_BOAT_GEOMETRY.maximumLanding || !isWalkable(places.navigation, land)
    || !shoreCrossesOnce(scene, dock, land)) return remember(null);
  const water = createWorldNavigation({ ...scene, sites: [], campfires: [], water: undefined,
    navigation: { version: 1, cellSize: 8, areas: scene.water.surfaces, obstacles: scene.water.exclusions, interests: [] } }, LEAFTAIL_BOAT_GEOMETRY.radius);
  if (!water || !isWalkable(water, dock)) return remember(null);
  const shore = createWorldNavigation({ ...scene, water: undefined,
    navigation: { version: 1, cellSize: 4, areas: [{ id: "leaftail-arrival-gangplank", points: corridor(dock, land, LEAFTAIL_BOAT_GEOMETRY.gangplankWidth) }],
      obstacles: [...(scene.navigation?.obstacles ?? []), ...scene.water.exclusions], interests: [] } }, LEAFTAIL_BOAT_GEOMETRY.size * .1);
  const landing = shore && prepareSteeringPath(shore, [dock, land], LEAFTAIL_BOAT_GEOMETRY.size);
  const points = findWorldPath(places.navigation, land, places.home.position);
  const walk = points && prepareSteeringPath(places.navigation, points, LEAFTAIL_BOAT_GEOMETRY.size);
  const sail = waterEntrance(scene, water, dock);
  return remember(shore && landing && walk && sail ? { water, shore, ground: places.navigation, sail, landing, walk,
    dock, land, target: { ...places.home.position } } : null);
}
