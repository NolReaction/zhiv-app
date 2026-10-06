import type { PixelDirection } from "@/features/mochlik/pixel-sprite";
import { BUILDER, type BuilderAction, type BuilderResidentFrame } from "./builder-types";
import { builderDirection, builderLocalPlaces, builderRoute, builderWorkStops,
  type BuilderPlaces, type BuilderStop } from "./builder-navigation";
import { forestConstructionJob, type EconomySceneConstruction, type SceneConstructionJob } from "./economy-construction-state";
import { canTraverse, isWalkable } from "./navigation";
import { desiredSteeringSpeed, type SteeringPath } from "./steering";
import { canTraverseResidents, residentTrafficDetour, RESIDENT_TRAFFIC_LIMITS, type ResidentOccupant } from "./resident-traffic";
import type { FixedWorldScene, WorldPoint } from "./tiled/types";

export type BuilderEnvironment = { now: number; construction?: EconomySceneConstruction | null; occupants?: readonly ResidentOccupant[] };
export type BuilderMind = {
  scene: FixedWorldScene; available: boolean; position: WorldPoint; direction: PixelDirection;
  elapsed: number; age: number; action: BuilderAction; ready: boolean;
  job: SceneConstructionJob | null; jobKey: string; target: BuilderStop | null;
  route: SteeringPath | null; distance: number; speed: number; walked: number;
  wait: number; wanderIndex: number; decisions: number; blocked: boolean;
  noticePending: boolean; greetAfter: number;
  /** One cold entry only: wait for authoritative economics before choosing feet.
   * Kept across local hydration/camera handoffs, never written to server memory. */
  constructionPending: boolean;
  trafficWaiting: boolean;
};
export const BUILDER_MIND_LIMITS = { maxDelta: 1, workCycle: 2.2, workRoutine: 8.8, finish: 1.4,
  greeting: 2, acceleration: BUILDER.size * 1.6 } as const;
const length = (a: WorldPoint, b: WorldPoint) => Math.hypot(a.x - b.x, a.y - b.y);
const idleYieldAfter = new WeakMap<BuilderMind, number>();

/** A single session owns the feet and cosmetic clock. No setInterval, job
 * commands, currency, reward generation or offline catch-up lives here. */
export function createBuilderMind(scene: FixedWorldScene, options: { awaitConstruction?: boolean } = {}): BuilderMind | null {
  const places = builderLocalPlaces(scene); if (!places) return null;
  return { scene, available: true, position: { ...places.rest.position }, direction: "front", elapsed: 0, age: 0,
    action: "idle", ready: false, job: null, jobKey: "", target: places.rest,
    route: null, distance: 0, speed: 0, walked: 0, wait: 8, wanderIndex: 0, decisions: 0, blocked: false,
    noticePending: false, greetAfter: 0, constructionPending: options.awaitConstruction === true, trafficWaiting: false };
}

function action(mind: BuilderMind, value: BuilderAction) {
  if (mind.action !== value) { mind.action = value; mind.age = 0; }
}
function settle(mind: BuilderMind) {
  mind.route = null; mind.distance = 0; mind.speed = 0; mind.trafficWaiting = false;
  if (mind.target) mind.direction = builderDirection(mind.target.lookAt.x - mind.position.x, mind.target.lookAt.y - mind.position.y);
  action(mind, mind.job && !mind.ready ? "work" : "idle");
  mind.wait = 8 + mind.wanderIndex % 3 * 3;
}

function beginRoute(mind: BuilderMind, places: BuilderPlaces, candidates: readonly BuilderStop[]) {
  mind.decisions++;
  const selected = builderRoute(places, mind.position, candidates);
  mind.distance = 0; mind.speed = 0; mind.trafficWaiting = false; mind.route = selected?.path ?? null; mind.target = selected?.target ?? null;
  mind.blocked = !selected;
  if (!selected) { action(mind, "idle"); mind.wait = 12; return; }
  if (selected.path.length < .001) { settle(mind); return; }
  action(mind, "walk");
}

