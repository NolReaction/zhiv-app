import type { PixelDirection } from "@/features/mochlik/pixel-sprite";
import { BUILDER, type BuilderAction, type BuilderResidentFrame, type BuilderSleepPhase } from "./builder-types";
import { builderDirection, builderLocalPlaces, builderRoute, builderWorkStops,
  type BuilderHome, type BuilderPlaces, type BuilderStop } from "./builder-navigation";
import { forestConstructionJob, type EconomySceneConstruction, type SceneConstructionJob } from "@/features/world/state/economy/economy-construction-state";
import { canTraverse, isWalkable } from "@/features/world/navigation/navigation";
import { desiredSteeringSpeed, type SteeringPath } from "@/features/world/navigation/steering";
import { canTraverseResidents, residentClearance, residentWalkingStep, residentRequestingPassage, residentPassageClear, residentYieldPoint,
  RESIDENT_TRAFFIC_LIMITS, type ResidentOccupant } from "@/features/world/navigation/resident-traffic";
import type { FixedWorldScene, WorldPoint } from "@/features/world/tiled/types";

export type BuilderEnvironment = { now: number; construction?: EconomySceneConstruction | null; occupants?: readonly ResidentOccupant[];
  night?: boolean; socialHold?: boolean };
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
  /** A short local visit, never an economic assignment or persisted route. */
  socialVisit: { targetId: string; anchor: WorldPoint } | null;
  sleepPhase: BuilderSleepPhase;
  /** Position on the authored entry -> doorway segment, also used by its fade. */
  sleepProgress: number;
  sleepHome: BuilderHome | null;
  homeNextAt: number; homeUntil: number; homeReason: "night" | "break" | null;
  /** A failed voluntary destination cools down without affecting work or doors. */
  idleAvoid: { id: string; until: number } | null;
};
export const BUILDER_MIND_LIMITS = { maxDelta: 1, workCycle: 2.2, workRoutine: 8.8, finish: 1.4,
  greeting: 2, inspection: 2.6, idleRetry: 30, trafficPatience: 2.4, doorSeconds: 1.2, acceleration: BUILDER.size * 1.6 } as const;
const length = (a: WorldPoint, b: WorldPoint) => Math.hypot(a.x - b.x, a.y - b.y);
const idleYieldAfter = new WeakMap<BuilderMind, number>();
const trafficStalls = new WeakMap<BuilderMind, { startedAt: number; position: WorldPoint }>();
const passageYields = new WeakSet<BuilderMind>();

/** A single session owns the feet and cosmetic clock. No setInterval, job
 * commands, currency, reward generation or offline catch-up lives here. */
export function createBuilderMind(scene: FixedWorldScene, options: { awaitConstruction?: boolean } = {}): BuilderMind | null {
  const places = builderLocalPlaces(scene); if (!places) return null;
  return { scene, available: true, position: { ...places.rest.position }, direction: "front", elapsed: 0, age: 0,
    action: "idle", ready: false, job: null, jobKey: "", target: places.rest,
    route: null, distance: 0, speed: 0, walked: 0, wait: 8, wanderIndex: 0, decisions: 0, blocked: false,
    noticePending: false, greetAfter: 0, constructionPending: options.awaitConstruction === true, trafficWaiting: false, socialVisit: null,
    sleepPhase: "awake", sleepProgress: 0, sleepHome: null, homeNextAt: 180, homeUntil: 0, homeReason: null, idleAvoid: null };
}

function action(mind: BuilderMind, value: BuilderAction) {
  if (mind.action !== value) { mind.action = value; mind.age = 0; }
}
function settle(mind: BuilderMind) {
  passageYields.delete(mind);
  trafficStalls.delete(mind);
  mind.route = null; mind.distance = 0; mind.speed = 0; mind.trafficWaiting = false;
  if (mind.target) mind.direction = builderDirection(mind.target.lookAt.x - mind.position.x, mind.target.lookAt.y - mind.position.y);
  action(mind, mind.job && !mind.ready ? "work" : "idle");
  mind.wait = 7 + (mind.wanderIndex * 3 + mind.decisions) % 4 * 3;
  if (!mind.job && mind.sleepPhase === "awake" && mind.target?.id.startsWith("builder-look-")) action(mind, "inspect");
  if (mind.sleepPhase === "approach" && mind.sleepHome && mind.target?.id === "builder-home"
    && length(mind.position, mind.sleepHome.entry) < .001) {
    mind.sleepPhase = "enter"; mind.sleepProgress = 0; action(mind, "walk");
  }
}

