import type { PixelDirection } from "@/features/mochlik/pixel-sprite";
import { BUILDER } from "./builder-types";
import { constructionMapPlace } from "@/features/world/scene/construction-map-anchor";
import type { SceneConstructionJob } from "@/features/world/state/economy/economy-construction-state";
import { canTraverse, createWorldNavigation, findWorldPath, isWalkable, type WorldNavigation } from "@/features/world/navigation/navigation";
import { prepareSteeringPath, type SteeringPath } from "@/features/world/navigation/steering";
import { residentClearance } from "@/features/world/navigation/resident-traffic";
import { campfireFootprint } from "@/features/world/activities/campfire/forest-campfire";
import type { FixedWorldScene, WorldPoint } from "@/features/world/tiled/types";

export type BuilderStop = { id: string; position: WorldPoint; lookAt: WorldPoint };
/** Only this short validated corridor may cross the builder's own collider. */
export type BuilderHome = { id: "builder-home"; entry: WorldPoint; doorway: WorldPoint; approach: BuilderStop };
export type BuilderWorkMarkerIssue = "invalid-position" | "missing-navigation" | "missing-host" | "far-from-building"
  | "doorway" | "bush-access" | "activity" | "blocked-ground" | "blocked-future";
export type BuilderWorkMarkerConflict = { issue: "far-from-building" | "doorway" | "bush-access" | "activity";
  targetId: string; position: WorldPoint; distance: number; limit: number };
export type BuilderWorkMarkerCheck = { id: string; position: WorldPoint; issues: readonly BuilderWorkMarkerIssue[];
  conflicts?: readonly BuilderWorkMarkerConflict[] };
type WorkGeometry = { id: string; points: WorldPoint[] };
type BuilderWorkPlan = { stops: readonly BuilderStop[]; markers: readonly BuilderWorkMarkerCheck[] };
export const BUILDER_NAVIGATION_LIMITS = { radius: BUILDER.size * .1, workReach: BUILDER.size * .8,
  contourEdges: 24, workCandidates: 16, searches: 3, wanderStops: 8, doorwayLength: 52 } as const;
export type BuilderPlaces = { navigation: WorldNavigation; rest: BuilderStop; wander: readonly BuilderStop[]; home: BuilderHome | null };
const cache = new WeakMap<FixedWorldScene, BuilderPlaces | null>();
const workCache = new WeakMap<FixedWorldScene, Map<string, BuilderWorkPlan>>();
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

/** A permanent work stop leaves the same body clearance as a passing resident;
 * reserving half of both sprite widths pushes the worker away from the facade. */
export function builderWorkClearance(scene: FixedWorldScene): number {
  const size = scene.actor?.size;
  return residentClearance(BUILDER.size, Number.isFinite(size) && size! > 0 ? size! : BUILDER.size);
}

function beside(entry: WorldPoint, anchor: WorldPoint, gap: number): WorldPoint[] {
  const length = distance(entry, anchor), dx = length > .1 ? (entry.x - anchor.x) / length : 0;
  const dy = length > .1 ? (entry.y - anchor.y) / length : 1;
  // Keep the nearest side positions first; widen only when the building or its
  // approach corridor occupies them. No fallback stands on the entrance axis.
  return [1, 1.35, 1.7].flatMap(width => [0, .3, .6, 1].flatMap(forward => [-1, 1].map(side => ({
    x: entry.x + dx * gap * forward - dy * gap * width * side,
    y: entry.y + dy * gap * forward + dx * gap * width * side,
  }))));
}

function closestToAccess(point: WorldPoint, access: readonly WorldPoint[]): { position: WorldPoint; distance: number } {
  let position = { ...access[0] }, closest = distance(point, position);
  for (let index = 1; index < access.length; index++) {
    const a = access[index - 1], b = access[index], dx = b.x - a.x, dy = b.y - a.y;
    const t = Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / (dx * dx + dy * dy || 1)));
    const next = { x: a.x + dx * t, y: a.y + dy * t }, nextDistance = distance(point, next);
    if (nextDistance < closest) { position = next; closest = nextDistance; }
  }
  return { position, distance: closest };
}

function distanceToAccess(point: WorldPoint, access: readonly WorldPoint[]): number {
  return closestToAccess(point, access).distance;
}

function distanceToContour(point: WorldPoint, contour: readonly WorldPoint[]): number {
  return contour.length ? distanceToAccess(point, [...contour, contour[0]]) : Infinity;
}

