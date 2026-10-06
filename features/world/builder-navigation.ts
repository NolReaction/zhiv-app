import type { PixelDirection } from "@/features/mochlik/pixel-sprite";
import { BUILDER } from "./builder-types";
import { constructionMapPlace } from "./construction-map-anchor";
import type { SceneConstructionJob } from "./economy-construction-state";
import { createWorldNavigation, findWorldPath, isWalkable, type WorldNavigation } from "./navigation";
import { prepareSteeringPath, type SteeringPath } from "./steering";
import type { FixedWorldScene, WorldPoint } from "./tiled/types";

export type BuilderStop = { id: string; position: WorldPoint; lookAt: WorldPoint };
export const BUILDER_NAVIGATION_LIMITS = { radius: BUILDER.size * .1, workCandidates: 16, searches: 3, wanderStops: 8 } as const;
export type BuilderPlaces = { navigation: WorldNavigation; rest: BuilderStop; wander: readonly BuilderStop[] };
const cache = new WeakMap<FixedWorldScene, BuilderPlaces | null>();
const workCache = new WeakMap<FixedWorldScene, Map<string, readonly BuilderStop[]>>();
const distance = (a: WorldPoint, b: WorldPoint) => Math.hypot(a.x - b.x, a.y - b.y);
const finite = (p: WorldPoint | undefined): p is WorldPoint => !!p && Number.isFinite(p.x) && Number.isFinite(p.y);
export const builderDirection = (dx: number, dy: number): PixelDirection => Math.abs(dx) > Math.abs(dy)
  ? dx > 0 ? "right" : "left" : dy > 0 ? "front" : "back";

function nearby(entry: WorldPoint, anchor: WorldPoint): WorldPoint[] {
  const length = distance(entry, anchor), dx = length > .1 ? (entry.x - anchor.x) / length : 0;
  const dy = length > .1 ? (entry.y - anchor.y) / length : 1;
  // Work beside the entrance instead of occupying the hero's exact doorway.
  return [[12, 12], [12, -12], [20, 0], [8, 0], [0, 0], [24, 12], [24, -12], [32, 0]]
    .map(([forward, side]) => ({ x: entry.x + dx * forward - dy * side, y: entry.y + dy * forward + dx * side }));
}

/** Optional personal rest marker can be authored later. The fallback is a safe
 * clearing position, never an invented house or the hero's occupied spawn. */
export function builderLocalPlaces(scene: FixedWorldScene): BuilderPlaces | null {
  if (cache.has(scene)) return cache.get(scene)!;
  const nav = createWorldNavigation(scene, BUILDER_NAVIGATION_LIMITS.radius), spawn = scene.actor?.spawn;
  if (!nav || !finite(spawn)) { cache.set(scene, null); return null; }
  const marker = scene.destinations?.find(destination => destination.id === "builder-rest");
  const gap = (BUILDER.size + (scene.actor?.size ?? BUILDER.size)) * .5;
  const candidates = [marker?.position,
    ...[[1, .5], [-1, .5], [1, 0], [-1, 0], [0, 1.2], [1, 1.2], [-1, 1.2]]
      .map(([x, y]) => ({ x: spawn.x + x * (gap + 8), y: spawn.y + y * (gap + 8) })),
    ...(scene.navigation?.interests.map(interest => interest.position) ?? []),
  ];
  const point = candidates.find(point => finite(point) && distance(point, spawn) >= gap && isWalkable(nav, point));
  if (!point) { cache.set(scene, null); return null; }
  const rest: BuilderStop = { id: "builder-rest", position: { ...point }, lookAt: { x: point.x, y: point.y + 10 } };
  const wander: BuilderStop[] = [rest];
  for (const interest of scene.navigation?.interests ?? []) {
    if (distance(interest.position, spawn) >= gap && isWalkable(nav, interest.position))
      wander.push({ id: interest.id, position: { ...interest.position }, lookAt: { x: interest.position.x, y: interest.position.y + 10 } });
  }
  for (const site of scene.sites.filter(site => ["workshop", "quarry", "woodlot"].includes(site.id))) {
    const destination = scene.destinations?.find(destination => destination.id === site.id && destination.siteId === site.id);
    const position = [...nearby(site.entry, site.anchor), ...(destination ? nearby(destination.position, site.anchor) : [])]
      .find(point => isWalkable(nav, point));
    if (position) wander.push({ id: `builder-look-${site.id}`, position, lookAt: { ...site.anchor } });
  }
  const result = { navigation: nav, rest, wander: wander.slice(0, BUILDER_NAVIGATION_LIMITS.wanderStops) };
  cache.set(scene, result); return result;
}

