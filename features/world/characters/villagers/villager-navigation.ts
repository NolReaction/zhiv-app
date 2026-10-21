import { canTraverse, createWorldNavigation, findWorldPath, isWalkable, type WorldNavigation } from "@/features/world/navigation/navigation";
import { prepareSteeringPath, type SteeringPath } from "@/features/world/navigation/steering";
import { residentClearance } from "@/features/world/navigation/resident-traffic";
import type { FixedWorldScene, WorldPoint } from "@/features/world/tiled/types";
import type { ForestVillagerId } from "@/features/world/characters/forest-villager-types";
import { forestVillagerDoor } from "./villager-doorway-navigation";
import { woodcutterPlaces, type WoodcutterPlaces } from "./woodcutter-navigation";

export const FOREST_VILLAGER_PROFILES = {
  lopukh: { size: 44, speed: 39, home: "lopukh-home", work: "woodlot", diligence: .72, sociability: .92, fatigue: .4 },
  kamneshmyg: { size: 42, speed: 33, home: "quarry", work: "quarry", diligence: .96, sociability: .45, fatigue: .55 },
  leaftail: { size: 44, speed: 32, home: "leaftail-caravan", work: "leaftail-caravan", diligence: .8, sociability: .78, fatigue: .32 },
} as const;
export type VillagerStop = { id: string; position: WorldPoint; lookAt: WorldPoint };
export type VillagerDoor = { id: string; kind: "threshold" | "concealment"; approach: VillagerStop;
  points: readonly WorldPoint[]; distances: readonly number[]; length: number; fadeAt: number; navigation: WorldNavigation };
export type VillagerPlaces = { navigation: WorldNavigation; home: VillagerStop; work: VillagerStop[]; wander: VillagerStop[];
  door: VillagerDoor | null; woodcutting: WoodcutterPlaces | null };
export const villagerDistance = (a: WorldPoint, b: WorldPoint) => Math.hypot(a.x - b.x, a.y - b.y);
const finite = (p: WorldPoint | undefined): p is WorldPoint => !!p && Number.isFinite(p.x) && Number.isFinite(p.y);
const cache = new WeakMap<FixedWorldScene, Map<ForestVillagerId, VillagerPlaces | null>>();

function siteStops(scene: FixedWorldScene, navigation: WorldNavigation, id: string, size: number): VillagerStop[] {
  const site = scene.sites.find(site => site.id === id);
  if (!site || !finite(site.entry) || !finite(site.anchor)) return [];
  const gap = residentClearance(size, scene.actor?.size ?? 50) + 5;
  const length = villagerDistance(site.entry, site.anchor), dx = length ? (site.entry.x - site.anchor.x) / length : 0;
  const dy = length ? (site.entry.y - site.anchor.y) / length : 1;
  // Stand beside the entrance, leaving its exact visitor/door corridor free.
  const candidates = [1, 1.4, 1.8].flatMap(width => [0, .5, 1].flatMap(forward => [-1, 1].map(side => ({
    x: site.entry.x + dx * gap * forward - dy * gap * width * side,
    y: site.entry.y + dy * gap * forward + dx * gap * width * side,
  }))));
  return candidates.filter(point => isWalkable(navigation, point)).slice(0, 8)
    .map((position, index) => ({ id: `${id}:${index}`, position, lookAt: { ...site.anchor } }));
}

/** Only authored ground and actual site exteriors; missing geometry hides the resident. */
export function forestVillagerPlaces(scene: FixedWorldScene, id: ForestVillagerId): VillagerPlaces | null {
  let residents = cache.get(scene);
  if (!residents) { residents = new Map(); cache.set(scene, residents); }
  if (residents.has(id)) return residents.get(id)!;
  const profile = FOREST_VILLAGER_PROFILES[id];
  // Compatibility maps without this resident's home need no radius-specific
  // grid. Check that cheap prerequisite before preparing world geometry.
  if (!scene.sites.some(site => site.id === profile.home)) { residents.set(id, null); return null; }
  const navigation = createWorldNavigation(scene, profile.size * .1);
  if (!navigation) { residents.set(id, null); return null; }
  // Marker-only compatibility scenes have no visible wall/roof to clear.
  const woodcutting = id === "lopukh" ? woodcutterPlaces(scene, navigation, profile.size) : null;
  if (id === "lopukh" && !woodcutting && scene.sites.find(site => site.id === profile.home)!.collision.length >= 3) { residents.set(id, null); return null; }
  const homes = woodcutting?.rest ?? siteStops(scene, navigation, profile.home, profile.size);
  if (!homes.length) { residents.set(id, null); return null; }
  const home = homes[0];
  const work = woodcutting?.work ?? siteStops(scene, navigation, profile.work, profile.size);
  // Older maps removed the woodlot art. Its existing economic worker uses the
  // rabbit's own outdoor workbench instead of inventing a tree/walking polygon.
  if (!work.length && id === "lopukh") work.push(...homes.slice(1));
  // The quarry is far from the clearing's authored leisure points. Give its
  // resident a few bounded exterior walks on real ground instead of repeatedly
  // rejecting a 600+ unit journey and inspecting the same doorstep forever.
  const vicinity = id === "kamneshmyg" ? [0, 1, -1, 2, -2, 3, -3, 4].map(index => {
    const angle = index * Math.PI / 4, reach = profile.size * 1.45;
    return { id: `${id}:neighbourhood:${index}`, position: { x: home.position.x + Math.cos(angle) * reach,
      y: home.position.y + Math.sin(angle) * reach }, lookAt: { ...home.lookAt } };
  }).filter(stop => isWalkable(navigation, stop.position)) : [];
  const wander = [...homes.slice(1, 4), ...vicinity, ...(scene.navigation?.interests ?? [])
    .filter(point => finite(point.position) && isWalkable(navigation, point.position))
    .map(point => ({ id: point.id, position: { ...point.position }, lookAt: { x: point.position.x, y: point.position.y + 10 } }))];
  const result = { navigation, home, work: work.length ? work : [home], wander, woodcutting,
    door: forestVillagerDoor(scene, id, navigation, homes) };
  residents.set(id, result); return result;
}