function exterior(collision: WorldPoint[], hitArea: WorldPoint[], entry: WorldPoint, anchor: WorldPoint): WorldPoint[] {
  return collision.length >= 3 ? collision : hitArea.length >= 3 ? hitArea : [entry, anchor];
}

function outsideBushArtwork(scene: FixedWorldScene, point: WorldPoint): boolean {
  return (scene.bushes ?? []).every(bush => {
    const bounds = scene.terrain.find(terrain => terrain.id === bush.imageId)?.bounds;
    return !bounds || point.x + BUILDER.size / 2 <= bounds.x || point.x - BUILDER.size / 2 >= bounds.x + bounds.width
      || point.y <= bounds.y || point.y - BUILDER.size * 45 / 48 >= bounds.y + bounds.height;
  });
}

/** Try actual exterior edges as well as entrance offsets. A narrow doorway's
 * visitor point is not a suitable substitute for a reachable wall-side stop. */
function besideContour(contour: readonly WorldPoint[], entry: WorldPoint): WorldPoint[] {
  const edges = contour.map((a, index) => ({ a, b: contour[(index + 1) % contour.length] }))
    .filter(({ a, b }) => finite(a) && finite(b) && distance(a, b) > .1)
    .sort((a, b) => distanceToAccess(entry, [a.a, a.b]) - distanceToAccess(entry, [b.a, b.b]))
    .slice(0, BUILDER_NAVIGATION_LIMITS.contourEdges);
  return edges.flatMap(({ a, b }) => {
    const dx = b.x - a.x, dy = b.y - a.y, length = Math.hypot(dx, dy);
    const t = Math.max(0, Math.min(1, ((entry.x - a.x) * dx + (entry.y - a.y) * dy) / (length * length)));
    return [t, 0, .25, .5, .75, 1].flatMap(at => [8, 16, 24].flatMap(offset => [-1, 1].map(side => ({
      x: a.x + dx * at - dy / length * offset * side,
      y: a.y + dy * at + dx / length * offset * side,
    }))));
  });
}

function inside(point: WorldPoint, polygon: readonly WorldPoint[]): boolean {
  let result = false;
  for (let index = 0, previous = polygon.length - 1; index < polygon.length; previous = index++) {
    const a = polygon[index], b = polygon[previous];
    if ((a.y > point.y) !== (b.y > point.y)
      && point.x < (b.x - a.x) * (point.y - a.y) / (b.y - a.y) + a.x) result = !result;
  }
  return result;
}

function personalHome(scene: FixedWorldScene, navigation: WorldNavigation): BuilderHome | null {
  const home = scene.sites.find(site => site.id === "builder-home");
  if (!home || !finite(home.entry) || !finite(home.doorway) || home.collision.length < 3
    || !home.collision.every(finite) || !isWalkable(navigation, home.entry)
    || !inside(home.doorway, home.collision) || distance(home.entry, home.doorway) < 1
    || distance(home.entry, home.doorway) > BUILDER_NAVIGATION_LIMITS.doorwayLength) return null;
  // Removing this collider applies only to validation of this exact segment;
  // ordinary paths and every other resident still see the complete house.
  const corridor = createWorldNavigation({ ...scene, sites: scene.sites.filter(site => site !== home) }, navigation.radius);
  if (!corridor || !canTraverse(corridor, home.entry, home.doorway)) return null;
  return { id: "builder-home", entry: { ...home.entry }, doorway: { ...home.doorway },
    approach: { id: "builder-home", position: { ...home.entry }, lookAt: { ...home.doorway } } };
}

/** The personal outdoor marker and validated house are optional for old scenes.
 * Their fallback is a safe clearing position outside the hero's occupied spawn. */
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
  const result = { navigation: nav, rest, wander: wander.slice(0, BUILDER_NAVIGATION_LIMITS.wanderStops), home: personalHome(scene, nav) };
  cache.set(scene, result); return result;
}

/** Interior upgrades share their real host. Clearance checks also include the
 * target art's collision, so accepting a finished house cannot bury its worker. */