/** Sampling is read-only; geometry uses the same checked polyline as steering. */
function sample(path: SteeringPath, at: number) {
  let low = 1, high = path.points.length - 1;
  while (low < high) { const mid = (low + high) >> 1; if (path.distances[mid] < at) low = mid + 1; else high = mid; }
  const a = path.points[low - 1], b = path.points[low], span = path.distances[low] - path.distances[low - 1];
  const t = Math.max(0, Math.min(1, (at - path.distances[low - 1]) / (span || 1)));
  return { position: { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }, direction: builderDirection(b.x - a.x, b.y - a.y) };
}

/** An idle destination has no gameplay ownership. Give up that destination
 * when two walkers need each other's space instead of waiting face to face.
 * Work shifts retain their exact goal; only a free builder may step aside. */
function yieldIdleDestination(mind: BuilderMind, places: BuilderPlaces, occupants?: readonly ResidentOccupant[]): boolean {
  if (mind.job || !mind.target || canTraverseResidents(mind.target.position, mind.target.position, BUILDER.size, occupants, BUILDER.id)
    || mind.elapsed < (idleYieldAfter.get(mind) ?? 0)) return false;
  idleYieldAfter.set(mind, mind.elapsed + RESIDENT_TRAFFIC_LIMITS.retry);
  const nearest = (occupants ?? []).slice(0, RESIDENT_TRAFFIC_LIMITS.occupants)
    .filter(other => other.id !== BUILDER.id && Number.isFinite(other.position.x) && Number.isFinite(other.position.y))
    .sort((a, b) => length(mind.position, a.position) - length(mind.position, b.position))[0];
  if (!nearest) return false;
  const away = Math.atan2(mind.position.y - nearest.position.y, mind.position.x - nearest.position.x);
  const step = BUILDER.size * .85;
  for (const offset of [0, Math.PI / 3, -Math.PI / 3, Math.PI / 2, -Math.PI / 2, Math.PI, Math.PI * .75, -Math.PI * .75]) {
    const position = { x: mind.position.x + Math.cos(away + offset) * step,
      y: mind.position.y + Math.sin(away + offset) * step };
    if (!canTraverse(places.navigation, mind.position, position)
      || !canTraverseResidents(mind.position, position, BUILDER.size, occupants, BUILDER.id)) continue;
    beginRoute(mind, places, [{ id: "builder-yield", position, lookAt: { ...nearest.position } }]);
    return !mind.blocked;
  }
  return false;
}

function walk(mind: BuilderMind, places: BuilderPlaces, dt: number, occupants?: readonly ResidentOccupant[]) {
  const path = mind.route; if (!path || path.points.length < 2) { settle(mind); return; }
  const speed = desiredSteeringSpeed(path, mind.distance, BUILDER.speed, BUILDER_MIND_LIMITS.acceleration);
  const delta = BUILDER_MIND_LIMITS.acceleration * dt;
  mind.speed += Math.max(-delta, Math.min(delta, speed - mind.speed));
  let nextDistance = Math.min(path.length, mind.distance + mind.speed * dt), next = sample(path, nextDistance);
  if (!canTraverse(places.navigation, mind.position, next.position)) {
    // A slow frame can span multiple rounded corners. Stop at the next checked
    // vertex instead of drawing a chord that cuts through a wall.
    let vertex = 1;
    while (vertex < path.points.length - 1 && path.distances[vertex] <= mind.distance + 1e-7) vertex++;
    nextDistance = Math.min(nextDistance, path.distances[vertex]); next = sample(path, nextDistance);
    if (!canTraverse(places.navigation, mind.position, next.position)) {
      mind.blocked = true; mind.route = null; mind.speed = 0; action(mind, "idle"); return;
    }
  }
  if (!canTraverseResidents(mind.position, next.position, BUILDER.size, occupants, BUILDER.id)) {
    if (yieldIdleDestination(mind, places, occupants)) return;
    const detour = residentTrafficDetour({ owner: mind, navigation: places.navigation, from: mind.position,
      target: path.points.at(-1)!, size: BUILDER.size, occupants, selfId: BUILDER.id, time: mind.elapsed });
    mind.speed = 0; mind.trafficWaiting = true;
    if (detour && detour.length > 1) {
      const distances = [0];
      for (let index = 1; index < detour.length; index++) distances.push(distances[index - 1] + length(detour[index - 1], detour[index]));
      // Retain checked detour corners: smoothing against only static geometry
      // could round the feet back through a neighbour's temporary space.
      mind.route = { points: detour, distances, length: distances.at(-1)!, roundedCorners: 0, checks: 0,
        speedLimits: detour.map((_, index) => index === detour.length - 1 ? 0 : .85) };
      mind.distance = 0;
    }
    return;
  }
  mind.trafficWaiting = false;
  mind.walked += nextDistance - mind.distance; mind.distance = nextDistance;
  mind.position = next.position; mind.direction = next.direction;
  if (path.length - mind.distance < .001) settle(mind);
}