export function forestVillagerRoute(places: VillagerPlaces, from: WorldPoint, candidates: readonly VillagerStop[], size: number, maxLength = Infinity):
  { target: VillagerStop; route: SteeringPath } | null {
  for (const target of candidates.slice(0, 4)) {
    const points = findWorldPath(places.navigation, from, target.position);
    const route = points && prepareSteeringPath(places.navigation, points, size);
    if (route && route.length <= maxLength) return { target, route };
  }
  return null;
}

type ArrivalPath = { start: WorldPoint; target: VillagerStop; route: SteeringPath };
const arrivals = new WeakMap<VillagerPlaces, ArrivalPath | null>();
const easternArrivals = new WeakMap<VillagerPlaces, ArrivalPath | null>();

/** Flood the actual quarry-connected grid once. Selecting the northmost cell
 * after reachability excludes disconnected islands above the river. Every edge
 * is a swept-disk check, including diagonals beside building corners. */
export function forestVillagerNorthernArrival(places: VillagerPlaces): ArrivalPath | null {
  return edgeArrival(places, "kamneshmyg", "north", arrivals);
}

/** Start at the rightmost reachable shore/ground, never across a disconnected island. */
export function forestVillagerEasternArrival(places: VillagerPlaces): ArrivalPath | null {
  return edgeArrival(places, "lopukh", "east", easternArrivals);
}

function edgeArrival(places: VillagerPlaces, resident: "lopukh" | "kamneshmyg", edge: "north" | "east",
  cache: WeakMap<VillagerPlaces, ArrivalPath | null>): ArrivalPath | null {
  if (cache.has(places)) return cache.get(places)!;
  const navigation = places.navigation, { grid, cellSize } = navigation;
  const point = (id: number) => ({ x: grid.origin.x + id % grid.columns * cellSize,
    y: grid.origin.y + Math.floor(id / grid.columns) * cellSize });
  const targets = (resident === "lopukh" ? [places.home] : places.work).slice(0, 4);
  let target: VillagerStop | undefined, seed = -1;
  for (const candidate of targets) {
    const column = Math.round((candidate.position.x - grid.origin.x) / cellSize);
    const row = Math.round((candidate.position.y - grid.origin.y) / cellSize);
    for (const offset of [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, 1], [1, -1], [-1, -1]]) {
      const x = column + offset[0], y = row + offset[1], id = y * grid.columns + x;
      if (x >= 0 && x < grid.columns && y >= 0 && y < grid.rows && grid.walkable[id]
        && canTraverse(navigation, candidate.position, point(id))) { target = candidate; seed = id; break; }
    }
    if (target) break;
  }
  if (!target || seed < 0) { cache.set(places, null); return null; }
  const parents = new Int32Array(grid.walkable.length).fill(-1), queue = new Int32Array(grid.walkable.length);
  parents[seed] = seed; queue[0] = seed;
  let count = 1, best = seed;
  for (let at = 0; at < count; at++) {
    const id = queue[at], current = point(id), column = id % grid.columns, row = Math.floor(id / grid.columns);
    const selected = point(best);
    if (edge === "north" ? current.y < selected.y || current.y === selected.y && Math.abs(current.x - target.position.x) < Math.abs(selected.x - target.position.x)
      : current.x > selected.x || current.x === selected.x && current.y < selected.y) best = id;
    for (const [dx, dy] of [[0, -1], [-1, 0], [1, 0], [0, 1], [-1, -1], [1, -1], [-1, 1], [1, 1]]) {
      const x = column + dx, y = row + dy, next = y * grid.columns + x;
      if (x < 0 || x >= grid.columns || y < 0 || y >= grid.rows || !grid.walkable[next] || parents[next] >= 0) continue;
      if (!canTraverse(navigation, current, point(next))) continue;
      parents[next] = id; queue[count++] = next;
    }
  }
  const points: WorldPoint[] = [];
  for (let id = best; ; id = parents[id]) { points.push(point(id)); if (id === seed) break; }
  points.push({ ...target.position });
  // Keep the proven polyline; collapse collinear grid edges without the search
  // visit limit that can reject a long but already proven connected path.
  const compact = points.filter((value, index) => {
    if (!index || index === points.length - 1) return true;
    const a = points[index - 1], b = points[index + 1];
    return Math.abs((value.x - a.x) * (b.y - value.y) - (value.y - a.y) * (b.x - value.x)) > 1e-7;
  });
  const route = prepareSteeringPath(navigation, compact, FOREST_VILLAGER_PROFILES[resident].size);
  const result = route && route.length > 1 ? { start: { ...points[0] }, target, route } : null;
  cache.set(places, result); return result;
}