function builderWorkPlan(scene: FixedWorldScene, job: SceneConstructionJob): BuilderWorkPlan {
  let jobs = workCache.get(scene);
  if (!jobs) { jobs = new Map(); workCache.set(scene, jobs); }
  const key = `${job.stationId}:${job.targetLevel}`, cached = jobs.get(key);
  if (cached) return cached;
  const places = builderLocalPlaces(scene), place = constructionMapPlace(job.stationId);
  const siteId = place === "house" ? "home" : place;
  const markers = [job.stationId, siteId].filter((id, index, ids) => !!id && ids.indexOf(id) === index)
    .flatMap(id => {
      const marker = scene.destinations?.find(destination => destination.id === `builder-work-${id}`);
      return marker ? [marker] : [];
    });
  const unavailable = (issue: BuilderWorkMarkerIssue): BuilderWorkPlan => {
    const result = { stops: [], markers: markers.map(marker => ({ id: marker.id, position: { ...marker.position }, issues: [issue] })) };
    jobs.set(key, result); return result;
  };
  if (!places) return unavailable("missing-navigation");
  if (!place) return unavailable("missing-host");
  let entry: WorldPoint | undefined, anchor: WorldPoint | undefined, future: WorldNavigation | null = places.navigation;
  const access: WorkGeometry[] = [];
  const contours: WorkGeometry[] = [];
  const site = scene.sites.find(candidate => candidate.id === siteId);
  if (site) {
    entry = site.entry; anchor = site.anchor;
    contours.push({ id: `${site.id}:current`, points: exterior(site.collision, site.hitArea, site.entry, site.anchor) });
    access.push({ id: `${site.id}:entry`, points: [site.entry, site.doorway ?? site.entry] });
    const destination = scene.destinations?.find(destination => destination.id === siteId && destination.siteId === siteId);
    if (destination) access.push({ id: `${site.id}:visitor`, points: [destination.position, site.entry] });
    if (siteId === "home") {
      if (finite(scene.actor?.spawn)) access.push({ id: `${site.id}:spawn`, points: [scene.actor.spawn, site.entry] });
      for (const path of scene.paths.filter(path => path.siteId === siteId && path.behavior === "home"))
        if (path.points.length) access.push({ id: path.id, points: [...path.points, site.entry] });
    }
    // Warehouse and kiln levels do not select a different exterior house/art.
    const next = job.stationId === site.id && site.states.find(state => state.level === job.targetLevel)?.geometry;
    if (next) {
      const nextId = `${site.id}:future:${job.targetLevel}`;
      contours.push({ id: nextId, points: exterior(next.collision, next.hitArea, next.entry, next.anchor) });
      access.push({ id: `${nextId}:entry`, points: [next.entry, next.doorway ?? next.entry] },
        { id: `${nextId}:approach`, points: [site.entry, next.entry] });
      if (destination) access.push({ id: `${nextId}:visitor`, points: [destination.position, next.entry] });
      if (siteId === "home" && finite(scene.actor?.spawn)) access.push({ id: `${nextId}:spawn`, points: [scene.actor.spawn, next.entry] });
      future = createWorldNavigation({ ...scene,
        sites: scene.sites.map(candidate => candidate.id === site.id ? { ...candidate, ...next } : candidate),
      }, BUILDER_NAVIGATION_LIMITS.radius);
    }
  } else if (place === "garden") {
    const bush = scene.bushes?.find(bush => bush.id === "clearing-bush") ?? scene.bushes?.[0];
    entry = bush?.entry; anchor = bush?.hide;
    if (bush) {
      contours.push({ id: bush.id, points: bush.points });
      // This is an actual jump path, unlike looking from a seat at a fire.
      access.push({ id: `${bush.id}:jump`, points: [bush.entry, bush.hide] });
    }
  } else if (place === "campfire") {
    const fire = scene.campfires?.find(fire => fire.id === "clearing-campfire") ?? scene.campfires?.[0];
    entry = fire?.seat; anchor = fire?.position;
    if (fire) contours.push({ id: fire.id, points: campfireFootprint(fire) });
  }
  if (!finite(entry) || !finite(anchor)) return unavailable("missing-host");
  if (!future) return unavailable("missing-navigation");
  // A campfire visit stops at its seat. The resident never walks from there
  // into the flame, so that imaginary corridor must not exclude work stops.
  // A work shift must not reserve another activity's fixed goal for its whole
  // duration (for example the campfire seat beside the house). Roaming interests
  // remain available; only destinations where another resident must stand count.
  const occupied = [
    ...(finite(scene.actor?.spawn) ? [{ id: "mochlik-spawn", position: scene.actor.spawn }] : []),
    ...scene.sites.map(site => ({ id: `${site.id}:entry`, position: site.entry })),
    ...(scene.campfires?.map(fire => ({ id: `${fire.id}:seat`, position: fire.seat })) ?? []),
    ...(scene.bushes?.flatMap(bush => [{ id: `${bush.id}:entry`, position: bush.entry }, { id: `${bush.id}:hide`, position: bush.hide }]) ?? []),
    ...(scene.destinations?.filter(destination => !destination.id.startsWith("builder-")).map(destination => ({ id: destination.id, position: destination.position })) ?? []),
  ].filter(goal => finite(goal.position));
  const clearance = builderWorkClearance(scene), gap = clearance + BUILDER_NAVIGATION_LIMITS.radius;
  const destination = scene.destinations?.find(destination => destination.id === siteId && destination.siteId === siteId);
  const candidates = [...beside(entry, anchor, gap), ...contours.flatMap(contour => besideContour(contour.points, entry)),
    ...(destination ? beside(destination.position, anchor, gap) : [])]
    .sort((a, b) => distance(a, entry) - distance(b, entry));
  // Lazy checks keep automatic searches bounded: expensive ground tests only
  // run after the facade, doorway and activity checks accept the candidate.
  const validations: readonly [BuilderWorkMarkerIssue, (point: WorldPoint) => boolean][] = [
    ["far-from-building", point => contours.every(contour => distanceToContour(point, contour.points) <= BUILDER_NAVIGATION_LIMITS.workReach)],
    [place === "garden" && !site ? "bush-access" : "doorway", point => access.every(corridor => distanceToAccess(point, corridor.points) >= clearance - 1e-7)],
    ["activity", point => occupied.every(goal => distance(point, goal.position) >= clearance - 1e-7)],
    ["blocked-ground", point => isWalkable(places.navigation, point)],
    ["blocked-future", point => isWalkable(future, point)],
  ];
  const issuesAt = (point: WorldPoint, all = true): BuilderWorkMarkerIssue[] => {
    if (!finite(point)) return ["invalid-position"];
    const issues: BuilderWorkMarkerIssue[] = [];
    // These are physical constraints shared by authored markers and fallbacks.
    for (const [issue, valid] of validations) if (!valid(point)) {
      issues.push(issue);
      if (!all) break;
    }
    return issues;
  };
  const conflictAt = (point: WorldPoint, issue: BuilderWorkMarkerIssue): BuilderWorkMarkerConflict | undefined => {
    if (!finite(point)) return;
    if (issue === "activity") {
      const nearest = occupied.map(goal => ({ ...goal, distance: distance(point, goal.position) }))
        .sort((a, b) => a.distance - b.distance)[0];
      return nearest && { issue, targetId: nearest.id, position: { ...nearest.position }, distance: nearest.distance, limit: clearance };
    }
    if (issue === "doorway" || issue === "bush-access" || issue === "far-from-building") {
      const candidates = (issue === "far-from-building" ? contours : access).map(geometry => ({ id: geometry.id,
        ...closestToAccess(point, issue === "far-from-building" ? [...geometry.points, geometry.points[0]] : geometry.points) }));
      candidates.sort((a, b) => issue === "far-from-building" ? b.distance - a.distance : a.distance - b.distance);
      const conflict = candidates[0];
      return conflict && { issue, targetId: conflict.id, position: conflict.position, distance: conflict.distance,
        limit: issue === "far-from-building" ? BUILDER_NAVIGATION_LIMITS.workReach : clearance };
    }
  };
  const checks = markers.map(marker => {
    const issues = issuesAt(marker.position), conflicts = issues.flatMap(issue => {
      const conflict = conflictAt(marker.position, issue); return conflict ? [conflict] : [];
    });
    return { id: marker.id, position: { ...marker.position }, issues, ...(conflicts.length ? { conflicts } : {}) };
  });
  // PNG bounds include transparent padding. Only automatic placement uses that
  // conservative visual preference; a manually authored stop owns its framing.
  const stops = [...checks.filter(check => !check.issues.length).map(check => check.position),
    ...candidates.filter(point => (place === "garden" || outsideBushArtwork(scene, point)) && !issuesAt(point, false).length)]
    .slice(0, BUILDER_NAVIGATION_LIMITS.workCandidates)
    .map(position => ({ id: job.stationId, position: { ...position }, lookAt: { ...anchor } }));
  const result = { stops, markers: checks };
  jobs.set(key, result); return result;
}

export function builderWorkStops(scene: FixedWorldScene, job: SceneConstructionJob): readonly BuilderStop[] {
  return builderWorkPlan(scene, job).stops;
}

/** DEV reads the same validation as runtime; no work order or resident is advanced. */
export function builderWorkMarkerChecks(scene: FixedWorldScene, job: SceneConstructionJob): readonly BuilderWorkMarkerCheck[] {
  return builderWorkPlan(scene, job).markers;
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