function synchronize(mind: BuilderMind, scene: FixedWorldScene, env: BuilderEnvironment): BuilderPlaces | null {
  // Loading is not an empty confirmed snapshot. In particular a slow economy
  // response must not first show an idle builder in the clearing, then move him.
  const restoreConstruction = mind.constructionPending;
  if (restoreConstruction && !env.construction) return null;
  const changedScene = mind.scene !== scene, places = builderLocalPlaces(scene);
  mind.scene = scene;
  if (restoreConstruction) {
    // No feet have been shown yet. If account artwork changed while loading,
    // validate from this geometry's rest rather than an obsolete spawn point.
    if (!places) { mind.available = false; return null; }
    mind.position = { ...places.rest.position }; mind.constructionPending = false;
  }
  const job = forestConstructionJob(env.construction, env.now);
  const key = job ? `${env.construction?.ownerPublicId}:${job.id}:${job.stationId}:${job.targetLevel}` : "";
  const changedJob = key !== mind.jobKey;
  const finishedAtSite = !!mind.job && !job && !mind.route && !mind.blocked && mind.available;
  const finishingAge = !job && mind.action === "finish" ? mind.age : null;
  const workDirection = mind.direction;
  mind.job = job; mind.jobKey = key; mind.ready = !!job && env.now >= Date.parse(job.finishesAt);
  if (!places || (changedScene || !mind.available) && !isWalkable(places.navigation, mind.position)) {
    mind.available = false; mind.route = null; mind.speed = 0; mind.blocked = true; action(mind, "idle"); return null;
  }
  const recovered = !mind.available;
  mind.available = true;
  if (changedJob || changedScene || recovered) {
    mind.noticePending = false;
    // Each new job or immutable geometry snapshot gets one bounded attempt.
    // Repeated camera paints and ready timers never retry a blocked route.
    const candidates = job ? builderWorkStops(scene, job) : [places.rest];
    const vacant = candidates.filter(stop => canTraverseResidents(stop.position, stop.position, BUILDER.size, env.occupants, BUILDER.id));
    beginRoute(mind, places, vacant.length ? vacant : candidates);
    if (restoreConstruction && job && mind.target && !mind.blocked
      && canTraverseResidents(mind.target.position, mind.target.position, BUILDER.size, env.occupants, BUILDER.id)) {
      // A construction present on cold entry has already been assigned. Its
      // validated exterior stop is enough to resume the cosmetic worker; no
      // saved coordinates, elapsed travel estimate or job timer change is needed.
      // beginRoute verifies reachability and both current/future art clearance.
      mind.position = { ...mind.target.position }; settle(mind);
    }
    if (finishedAtSite || finishingAge !== null) {
      // Claim/speed-up changes the building, never the feet. Inspect the result
      // once, then follow the already checked return path. A new job wins above.
      action(mind, "finish"); mind.age = finishingAge ?? 0; mind.direction = workDirection;
    }
  } else if (job && !mind.route && !mind.blocked) action(mind, mind.ready ? "idle" : "work");
  return places;
}