/** Interior upgrades share their real host. Clearance checks also include the
 * target art's collision, so accepting a finished house cannot bury its worker. */
export function builderWorkStops(scene: FixedWorldScene, job: SceneConstructionJob): readonly BuilderStop[] {
  let jobs = workCache.get(scene);
  if (!jobs) { jobs = new Map(); workCache.set(scene, jobs); }
  const key = `${job.stationId}:${job.targetLevel}`, cached = jobs.get(key);
  if (cached) return cached;
  const places = builderLocalPlaces(scene), place = constructionMapPlace(job.stationId);
  const empty: BuilderStop[] = [];
  if (!places || !place) { jobs.set(key, empty); return empty; }
  let entry: WorldPoint | undefined, anchor: WorldPoint | undefined, future: WorldNavigation | null = places.navigation;
  const siteId = place === "house" ? "home" : place;
  const site = scene.sites.find(candidate => candidate.id === siteId);
  if (site) {
    entry = site.entry; anchor = site.anchor;
    // Warehouse and kiln levels do not select a different exterior house/art.
    const next = job.stationId === site.id && site.states.find(state => state.level === job.targetLevel)?.geometry;
    if (next) future = createWorldNavigation({ ...scene,
      sites: scene.sites.map(candidate => candidate.id === site.id ? { ...candidate, ...next } : candidate),
    }, BUILDER_NAVIGATION_LIMITS.radius);
  } else if (place === "garden") {
    const bush = scene.bushes?.find(bush => bush.id === "clearing-bush") ?? scene.bushes?.[0];
    entry = bush?.entry; anchor = bush?.hide;
  } else if (place === "campfire") {
    const fire = scene.campfires?.find(fire => fire.id === "clearing-campfire") ?? scene.campfires?.[0];
    entry = fire?.seat; anchor = fire?.position;
  }
  if (!finite(entry) || !finite(anchor) || !future) { jobs.set(key, empty); return empty; }
  const marker = scene.destinations?.find(destination => destination.id === `builder-work-${job.stationId}`);
  const destination = scene.destinations?.find(destination => destination.id === siteId && destination.siteId === siteId);
  const stops = [marker?.position, ...nearby(entry, anchor), ...(destination ? nearby(destination.position, anchor) : [])].filter(finite)
    .filter(point => isWalkable(places.navigation, point) && isWalkable(future, point))
    .slice(0, BUILDER_NAVIGATION_LIMITS.workCandidates)
    .map(position => ({ id: job.stationId, position: { ...position }, lookAt: { ...anchor } }));
  jobs.set(key, stops); return stops;
}

/** Bounded searches happen only on a decision/job/geometry change. */
export function builderRoute(places: BuilderPlaces, from: WorldPoint, candidates: readonly BuilderStop[]):
  { target: BuilderStop; path: SteeringPath } | null {
  for (const target of candidates.slice(0, BUILDER_NAVIGATION_LIMITS.searches)) {
    const points = findWorldPath(places.navigation, from, target.position);
    if (!points) continue;
    const path = prepareSteeringPath(places.navigation, points, BUILDER.size);
    if (path) return { target, path };
  }
  return null;
}