function beginRoute(mind: BuilderMind, places: BuilderPlaces, candidates: readonly BuilderStop[]) {
  passageYields.delete(mind);
  assignRoute(mind, builderRoute(places, mind.position, candidates));
}

function assignRoute(mind: BuilderMind, selected: ReturnType<typeof builderRoute>) {
  trafficStalls.delete(mind);
  mind.decisions++;
  mind.distance = 0; mind.speed = 0; mind.trafficWaiting = false; mind.route = selected?.path ?? null; mind.target = selected?.target ?? null;
  mind.blocked = !selected;
  if (!selected) { action(mind, "idle"); mind.wait = 12; return; }
  if (selected.path.length < .001) { settle(mind); return; }
  action(mind, "walk");
}

/** A stationary neighbour must participate too: waiting for its idle timer is
 * not a route solution. Optional walking/rest yields immediately. Construction
 * may move only to another checked work stop, retaining its authoritative job.
 * A social gesture and the private doorway remain owned by their directors. */
function yieldRequestedPassage(mind: BuilderMind, places: BuilderPlaces, occupants?: readonly ResidentOccupant[]): boolean {
  if (mind.sleepPhase !== "awake" || mind.socialVisit || mind.action === "finish" || passageYields.has(mind)) return false;
  const requester = residentRequestingPassage(mind.position, BUILDER.size, occupants, BUILDER.id, mind.job ? 2 : mind.route ? 1 : 0);
  if (!requester || mind.elapsed < (idleYieldAfter.get(mind) ?? 0)) return false;
  // Passing walkers keep their destinations. Only an actually occupied held
  // goal may interrupt a route; an idle/work pose can still step aside.
  if (mind.route && mind.target && length(mind.target.position, requester.position) > residentClearance(BUILDER.size, requester.size)) return false;
  idleYieldAfter.set(mind, mind.elapsed + RESIDENT_TRAFFIC_LIMITS.retry);
  if (mind.job) {
    const candidates = builderWorkStops(mind.scene, mind.job)
      .filter(stop => length(mind.position, stop.position) > 1 && residentPassageClear(stop.position, BUILDER.size, requester, places.navigation.cellSize)
        && canTraverseResidents(stop.position, stop.position, BUILDER.size, occupants, BUILDER.id))
      .sort((a, b) => length(mind.position, a.position) - length(mind.position, b.position))
      .slice(0, RESIDENT_TRAFFIC_LIMITS.searches);
    for (const stop of candidates) {
      const selected = builderRoute(places, mind.position, [stop]);
      if (!selected || selected.path.points.some((point, index) => index > 0
        && !canTraverseResidents(selected.path.points[index - 1], point, BUILDER.size, occupants, BUILDER.id))) continue;
      assignRoute(mind, selected); passageYields.add(mind); return true;
    }
    return false;
  }
  const position = residentYieldPoint(places.navigation, mind.position, BUILDER.size, occupants, BUILDER.id, requester);
  if (!position) return false;
  const distance = length(mind.position, position), points = [{ ...mind.position }, position];
  // Execute the exact checked segment; no smoothing can put the feet back into
  // the corridor that was just released. The ordinary walker owns all movement.
  assignRoute(mind, { target: { id: "builder-yield", position, lookAt: { ...requester.position } },
    path: { points, distances: [0, distance], length: distance, speedLimits: [.85, 0], roundedCorners: 0, checks: 0 } });
  passageYields.add(mind); return true;
}

/** Sampling is read-only; geometry uses the same checked polyline as steering. */
function sample(path: SteeringPath, at: number) {
  let low = 1, high = path.points.length - 1;
  while (low < high) { const mid = (low + high) >> 1; if (path.distances[mid] < at) low = mid + 1; else high = mid; }
  const a = path.points[low - 1], b = path.points[low], span = path.distances[low] - path.distances[low - 1];
  const t = Math.max(0, Math.min(1, (at - path.distances[low - 1]) / (span || 1)));
  return { position: { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }, direction: builderDirection(b.x - a.x, b.y - a.y) };
}