/** Accept job/deadline/geometry changes even at dt=0. Reduced motion and hidden
 * cameras can refresh status without moving the feet or cosmetic animation. */
export function advanceBuilderMind(mind: BuilderMind | null, scene: FixedWorldScene, dt: number,
  environment: BuilderEnvironment): void {
  if (!mind || !Number.isFinite(environment.now)) return;
  const places = synchronize(mind, scene, environment);
  if (!places || !Number.isFinite(dt) || dt <= 0) return;
  const step = Math.min(BUILDER_MIND_LIMITS.maxDelta, dt);
  mind.elapsed += step; mind.age += step;
  if (mind.action === "finish") {
    if (mind.age >= BUILDER_MIND_LIMITS.finish) {
      action(mind, mind.route ? "walk" : "idle");
      if (!mind.route) mind.wait = 6;
    }
    return;
  }
  if (mind.route) { walk(mind, places, step, environment.occupants); return; }
  if (mind.job) return; // Including a finished order awaiting confirmed collection.
  if (mind.action === "greet") {
    if (mind.age >= BUILDER_MIND_LIMITS.greeting) { action(mind, "idle"); mind.wait = 6; }
    return;
  }
  if (mind.noticePending && mind.elapsed >= mind.greetAfter) {
    mind.noticePending = false; mind.greetAfter = mind.elapsed + 15; mind.direction = "front"; action(mind, "greet"); return;
  }
  mind.wait -= step;
  if (mind.wait > 0 || places.wander.length < 2) return;
  // A failed idle destination is skipped on the next slow decision; no loops of
  // path searches run every animation frame or keep retrying an active job.
  mind.wanderIndex = (mind.wanderIndex + 1) % places.wander.length;
  const candidates = places.wander.slice(mind.wanderIndex).concat(places.wander.slice(0, mind.wanderIndex))
    .filter(stop => length(stop.position, mind.position) > BUILDER.size * .35);
  beginRoute(mind, places, candidates);
}

export function noticeBuilderMind(mind: BuilderMind | null): void {
  if (mind?.available && !mind.job) mind.noticePending = true;
}

/** Circle, map and hit testing all read this frame; none advances the resident. */
export function builderMindFrame(mind: BuilderMind | null, scene: FixedWorldScene, still: boolean): BuilderResidentFrame | null {
  if (!mind?.available || mind.constructionPending || mind.scene !== scene) return null;
  let displayAction = mind.action;
  if (mind.trafficWaiting && displayAction === "walk") displayAction = "idle";
  let phase = mind.action === "finish" ? Math.min(1, mind.age / BUILDER_MIND_LIMITS.finish)
    : mind.action === "greet" ? Math.min(1, mind.age / BUILDER_MIND_LIMITS.greeting) : mind.age % 6 / 6;
  if (mind.action === "work") {
    const time = mind.age % BUILDER_MIND_LIMITS.workRoutine, cycle = BUILDER_MIND_LIMITS.workCycle;
    // One measured tap, two quicker taps, then a pouch check and a quiet look
    // at the work. This is only a pose schedule; the job clock stays untouched.
    if (time < cycle) phase = time / cycle;
    else if (time < cycle * 2) phase = (time - cycle) % (cycle / 2) / (cycle / 2);
    else if (time < cycle * 2 + 1.6) { displayAction = "inspect"; phase = (time - cycle * 2) / 1.6; }
    else { displayAction = "idle"; phase = 0; }
  }
  if (still) { displayAction = mind.action === "work" ? "work" : "idle"; phase = 0; }
  return { id: "builder", ...mind.position, size: BUILDER.size, direction: mind.direction,
    action: displayAction,
    frame: still ? 0 : mind.action === "walk" ? Math.floor(mind.walked / (BUILDER.size * .06)) % 8 : Math.floor(mind.age * 8) % 32,
    phase, ...(mind.job ? { targetId: mind.job.stationId } : {}) };
}