/** Short traffic waits retain the original goal. Only a continuous failed
 * approach gives up optional ownership, with a cooldown before choosing it again. */
function yieldIdleDestination(mind: BuilderMind, places: BuilderPlaces, occupants?: readonly ResidentOccupant[]): boolean {
  if (mind.job || mind.socialVisit || mind.sleepPhase !== "awake" || !mind.target || mind.target.id === "builder-yield"
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
    mind.idleAvoid = { id: mind.target.id, until: mind.elapsed + BUILDER_MIND_LIMITS.idleRetry };
    beginRoute(mind, places, [{ id: "builder-yield", position, lookAt: { ...nearest.position } }]);
    return !mind.blocked;
  }
  // A fully occupied pocket may have no legal escape at all. Defer this
  // voluntary goal where the feet actually are; this is no arrival or work.
  mind.idleAvoid = { id: mind.target.id, until: mind.elapsed + BUILDER_MIND_LIMITS.idleRetry };
  mind.route = null; mind.target = null; mind.distance = 0; mind.speed = 0;
  mind.trafficWaiting = false; mind.blocked = false; mind.wait = 3;
  trafficStalls.delete(mind); passageYields.delete(mind); action(mind, "idle");
  return true;
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
  const traffic = residentWalkingStep({ owner: mind, navigation: places.navigation, from: mind.position,
    target: path.points.at(-1)!, size: BUILDER.size, occupants, selfId: BUILDER.id, time: mind.elapsed }, next.position);
  if (!traffic.clear) {
    let stall = trafficStalls.get(mind);
    if (!stall) {
      stall = { startedAt: mind.elapsed, position: { ...mind.position } };
      trafficStalls.set(mind, stall);
    }
    const detour = traffic.path;
    // A stopped neighbour can seal a narrow passage even when our final goal is
    // empty. Try the usual detour first; a free builder eventually walks aside
    // instead of retrying this cosmetic journey forever. Tiny braking steps at
    // the clearance boundary do not restart the patience clock.
    if (!detour && mind.elapsed - stall.startedAt >= BUILDER_MIND_LIMITS.trafficPatience
      && yieldIdleDestination(mind, places, occupants)) return;
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
  const stall = trafficStalls.get(mind);
  if (stall && length(mind.position, stall.position) > BUILDER.size * .1) trafficStalls.delete(mind);
  if (path.length - mind.distance < .001) settle(mind);
}

const indoors = (mind: BuilderMind) => ["enter", "sleep", "exit"].includes(mind.sleepPhase);
function sameHome(a: BuilderHome | null, b: BuilderHome | null): boolean {
  return !!a && !!b && length(a.entry, b.entry) < 1e-7 && length(a.doorway, b.doorway) < 1e-7;
}
function doorPosition(home: BuilderHome, progress: number): WorldPoint {
  return { x: home.entry.x + (home.doorway.x - home.entry.x) * progress,
    y: home.entry.y + (home.doorway.y - home.entry.y) * progress };
}
function validDoorState(mind: BuilderMind, home: BuilderHome | null): boolean {
  return sameHome(mind.sleepHome, home) && Number.isFinite(mind.sleepProgress)
    && mind.sleepProgress >= 0 && mind.sleepProgress <= 1
    && length(mind.position, doorPosition(home!, mind.sleepProgress)) < .001;
}
function wake(mind: BuilderMind) {
  mind.sleepPhase = "awake"; mind.sleepProgress = 0; mind.sleepHome = null;
  mind.homeNextAt = mind.elapsed + 180 + mind.decisions % 4 * 12; mind.homeUntil = 0; mind.homeReason = null;
}
function approachHome(mind: BuilderMind, places: BuilderPlaces, reason: "night" | "break" = "night") {
  if (!places.home) return;
  mind.sleepHome = places.home; mind.sleepPhase = "approach"; mind.sleepProgress = 0;
  mind.homeReason = reason;
  mind.noticePending = false; mind.socialVisit = null;
  beginRoute(mind, places, [places.home.approach]);
}
function departHome(mind: BuilderMind, places: BuilderPlaces, occupants?: readonly ResidentOccupant[]) {
  wake(mind);
  const candidates = mind.job ? builderWorkStops(mind.scene, mind.job) : [places.rest];
  const vacant = candidates.filter(stop => canTraverseResidents(stop.position, stop.position, BUILDER.size, occupants, BUILDER.id));
  beginRoute(mind, places, vacant.length ? vacant : candidates);
}
function advanceDoor(mind: BuilderMind, places: BuilderPlaces, step: number, occupants?: readonly ResidentOccupant[]) {
  const home = places.home;
  if (!home || mind.sleepPhase === "sleep") return;
  const entering = mind.sleepPhase === "enter", direction = entering ? 1 : -1;
  const seconds = Math.max(BUILDER_MIND_LIMITS.doorSeconds, length(home.entry, home.doorway) / BUILDER.speed);
  const progress = Math.max(0, Math.min(1, mind.sleepProgress + direction * step / seconds));
  const position = doorPosition(home, progress);
  // Check the complete exit before revealing an indoor resident. Entering and
  // partly visible reversals also retain the usual swept resident clearance.
  if (!canTraverseResidents(mind.position, position, BUILDER.size, occupants, BUILDER.id)
    || !entering && mind.sleepProgress >= 1 && !canTraverseResidents(home.doorway, home.entry, BUILDER.size, occupants, BUILDER.id)) {
    mind.trafficWaiting = true; return;
  }
  mind.trafficWaiting = false;
  mind.walked += length(mind.position, position); mind.position = position; mind.sleepProgress = progress;
  mind.direction = builderDirection((home.doorway.x - home.entry.x) * direction, (home.doorway.y - home.entry.y) * direction);
  if (entering && progress >= 1) { mind.sleepPhase = "sleep"; mind.homeUntil = mind.elapsed + 30 + mind.decisions % 4 * 5; action(mind, "idle"); }
  else if (!entering && progress <= 0) departHome(mind, places, occupants);
}

/** Server memory owns no builder coordinates. Preserve local door continuity
 * only while the new geometry validates that same private crossing. */
export function rehydrateBuilderMind(scene: FixedWorldScene, previous: BuilderMind | null): BuilderMind | null {
  const next = createBuilderMind(scene, { awaitConstruction: previous?.constructionPending }), places = builderLocalPlaces(scene);
  if (!next || !previous || !places) return next;
  next.elapsed = previous.elapsed; next.homeNextAt = previous.homeNextAt;
  next.homeUntil = previous.homeUntil; next.homeReason = previous.homeReason;
  next.idleAvoid = previous.idleAvoid ? { ...previous.idleAvoid } : null;
  if (indoors(previous)) {
    next.position = { ...previous.position }; next.direction = previous.direction;
    next.sleepPhase = previous.sleepPhase; next.sleepProgress = previous.sleepProgress; next.sleepHome = previous.sleepHome;
    next.action = previous.action; next.age = previous.age; next.elapsed = previous.elapsed; next.walked = previous.walked;
    next.available = false;
    return next;
  }
  if (!isWalkable(places.navigation, previous.position)) return next;
  next.position = { ...previous.position }; next.direction = previous.direction; next.available = false;
  if (previous.action === "finish") { next.action = "finish"; next.age = previous.age; }
  return next;
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
  const atDoor = indoors(mind);
  if (!places || atDoor && !validDoorState(mind, places.home)
    || !atDoor && (changedScene || !mind.available) && !isWalkable(places.navigation, mind.position)) {
    mind.available = false; mind.route = null; mind.speed = 0; mind.blocked = true; mind.socialVisit = null; action(mind, "idle"); return null;
  }
  const recovered = !mind.available;
  mind.available = true;
  if (atDoor) {
    mind.sleepHome = places.home; mind.blocked = false; mind.socialVisit = null; mind.noticePending = false;
    if ((job || !env.night && (mind.homeReason !== "break" || mind.sleepPhase === "sleep" && mind.elapsed >= mind.homeUntil))
      && mind.sleepPhase !== "exit") mind.sleepPhase = "exit";
    action(mind, mind.sleepPhase === "sleep" ? "idle" : "walk");
    return places;
  }
  const cancelApproach = mind.sleepPhase === "approach" && (!!job || mind.homeReason !== "break" && !env.night || !places.home);
  if (cancelApproach) wake(mind);
  if (changedJob || changedScene || recovered || cancelApproach) {
    mind.socialVisit = null;
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
  if (!job && env.night && places.home && mind.action !== "finish"
    && (mind.sleepPhase === "awake" || changedScene || recovered)) approachHome(mind, places);
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
  if (indoors(mind)) { advanceDoor(mind, places, step, environment.occupants); return; }
  if (mind.action === "finish") {
    if (mind.age >= BUILDER_MIND_LIMITS.finish) {
      // The confirmed work has ended at these actual exterior feet. Take one
      // short look at its result before following the already checked return.
      action(mind, "inspect");
      if (!mind.route) mind.wait = 6;
    }
    return;
  }
  if (!mind.job && !mind.socialVisit && !environment.socialHold && !mind.noticePending
    && mind.sleepPhase === "awake" && mind.elapsed >= mind.homeNextAt && places.home) approachHome(mind, places, "break");
  yieldRequestedPassage(mind, places, environment.occupants);
  if (!mind.job && mind.sleepPhase === "awake") {
    if (mind.noticePending && mind.elapsed >= mind.greetAfter) {
      mind.noticePending = false; mind.greetAfter = mind.elapsed + 15; mind.direction = "front";
      mind.speed = 0; action(mind, "greet"); return;
    }
    if (mind.action === "greet") {
      if (mind.age >= BUILDER_MIND_LIMITS.greeting) { action(mind, mind.route ? "walk" : "idle"); mind.wait = 6; }
      return;
    }
    if (environment.socialHold && !mind.socialVisit && mind.target?.id !== "builder-yield") { mind.speed = 0; return; }
    if (mind.action === "inspect") {
      if (mind.age < BUILDER_MIND_LIMITS.inspection) return;
      action(mind, mind.route ? "walk" : "idle");
    }
  }
  if (mind.route) { walk(mind, places, step, environment.occupants); return; }
  if (mind.sleepPhase === "approach") {
    mind.wait -= step;
    if (mind.wait <= 0) approachHome(mind, places, mind.homeReason ?? "night");
    return;
  }
  if (mind.job) return; // Including a finished order awaiting confirmed collection.
  if (mind.socialVisit) return; // The social director releases this finite visit.
  // A host waits for the neighbour he agreed to meet. Work, doorways,
  // passage requests and a player's greeting keep their earlier priority.
  if (environment.socialHold) return;
  mind.wait -= step;
  if (mind.wait > 0 || places.wander.length < 2) return;
  // A failed idle destination is skipped on the next slow decision; no loops of
  // path searches run every animation frame or keep retrying an active job.
  mind.wanderIndex = (mind.wanderIndex + 1) % places.wander.length;
  const candidates = places.wander.slice(mind.wanderIndex).concat(places.wander.slice(0, mind.wanderIndex))
    .filter(stop => length(stop.position, mind.position) > BUILDER.size * .35
      && (mind.idleAvoid?.id !== stop.id || mind.elapsed >= mind.idleAvoid.until));
  beginRoute(mind, places, candidates);
}

export function noticeBuilderMind(mind: BuilderMind | null): void {
  if (mind?.available && !mind.job && mind.sleepPhase === "awake") mind.noticePending = true;
}

/** DEV and explicit home calls share the natural break's authored route. */
export function requestBuilderHome(mind: BuilderMind | null, scene: FixedWorldScene,
  occupants?: readonly ResidentOccupant[]): boolean {
  if (!mind?.available || mind.scene !== scene || mind.constructionPending || mind.job || mind.socialVisit || mind.noticePending
    || mind.sleepPhase !== "awake" || mind.action === "finish") return false;
  const places = builderLocalPlaces(scene);
  if (!places?.home || !canTraverseResidents(places.home.entry, places.home.entry, BUILDER.size, occupants, BUILDER.id)) return false;
  const selected = builderRoute(places, mind.position, [places.home.approach]);
  if (!selected) return false;
  mind.sleepHome = places.home; mind.sleepPhase = "approach"; mind.sleepProgress = 0; mind.homeReason = "break";
  assignRoute(mind, selected);
  return true;
}

/** Reserve a nearby exterior conversation spot through the usual bounded path
 * finder. Feet still advance only in advanceBuilderMind and use resident traffic. */
export function requestBuilderVisit(mind: BuilderMind | null, scene: FixedWorldScene,
  target: { id: string; position: WorldPoint; size: number; approach?: WorldPoint }, occupants?: readonly ResidentOccupant[]): boolean {
  if (!mind?.available || mind.scene !== scene || mind.constructionPending || mind.job || mind.socialVisit || mind.sleepPhase !== "awake"
    || mind.action === "finish" || !Number.isFinite(target.position.x) || !Number.isFinite(target.position.y)
    || !Number.isFinite(target.size) || target.size <= 0) return false;
  const places = builderLocalPlaces(scene); if (!places) return false;
  const gap = (BUILDER.size + target.size) * .56;
  const heading = Math.atan2(mind.position.y - target.position.y, mind.position.x - target.position.x);
  const candidates = (target.approach ? [{ id: `builder-social-${target.id}`, position: { ...target.approach }, lookAt: { ...target.position } }]
    : [0, Math.PI / 4, -Math.PI / 4, Math.PI / 2, -Math.PI / 2, Math.PI, Math.PI * .75, -Math.PI * .75]
    .map(offset => ({ id: `builder-social-${target.id}`,
      position: { x: target.position.x + Math.cos(heading + offset) * gap,
        y: target.position.y + Math.sin(heading + offset) * gap }, lookAt: { ...target.position } })))
    .filter(stop => isWalkable(places.navigation, stop.position)
      && canTraverseResidents(stop.position, stop.position, BUILDER.size, occupants, BUILDER.id));
  const selected = builderRoute(places, mind.position, candidates);
  if (!selected || selected.path.length > BUILDER.speed * 15) return false;
  // A failed request above leaves the previous ordinary walk entirely intact.
  mind.socialVisit = { targetId: target.id, anchor: { ...target.position } };
  mind.noticePending = false; mind.decisions++; mind.blocked = false; mind.trafficWaiting = false;
  mind.route = selected.path; mind.target = selected.target; mind.distance = 0; mind.speed = 0;
  if (selected.path.length < .001) settle(mind); else action(mind, "walk");
  return true;
}

/** Release only the visit we own. A construction that replaced it retains its
 * own target, route and animation. Cancelling never restores old coordinates. */
export function cancelBuilderVisit(mind: BuilderMind | null): void {
  if (!mind?.socialVisit) return;
  mind.socialVisit = null;
  if (mind.job) return;
  mind.route = null; mind.target = null; mind.distance = 0; mind.speed = 0; mind.trafficWaiting = false;
  mind.blocked = false; mind.wait = 3; action(mind, "idle");
}

/** Circle, map and hit testing all read this frame; none advances the resident. */
export function builderMindFrame(mind: BuilderMind | null, scene: FixedWorldScene, still: boolean): BuilderResidentFrame | null {
  if (!mind?.available || mind.constructionPending || mind.scene !== scene || mind.sleepPhase === "sleep"
    || indoors(mind) && mind.sleepProgress >= 1) return null;
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
    phase, ...(mind.job ? { targetId: mind.job.stationId } : {}), sleepPhase: mind.sleepPhase,
    ...(indoors(mind) ? { opacity: 1 - mind.sleepProgress } : {}) };
}

/** The common scene painter owns the Zzz; no hidden sprite or occupied feet. */
export function builderSleepIndicator(mind: BuilderMind | null, scene: FixedWorldScene):
  { x: number; y: number; size: number; phase: number } | null {
  if (!mind?.available || mind.constructionPending || mind.scene !== scene || mind.sleepPhase !== "sleep" || !mind.sleepHome) return null;
  return { ...mind.sleepHome.doorway, size: BUILDER.size, phase: mind.age };
}
