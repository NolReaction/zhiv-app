import type { PixelDirection, PixelPose } from "@/features/mochlik/pixel-sprite";
import type { FixedWorldScene, WorldPath, WorldPoint } from "./tiled/types";
import { createWorldNavigation, findWorldPath, isWalkable, type WorldNavigation } from "./navigation";
import { chooseForestGoal, createForestBehavior, type ForestBehaviorMemory, type ForestInterest } from "./forest-behavior";

type ClearingAction = "look" | "sniff" | "groom" | "rest" | "bush";
type ClearingBush = { id: string; entry: WorldPoint; hide: WorldPoint };
type BushBurst = { at: number; strength: number; seed: number };
type BushEffect = { id: string; elapsed: number; seed: number; emitted: number; bursts: BushBurst[] };
type ActionStep = { pose: PixelPose; seconds: number; direction?: PixelDirection };
type ClearingRoute = { id: string; points: WorldPoint[]; distances: number[]; length: number;
  activity: ClearingAction; pauseSeconds?: number; bush?: ClearingBush };
type ClearingStage = "home" | "outbound" | "activity" | "return" | "attention"
  | "clearing" | "free-walk"
  | "homebound" | "entering" | "home-sleep" | "exiting" | "home-return"
  | "bush-prepare" | "bush-enter" | "bush-hidden" | "bush-exit" | "bush-land";
export type ClearingRouteDiagnostic = { id: string; valid: boolean; reason: string | null };
export type ClearingActivityState = {
  /** Outdoor anchor, not the interior of the house. */
  home: WorldPoint; position: WorldPoint; size: number; direction: PixelDirection;
  stage: ClearingStage; elapsed: number; stageElapsed: number; waitSeconds: number; frozen: boolean;
  routes: ClearingRoute[]; diagnostics: ClearingRouteDiagnostic[]; routeIndex: number; previousRoute: number;
  distance: number; speed: number; walked: number; seed: number; steps: ActionStep[];
  homeRoute: ClearingRoute | null; doorway: WorldPoint | null; doorProgress: number; doorSeconds: number; waking: boolean; routeKind: "clearing" | "home";
  idleSeconds: number; awakeUntil: number; retiring: boolean; homeEnabled: boolean;
  attentionResume: ClearingStage | null; attentionQuietUntil: number; wakeOnExit: boolean;
  lastActivity: ClearingAction | null; lastVariant: number;
  /** Local visual clock survives the walk away until the last berries settle. */
  bushEffect: BushEffect | null;
  bushProgress: number; bushWake: boolean; bushLeaving: boolean; pendingBush: number | null; bushRequested: boolean;
  /** One movement owner: navigation feeds the same speed, feet and gait as authored routes. */
  navigation: WorldNavigation | null; navigationEnabled: boolean; interests: ForestInterest[]; behavior: ForestBehaviorMemory;
  freeRoute: ClearingRoute | null; freePurpose: "roam" | "point" | "home" | null;
  requestedPoint: WorldPoint | null; navigationRetryAt: number;
};
export type ClearingActivityOptions = {
  enabled: boolean; blocked: boolean; dusk: number; rain: number;
  /** Set only while the target home visual is available. Missing routes remain harmless. */
  homeAvailable?: boolean;
  idleEligible?: boolean;
  /** DEV comparison changes controller only after the current safe return to spawn. */
  navigationMode?: "auto" | "routes";
};
export type ClearingActivityFrame = WorldPoint & {
  direction: PixelDirection; pose: PixelPose; frame: number;
  opacity: number; homeSleeping: boolean; attention: boolean; residing: boolean;
  /** Feet remain on their ground path; only the sprite is raised during a jump. */
  lift?: number; compression?: number;
  bush?: { id: string; rustle: number; occlude: boolean; occupied: boolean; elapsed: number; bursts: BushBurst[] };
};
export const CLEARING_HOME_IDLE_SECONDS = 180;
export const CLEARING_AWAKE_GRACE_SECONDS = 30;
const DOOR_FADE_SECONDS = .8;
const BUSH_PREPARE_SECONDS = 1.15, BUSH_ENTER_SECONDS = 1.25, BUSH_EXIT_SECONDS = 1.35, BUSH_LAND_SECONDS = 1.05;
const BUSH_PARTICLE_SECONDS = 3.2;
const BUSH_TUCK_LIFT = .12;
const bushStage = (stage: ClearingStage) => stage.startsWith("bush-");
const clamp = (n: number, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, n));
const smooth = (value: number) => { const t = clamp(value); return t * t * (3 - 2 * t); };
const finitePoint = (point: WorldPoint | undefined): point is WorldPoint => Boolean(point && Number.isFinite(point.x) && Number.isFinite(point.y));
const distance = (a: WorldPoint, b: WorldPoint) => Math.hypot(a.x - b.x, a.y - b.y);

function segmentDistance(point: WorldPoint, a: WorldPoint, b: WorldPoint) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const t = clamp(((point.x - a.x) * dx + (point.y - a.y) * dy) / (dx * dx + dy * dy || 1));
  return Math.hypot(point.x - a.x - t * dx, point.y - a.y - t * dy);
}
function inside(point: WorldPoint, polygon: WorldPoint[]) {
  let result = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[j], b = polygon[i];
    if ((a.y > point.y) !== (b.y > point.y) && point.x < (b.x - a.x) * (point.y - a.y) / (b.y - a.y) + a.x) result = !result;
  }
  return result;
}
function intersects(a: WorldPoint, b: WorldPoint, c: WorldPoint, d: WorldPoint) {
  const cross = (p: WorldPoint, q: WorldPoint, r: WorldPoint) => (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
  return cross(a, b, c) * cross(a, b, d) < 0 && cross(c, d, a) * cross(c, d, b) < 0;
}
function touchesPolygon(a: WorldPoint, b: WorldPoint, polygon: WorldPoint[], clearance: number) {
  if (inside(a, polygon) || inside(b, polygon)) return true;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const c = polygon[j], d = polygon[i];
    if (intersects(a, b, c, d) || Math.min(segmentDistance(a, c, d), segmentDistance(b, c, d),
      segmentDistance(c, a, b), segmentDistance(d, a, b)) <= clearance) return true;
  }
  return false;
}

function validateRoute(scene: FixedWorldScene, path: WorldPath): string | null {
  const actor = scene.actor;
  if (!actor || !finitePoint(actor.spawn) || !Number.isFinite(actor.size) || actor.size <= 0) return "missing-actor";
  if (path.points.length < 2 || path.points.length > 64 || path.points.some(point => !finitePoint(point))) return "invalid-points";
  if (distance(path.points[0], actor.spawn) > 1) return "start-away-from-spawn";
  const focus = scene.focus;
  if (![focus.x, focus.y, focus.width, focus.height].every(Number.isFinite) || focus.width <= 0 || focus.height <= 0) return "invalid-focus";
  if (path.activity && !["look", "sniff", "groom", "rest", "bush"].includes(path.activity)) return "invalid-activity";
  if (path.pauseSeconds !== undefined && (!Number.isFinite(path.pauseSeconds) || path.pauseSeconds < 2 || path.pauseSeconds > 20)) return "invalid-pause";
  const homePath = path.behavior === "home";
  if (homePath && path.siteId !== "home") return "invalid-home-site";
  const homeSite = homePath ? scene.sites.find(site => site.id === path.siteId) : undefined;
  if (homePath && (!homeSite || !finitePoint(homeSite.entry))) return "missing-home-site";
  if (homeSite && distance(path.points.at(-1)!, homeSite.entry) > .001) return "home-end-away-from-entry";
  const bush = path.activity === "bush" ? scene.bushes?.find(item => item.id === path.bushId) : undefined;
  if (path.activity === "bush" && (path.behavior !== "clearing" || !bush)) return "missing-bush";
  if (bush && (!finitePoint(bush.entry) || !finitePoint(bush.hide) || bush.points.length < 3
    || bush.points.some(point => !finitePoint(point)) || !inside(bush.hide, bush.points))) return "invalid-bush";
  if (bush && distance(path.points.at(-1)!, bush.entry) > .001) return "bush-end-away-from-entry";
  if (bush && (distance(bush.entry, bush.hide) < actor.size * .1 || distance(bush.entry, bush.hide) > actor.size * .8)) return "invalid-bush-corridor";
  const radius = Math.min(focus.width * .3, actor.size * 1.6), clearance = actor.size * .1;
  const points = [{ ...actor.spawn }, ...path.points.slice(1)];
  let length = 0;
  for (let i = 0; i < points.length; i++) {
    const point = points[i], previous = points[Math.max(0, i - 1)];
    if (distance(point, actor.spawn) > radius) return "outside-clearing-radius";
    // A convex ellipse also contains every intermediate point of these straight segments.
    for (const dx of [-actor.size * .5, actor.size * .5]) for (const dy of [-actor.size, actor.size * .08]) {
      const x = point.x + dx, y = point.y + dy;
      if (x < 0 || y < 0 || x > scene.width || y > scene.height) return "outside-map";
      if (((x - focus.x - focus.width / 2) / (focus.width / 2)) ** 2
        + ((y - focus.y - focus.height / 2) / (focus.height / 2)) ** 2 > 1) return "outside-focus";
    }
    for (const site of scene.sites) {
      let end = point;
      if (site === homeSite && i === points.length - 1) {
        // Feet may brush the doorway edge on the last small approach, not cross the house.
        const segmentLength = distance(previous, point), threshold = actor.size * .24;
        if (segmentLength <= threshold) continue;
        const t = (segmentLength - threshold) / segmentLength;
        end = { x: previous.x + (point.x - previous.x) * t, y: previous.y + (point.y - previous.y) * t };
      }
      if (touchesPolygon(previous, end, site.collision, clearance)) return "building-collision";
    }
    // Floating leaves / exclusions never give permission to walk on the river.
    if (scene.water?.surfaces.some(surface => touchesPolygon(previous, point, surface.points, clearance))) return "water-collision";
    if (i) length += distance(previous, point);
  }
  if (homeSite?.doorway) {
    const doorway = homeSite.doorway, entry = homeSite.entry;
    if (!finitePoint(doorway) || distance(entry, doorway) > actor.size * .6) return "invalid-doorway";
    for (const dx of [-actor.size * .5, actor.size * .5]) for (const dy of [-actor.size, actor.size * .08]) {
      const x = doorway.x + dx, y = doorway.y + dy;
      if (x < 0 || y < 0 || x > scene.width || y > scene.height) return "outside-map";
      if (((x - focus.x - focus.width / 2) / (focus.width / 2)) ** 2
        + ((y - focus.y - focus.height / 2) / (focus.height / 2)) ** 2 > 1) return "outside-focus";
    }
    // Only this authored threshold corridor can enter the resident's own house.
    if (scene.sites.some(site => site !== homeSite && touchesPolygon(entry, doorway, site.collision, clearance))) return "building-collision";
    if (scene.water?.surfaces.some(surface => touchesPolygon(entry, doorway, surface.points, clearance))) return "water-collision";
  }
  if (bush) {
    // The jump is a short explicit corridor, never permission to cut through water or a building.
    for (const site of scene.sites) if (touchesPolygon(bush.entry, bush.hide, site.collision, clearance)) return "building-collision";
    if (scene.water?.surfaces.some(surface => touchesPolygon(bush.entry, bush.hide, surface.points, clearance))) return "water-collision";
    for (let sample = 0; sample <= 16; sample++) {
      const t = sample / 16, point = { x: bush.entry.x + (bush.hide.x - bush.entry.x) * t,
        y: bush.entry.y + (bush.hide.y - bush.entry.y) * t }, lift = Math.sin(t * Math.PI) * actor.size * .28;
      if (distance(point, actor.spawn) > radius) return "outside-clearing-radius";
      for (const dx of [-actor.size * .5, actor.size * .5]) for (const dy of [-actor.size - lift, actor.size * .08]) {
        const x = point.x + dx, y = point.y + dy;
        if (x < 0 || y < 0 || x > scene.width || y > scene.height) return "outside-map";
        if (((x - focus.x - focus.width / 2) / (focus.width / 2)) ** 2
          + ((y - focus.y - focus.height / 2) / (focus.height / 2)) ** 2 > 1) return "outside-focus";
      }
    }
  }
  if (length < actor.size * .18 || length > radius * 3) return "invalid-length";
  return null;
}

/** Validate once when the scene is mounted, never in the animation loop. */
export function clearingRouteDiagnostics(scene: FixedWorldScene): ClearingRouteDiagnostic[] {
  return scene.paths.filter(path => path.behavior === "clearing" || path.behavior === "home").map(path => {
    const reason = validateRoute(scene, path);
    return { id: path.id, valid: reason === null, reason };
  });
}
function compileRoute(path: WorldPath, home: WorldPoint, scene: FixedWorldScene): ClearingRoute {
  const points = [{ ...home }, ...path.points.slice(1).map(point => ({ ...point }))], distances = [0];
  for (let i = 1; i < points.length; i++) distances.push(distances[i - 1] + distance(points[i - 1], points[i]));
  const bush = path.bushId ? scene.bushes?.find(item => item.id === path.bushId) : undefined;
  return { id: path.id, points, distances, length: distances.at(-1)!, activity: path.activity ?? "look", pauseSeconds: path.pauseSeconds,
    ...(bush ? { bush: { id: bush.id, entry: { ...bush.entry }, hide: { ...bush.hide } } } : {}) };
}
export function createClearingActivity(scene: FixedWorldScene, seed = Math.random() * 0x100000000): ClearingActivityState {
  const diagnostics = clearingRouteDiagnostics(scene), home = { ...scene.actor?.spawn ?? { x: scene.focus.x + scene.focus.width / 2, y: scene.focus.y + scene.focus.height / 2 } };
  const validPaths = scene.paths.filter(path => (path.behavior === "clearing" || path.behavior === "home") && validateRoute(scene, path) === null);
  const routes = validPaths.filter(path => path.behavior === "clearing").map(path => compileRoute(path, home, scene));
  const homePath = validPaths.find(path => path.behavior === "home");
  const homeSite = homePath ? scene.sites.find(site => site.id === homePath.siteId) : undefined;
  const doorway = homeSite ? { ...homeSite.doorway ?? homeSite.entry } : null;
  const compiledNavigation = createWorldNavigation(scene, (scene.actor?.size ?? 56) * .1);
  const navigation = compiledNavigation && isWalkable(compiledNavigation, home) ? compiledNavigation : null;
  return { home, position: { ...home }, size: scene.actor?.size ?? 56, direction: "front", stage: "home",
    elapsed: 0, stageElapsed: 0, waitSeconds: 2.5, frozen: false, routes, diagnostics, routeIndex: -1,
    previousRoute: -1, distance: 0, speed: 0, walked: 0, seed: Math.trunc(seed) >>> 0, steps: [],
    homeRoute: homePath ? compileRoute(homePath, home, scene) : null, doorway, doorProgress: 0,
    doorSeconds: homeSite && doorway ? Math.max(DOOR_FADE_SECONDS, distance(homeSite.entry, doorway) / ((scene.actor?.size ?? 56) * .24)) : DOOR_FADE_SECONDS,
    waking: false, routeKind: "clearing", idleSeconds: 0,
    awakeUntil: 0, retiring: false, homeEnabled: false, attentionResume: null, attentionQuietUntil: 0,
    wakeOnExit: false, lastActivity: null, lastVariant: -1,
    bushEffect: null, bushProgress: 0, bushWake: false, bushLeaving: false, pendingBush: null, bushRequested: false,
    navigation, navigationEnabled: Boolean(navigation), interests: navigation ? (scene.navigation?.interests ?? []).map(item => ({ ...item, position: { ...item.position } })) : [],
    behavior: createForestBehavior(), freeRoute: null, freePurpose: null, requestedPoint: null, navigationRetryAt: 0 };
}
function random(state: ClearingActivityState) {
  state.seed = (Math.imul(state.seed, 1664525) + 1013904223) >>> 0;
  return state.seed / 0x100000000;
}
function startActivity(state: ClearingActivityState, options: ClearingActivityOptions, route?: ClearingRoute) {
  if (route?.activity === "bush" && route.bush) {
    state.stage = "bush-prepare"; state.stageElapsed = 0; state.speed = 0; state.steps = [];
    state.bushProgress = 0; state.bushWake = false; state.bushLeaving = false;
    state.direction = bushDirection(route.bush.entry, route.bush.hide);
    state.bushEffect = { id: route.bush.id, elapsed: 0, seed: Math.trunc(random(state) * 0x100000000), emitted: 0, bursts: [] };
    state.lastActivity = "bush";
    return;
  }
  const night = clamp(options.dusk), wet = clamp(options.rain), choice = random(state);
  let activity = route?.activity ?? (wet > .45 ? "sniff" : night > .5 ? "rest" : choice < .35 ? "groom" : "look");
  if (activity === "rest" && state.elapsed < state.awakeUntil) activity = "look";
  if (activity === "rest" && wet > .35) activity = "groom";
  if (!route && activity === state.lastActivity) activity = activity === "groom" ? "look" : "groom";
  const variant = state.lastVariant < 0 ? Math.floor(random(state) * 3) : (state.lastVariant + 1 + Math.floor(random(state) * 2)) % 3;
  state.lastActivity = activity; state.lastVariant = variant;
  let steps: ActionStep[];
  if (activity === "rest") steps = [{ pose: "yawn", seconds: 1.2 }, { pose: "drowsy", seconds: 1.2 },
    { pose: "sleep", seconds: 3 + night * 4 }, { pose: "drowsy", seconds: .8 }, { pose: "stretch", seconds: 1.1 }, { pose: "blink", seconds: .5 }];
  else if (activity === "groom") steps = variant === 2
    ? [{ pose: "stretch", seconds: 1 }, { pose: "groom", seconds: 1.4 }, { pose: "shake", seconds: .9 }, { pose: "scratch", seconds: 1 }, { pose: "blink", seconds: .45 }]
    : variant === 1
    ? [{ pose: "scratch", seconds: 1.3 }, { pose: "blink", seconds: .4 }, { pose: "groom", seconds: 1.6 }, { pose: "stretch", seconds: 1 }, { pose: "idle", seconds: .8 }]
    : [{ pose: "blink", seconds: .45 }, { pose: "groom", seconds: 1.7 }, { pose: "scratch", seconds: 1.4 }, { pose: "shake", seconds: .8 }, { pose: "idle", seconds: .8 }];
  else if (activity === "sniff") steps = [{ pose: "wonder", seconds: .8 }, { pose: "sniff", seconds: 1.5 },
    { pose: "crouch", seconds: .8 }, { pose: wet > .4 ? "shake" : variant === 1 ? "sneeze" : "sniff", seconds: 1.1 },
    { pose: variant === 2 ? "stretch" : wet > .4 && variant === 1 ? "groom" : "idle", seconds: .7 }];
  else steps = [{ pose: "idle", seconds: .8 }, { pose: "wonder", seconds: 1.3, direction: choice < .5 ? "left" : "right" },
    { pose: "blink", seconds: .4 }, { pose: "wonder", seconds: 1.1, direction: choice < .5 ? "right" : "left" },
    { pose: variant === 1 ? "scratch" : "stretch", seconds: 1 }, { pose: "idle", seconds: .7 }];
  const naturalDuration = steps.reduce((sum, step) => sum + step.seconds, 0);
  const duration = route?.pauseSeconds ?? naturalDuration * (.88 + random(state) * .3);
  state.steps = steps.map(step => ({ ...step, seconds: step.seconds * duration / naturalDuration }));
  state.stage = "activity"; state.stageElapsed = 0; state.speed = 0; state.direction = "front";
}
function arriveHome(state: ClearingActivityState, dusk: number) {
  state.position = { ...state.home }; state.stage = "home"; state.stageElapsed = 0; state.distance = 0;
  state.speed = 0; state.routeIndex = -1; state.routeKind = "clearing"; state.direction = "front"; state.steps = [];
  state.attentionResume = null; state.wakeOnExit = false; state.waking = false; state.doorProgress = 0;
  state.bushProgress = 0; state.bushWake = false; state.bushLeaving = false;
  state.bushRequested = state.pendingBush !== null;
  state.freeRoute = null; state.freePurpose = null;
  state.waitSeconds = 2.8 + random(state) * 3 + clamp(dusk) * 2;
}
export function isClearingAtHome(state: ClearingActivityState) {
  return state.stage !== "attention" && state.stage !== "free-walk" && state.routeKind === "clearing" && state.distance === 0 && distance(state.position, state.home) < .001;
}
/** Whether an automatic prop routine may take ownership of the stationary actor. */
export function canStartClearingLife(state: ClearingActivityState) {
  return (state.stage === "home" || state.stage === "clearing") && !state.retiring && !state.bushRequested && state.pendingBush === null && state.elapsed >= state.attentionQuietUntil
    && !(state.homeEnabled && state.idleSeconds >= CLEARING_HOME_IDLE_SECONDS);
}
/** Wildlife may approach a quiet actor wherever its feet are safely standing outdoors. */
export function canStartClearingInteraction(state: ClearingActivityState) {
  return (canStartClearingLife(state) || state.stage === "activity" && state.lastActivity !== "rest"
    && !state.retiring && !state.bushRequested && state.elapsed >= state.attentionQuietUntil)
    && state.routeKind === "clearing" && state.speed === 0;
}
export function isClearingAtPoint(state: ClearingActivityState, point: WorldPoint, tolerance = .5) {
  return finitePoint(point) && (state.stage === "clearing" || state.stage === "home")
    && state.speed === 0 && distance(state.position, point) <= tolerance;
}
function beginFreeWalk(state: ClearingActivityState, points: WorldPoint[], purpose: NonNullable<ClearingActivityState["freePurpose"]>,
  activity: ForestInterest["activity"] = "look", id: string = purpose) {
  const distances = [0];
  for (let i = 1; i < points.length; i++) distances.push(distances[i - 1] + distance(points[i - 1], points[i]));
  state.freeRoute = { id, points: points.map(point => ({ ...point })), distances, length: distances.at(-1)!, activity };
  state.freePurpose = purpose; state.stage = "free-walk"; state.stageElapsed = 0; state.distance = 0;
  state.navigationRetryAt = 0;
  state.speed = 0; state.routeIndex = -1; state.routeKind = "clearing"; state.steps = []; state.attentionResume = null;
}
function settleClearing(state: ClearingActivityState) {
  state.stage = "clearing"; state.stageElapsed = 0; state.speed = 0; state.distance = 0;
  state.freeRoute = null; state.freePurpose = null; state.routeIndex = -1; state.steps = [];
  state.waitSeconds = 2.8 + random(state) * 3;
}
/** Holds the destination until releaseClearingPoint so a queued routine cannot lose its turn. */
export function requestClearingPoint(state: ClearingActivityState, point: WorldPoint): boolean {
  if (!finitePoint(point) || !state.navigation || !state.navigationEnabled || state.retiring || state.bushRequested
    || state.pendingBush !== null || state.routeKind !== "clearing" || bushStage(state.stage)
    || !["home", "clearing", "free-walk", "activity"].includes(state.stage) || state.routeIndex >= 0) return false;
  if (state.requestedPoint && distance(state.requestedPoint, point) < .001
    && (state.freePurpose === "point" || isClearingAtPoint(state, point))) return true;
  const path = findWorldPath(state.navigation, state.position, point);
  if (!path) { state.behavior.reason = "requested-point-unreachable"; return false; }
  state.requestedPoint = { ...point }; state.behavior.reason = "requested-point";
  state.behavior.target = { id: "requested-point", position: { ...point }, activity: "look" };
  if (distance(state.position, point) < .001) settleClearing(state);
  else beginFreeWalk(state, path, "point");
  return true;
}
export function releaseClearingPoint(state: ClearingActivityState) {
  state.requestedPoint = null;
  if (state.freePurpose === "point") {
    if (state.stage === "attention") {
      state.freeRoute = null; state.freePurpose = null; state.attentionResume = "clearing";
    } else settleClearing(state);
  }
  if (state.stage === "clearing") { state.stageElapsed = 0; state.waitSeconds = 3; }
}
/** Detached readonly data for DEV; inspecting a route cannot mutate live movement. */
export function clearingNavigationFrame(state: ClearingActivityState): Readonly<{
  enabled: boolean; path: readonly Readonly<WorldPoint>[]; target: Readonly<WorldPoint> | null;
  reason: string; activity: string | null;
}> {
  const route = state.freeRoute;
  return { enabled: state.navigationEnabled, path: route?.points.map(point => ({ ...point })) ?? [],
    target: route ? { ...route.points.at(-1)! } : state.behavior.target ? { ...state.behavior.target.position } : null,
    reason: state.behavior.reason, activity: route?.activity ?? state.behavior.target?.activity ?? null };
}
function updateDoorPosition(state: ClearingActivityState) {
  const entry = state.homeRoute?.points.at(-1);
  if (!entry || !state.doorway) return;
  state.position = { x: entry.x + (state.doorway.x - entry.x) * state.doorProgress,
    y: entry.y + (state.doorway.y - entry.y) * state.doorProgress };
}
function beginExit(state: ClearingActivityState, wake: boolean, still = false) {
  state.wakeOnExit = wake; state.waking ||= wake;
  state.stageElapsed = 0; state.stage = still ? "home-return" : "exiting";
  if (still) { state.wakeOnExit = false; state.doorProgress = 0; updateDoorPosition(state); }
  state.direction = "front"; state.speed = 0;
}

function updateBushPosition(state: ClearingActivityState) {
  const bush = state.routes[state.routeIndex]?.bush;
  if (!bush) return;
  state.position = { x: bush.entry.x + (bush.hide.x - bush.entry.x) * state.bushProgress,
    y: bush.entry.y + (bush.hide.y - bush.entry.y) * state.bushProgress };
}
function leaveBush(state: ClearingActivityState, wake = false, still = false) {
  state.bushWake ||= wake; state.bushLeaving = true; state.steps = []; state.speed = 0;
  if (still) {
    state.bushProgress = 0; updateBushPosition(state); state.stage = "return"; state.stageElapsed = 0;
    state.bushWake = false; state.bushLeaving = false; state.bushRequested = false; return;
  }
  // Finish an airborne landing before turning around; repeated requests never reset the arc.
  if (state.stage === "bush-enter" || state.stage === "bush-exit" || state.stage === "bush-land") return;
  if (state.stage === "bush-prepare") {
    if (wake) beginAttention(state, false, "return"); else { state.stage = "return"; state.stageElapsed = 0; }
    return;
  }
  state.stage = "bush-exit"; state.stageElapsed = 0;
}
function retrace(state: ClearingActivityState) {
  state.steps = []; state.attentionResume = null;
  if (bushStage(state.stage)) { leaveBush(state); return; }
  if (state.stage === "home-sleep" || state.stage === "entering") { beginExit(state, false); return; }
  if (state.stage === "exiting") { state.wakeOnExit = false; return; }
  if (state.stage === "return" || state.stage === "home-return" || state.stage === "home") return;
  if (state.navigationEnabled && state.navigation && state.routeKind === "clearing" && state.routeIndex < 0) {
    if (state.freePurpose === "home" && state.stage === "free-walk") return;
    if (distance(state.position, state.home) < .001) { arriveHome(state, 0); return; }
    if (state.elapsed < state.navigationRetryAt) return;
    const path = findWorldPath(state.navigation, state.position, state.home);
    if (path) { beginFreeWalk(state, path, "home"); state.behavior.reason = "return-to-authored-route"; }
    else { settleClearing(state); state.navigationRetryAt = state.elapsed + 2; state.behavior.reason = "home-unreachable"; }
    return;
  }
  state.stageElapsed = 0;
  if (state.routeKind === "home") { state.stage = "home-return"; state.speed = 0; }
  else if (state.distance === 0 || state.routeIndex < 0) arriveHome(state, 0);
  else { state.stage = "return"; state.speed = 0; }
}
/** DEV / deliberate scene requests also bring a sleeping resident back outside. */
export function returnClearingHome(state: ClearingActivityState) {
  state.requestedPoint = null;
  state.retiring = false; state.idleSeconds = 0; state.pendingBush = null; state.bushRequested = false;
  if (state.routeKind === "clearing" && state.routes[state.routeIndex]?.bush && state.distance > 0) state.bushLeaving = true;
  if (state.routeKind === "home") state.waking = true;
  state.awakeUntil = state.elapsed + CLEARING_AWAKE_GRACE_SECONDS;
  retrace(state);
}
/** Deliberate bush requests use an authored route after any current excursion has returned. */
export function requestClearingBush(state: ClearingActivityState): boolean {
  const routeIndex = state.routes.findIndex(route => route.activity === "bush" && route.bush);
  if (routeIndex < 0) return false;
  state.retiring = false; state.idleSeconds = 0; state.awakeUntil = state.elapsed + CLEARING_AWAKE_GRACE_SECONDS;
  if (state.bushRequested || bushStage(state.stage)) { state.bushRequested = true; return true; }
  returnClearingHome(state);
  state.pendingBush = routeIndex; state.bushRequested = true;
  return true;
}
/** DEV uses the same safe return-and-enter path as inactivity, never a teleport. */
export function requestClearingSleep(state: ClearingActivityState): boolean {
  if (!state.homeRoute) return false;
  state.requestedPoint = null;
  state.pendingBush = null; state.bushRequested = false;
  if (state.stage === "home-sleep" || state.stage === "entering" || state.stage === "homebound") return true;
  state.retiring = true; state.idleSeconds = CLEARING_HOME_IDLE_SECONDS; state.waking = false;
  retrace(state);
  return true;
}
function beginAttention(state: ClearingActivityState, sleepy: boolean, resume: ClearingStage, standing = false) {
  state.stage = "attention"; state.stageElapsed = 0; state.attentionResume = resume;
  state.speed = 0; state.direction = "front";
  state.steps = sleepy
    ? [...(standing ? [] : [{ pose: "drowsy" as const, seconds: .35 }]), { pose: "stretch", seconds: .8 }, { pose: "greet", seconds: .85 }, { pose: "blink", seconds: .25 }]
    : [{ pose: "blink", seconds: .2 }, { pose: random(state) < .5 ? "greet" : "wonder", seconds: .9 }, { pose: "idle", seconds: .25 }];
}
/** A meaningful touch cancels a nap, rather than painting a greeting over paused sleep. */
export function noticeClearingActivity(state: ClearingActivityState, options: { still?: boolean } = {}): boolean {
  state.idleSeconds = 0; state.retiring = false; state.awakeUntil = state.elapsed + CLEARING_AWAKE_GRACE_SECONDS;
  state.pendingBush = null; state.bushRequested = false;
  state.requestedPoint = null;
  if (bushStage(state.stage)) {
    if (state.bushWake && !options.still) return false;
    leaveBush(state, true, options.still);
    if (options.still) state.attentionQuietUntil = state.elapsed + 1.5;
    return true;
  }
  if (options.still) {
    // Accessibility can be toggled midway through a response. Settle it even when
    // the normal repeated-tap guard would ignore another animated greeting.
    const resume = state.attentionResume ?? state.stage;
    state.bushLeaving = false;
    state.attentionResume = null; state.steps = []; state.waking = false; state.wakeOnExit = false;
    if (state.routeKind === "home") {
      if (["entering", "home-sleep", "exiting"].includes(state.stage)) {
        state.doorProgress = 0; updateDoorPosition(state);
      }
      state.stage = "home-return";
    } else state.stage = resume === "activity" ? state.routeIndex < 0 ? state.navigationEnabled ? "clearing" : "home" : "return"
      : resume === "outbound" && state.routes[state.routeIndex]?.bush ? "return" : resume;
    if (state.freePurpose === "point" || state.stage === "clearing") settleClearing(state);
    state.stageElapsed = 0; state.speed = 0; state.direction = "front";
    state.attentionQuietUntil = state.elapsed + 1.5;
    if (state.stage === "home") state.waitSeconds = 5;
    return true;
  }
  if (state.stage === "attention" || state.stage === "exiting" || state.elapsed < state.attentionQuietUntil) return false;
  if (state.routeKind === "home") state.waking = true;
  const pose = clearingActivityFrame(state).pose;
  const sleepy = pose === "sleep" || pose === "drowsy" || pose === "yawn";
  if (state.stage === "home-sleep" || state.stage === "entering") {
    state.steps = []; beginExit(state, true); return true;
  }
  const resume = state.routeKind === "home" ? "home-return" : state.freePurpose === "point" ? "clearing"
    : state.stage === "activity" ? state.routeIndex < 0 ? state.navigationEnabled ? "clearing" : "home" : "return"
    : state.stage === "outbound" && state.routes[state.routeIndex]?.activity === "bush" ? "return" : state.stage;
  state.steps = [];
  if (resume === "return" && state.routes[state.routeIndex]?.bush) state.bushLeaving = true;
  beginAttention(state, sleepy, resume);
  return true;
}
function advanceWalk(state: ClearingActivityState, dt: number, options: ClearingActivityOptions) {
  const free = state.stage === "free-walk";
  const route = free ? state.freeRoute : state.routeKind === "home" ? state.homeRoute : state.routes[state.routeIndex];
  if (free && !route) { settleClearing(state); return; }
  if (!route) { arriveHome(state, options.dusk); return; }
  const returning = state.stage === "return" || state.stage === "home-return";
  const remaining = returning ? state.distance : route.length - state.distance;
  const maxSpeed = state.size * .36 * (1 - clamp(options.dusk) * .25) * (1 - clamp(options.rain) * .12);
  const acceleration = state.size * .8, targetSpeed = Math.min(maxSpeed, Math.sqrt(2 * acceleration * remaining));
  state.speed += clamp(targetSpeed - state.speed, -acceleration * dt, acceleration * dt);
  const step = Math.min(remaining, state.speed * dt);
  state.distance = clamp(state.distance + step * (returning ? -1 : 1), 0, route.length); state.walked += step;
  let segment = 1;
  while (segment < route.points.length - 1 && route.distances[segment] < state.distance) segment++;
  const a = route.points[segment - 1], b = route.points[segment], length = route.distances[segment] - route.distances[segment - 1];
  const progress = length > 0 ? clamp((state.distance - route.distances[segment - 1]) / length) : 1;
  state.position = { x: a.x + (b.x - a.x) * progress, y: a.y + (b.y - a.y) * progress };
  const dx = (b.x - a.x) * (returning ? -1 : 1), dy = (b.y - a.y) * (returning ? -1 : 1);
  state.direction = Math.abs(dx) >= Math.abs(dy) * .9 ? dx < 0 ? "left" : "right" : dy < 0 ? "back" : "front";
  if (remaining - step < .001) {
    if (free) {
      if (state.freePurpose === "home") arriveHome(state, options.dusk);
      else if (state.freePurpose === "point") settleClearing(state);
      else startActivity(state, options, route);
    } else if (returning) arriveHome(state, options.dusk);
    else if (state.routeKind === "home") { state.stage = "entering"; state.stageElapsed = 0; state.doorProgress = 0; state.speed = 0; state.direction = "back"; }
    else startActivity(state, options, route);
  }
}

/** Single-owner active time. Hidden tabs cannot produce a catch-up jump. */
export function advanceClearingActivity(state: ClearingActivityState, delta: number, options: ClearingActivityOptions) {
  state.frozen = !options.enabled || options.blocked;
  if (!Number.isFinite(delta) || delta <= 0 || !options.enabled) return;
  const dt = Math.min(delta, .1);
  if (options.idleEligible ?? !options.blocked) state.idleSeconds += dt;
  state.homeEnabled = Boolean(options.homeAvailable && state.homeRoute);
  if (!state.homeEnabled) state.retiring = false;
  if (state.frozen) return;
  state.elapsed += dt; state.stageElapsed += dt;
  if (state.bushEffect) {
    state.bushEffect.elapsed += dt;
    const lastBurst = state.bushEffect.bursts.at(-1);
    if (!bushStage(state.stage) && (!lastBurst || state.bushEffect.elapsed - lastBurst.at > BUSH_PARTICLE_SECONDS)) state.bushEffect = null;
  }
  const navigationWanted = Boolean(state.navigation && options.navigationMode !== "routes");
  if (navigationWanted !== state.navigationEnabled) {
    state.requestedPoint = null;
    if (state.stage === "home" && isClearingAtHome(state)) state.navigationEnabled = navigationWanted;
    else { retrace(state); state.behavior.reason = "return-before-mode-change"; }
  }
  if (!state.homeEnabled && state.routeKind === "home" && state.stage !== "home-return" && state.stage !== "exiting") {
    state.retiring = false; retrace(state);
  }
  if (state.homeEnabled && !state.retiring && state.idleSeconds >= CLEARING_HOME_IDLE_SECONDS
    && state.stage !== "attention" && state.routeKind !== "home") {
    state.retiring = true; retrace(state);
  }
  if (bushStage(state.stage)) { advanceBush(state); return; }
  if (state.stage === "home-sleep") return;
  if (state.stage === "entering") {
    state.doorProgress = clamp(state.doorProgress + dt / state.doorSeconds); updateDoorPosition(state);
    if (state.doorProgress >= 1) { state.stage = "home-sleep"; state.stageElapsed = 0; }
    return;
  }
  if (state.stage === "exiting") {
    state.doorProgress = clamp(state.doorProgress - dt / state.doorSeconds); updateDoorPosition(state);
    if (state.doorProgress <= 0) {
      if (state.wakeOnExit) beginAttention(state, true, "home-return", true);
      else { state.stage = "home-return"; state.stageElapsed = 0; }
      state.wakeOnExit = false;
    }
    return;
  }
  if (state.stage === "attention") {
    if (state.stageElapsed >= state.steps.reduce((sum, step) => sum + step.seconds, 0)) {
      state.stage = state.attentionResume ?? "home"; state.attentionResume = null;
      state.stageElapsed = 0; state.steps = []; state.attentionQuietUntil = state.elapsed + 1.5;
      if (state.stage === "clearing") settleClearing(state);
      if (state.stage === "home") state.waitSeconds = Math.max(5, state.waitSeconds);
    }
    return;
  }
  if (state.stage === "home" || state.stage === "clearing") {
    if (state.stage === "clearing" && (state.retiring || state.pendingBush !== null)) { retrace(state); return; }
    if (state.retiring && state.homeEnabled) {
      state.stage = "homebound"; state.routeKind = "home"; state.stageElapsed = 0; state.distance = 0; state.speed = 0; return;
    }
    if (state.pendingBush !== null) {
      state.routeIndex = state.pendingBush; state.pendingBush = null; state.previousRoute = state.routeIndex;
      state.stage = "outbound"; state.stageElapsed = 0; state.distance = 0; state.speed = 0; return;
    }
    if (state.requestedPoint) return;
    if (state.stageElapsed < state.waitSeconds) return;
    if (state.navigationEnabled && state.navigation) {
      const goal = chooseForestGoal(state.navigation, state.interests, state.behavior, {
        position: state.position, size: state.size, elapsed: state.elapsed, awakeUntil: state.awakeUntil,
        dusk: options.dusk, rain: options.rain, random: () => random(state),
      });
      if (goal) beginFreeWalk(state, goal.path, "roam", goal.activity, goal.id);
      else startActivity(state, options);
      return;
    }
    if (!state.routes.length) { startActivity(state, options); return; }
    const candidates = state.routes.map((route, index) => ({ index,
      weight: route.activity === "rest" ? state.elapsed < state.awakeUntil ? .1 : 1 + clamp(options.dusk) * 2
        : route.activity === "sniff" || route.activity === "groom" ? 1 + clamp(options.rain) * 2 : 1,
    })).filter(item => state.routes.length === 1 || item.index !== state.previousRoute);
    let choice = random(state) * candidates.reduce((sum, item) => sum + item.weight, 0);
    state.routeIndex = candidates.find(item => (choice -= item.weight) <= 0)?.index ?? candidates.at(-1)!.index;
    state.previousRoute = state.routeIndex;
    state.stage = "outbound"; state.stageElapsed = 0; state.distance = 0; state.speed = 0; return;
  }
  if (state.stage === "activity") {
    if (state.stageElapsed < state.steps.reduce((sum, step) => sum + step.seconds, 0)) return;
    if (state.navigationEnabled && state.routeIndex < 0) settleClearing(state);
    else if (state.routeIndex >= 0) { state.stage = "return"; state.stageElapsed = 0; state.steps = []; }
    else arriveHome(state, options.dusk);
    return;
  }
  advanceWalk(state, dt, options);
}

function bushDirection(from: WorldPoint, to: WorldPoint): PixelDirection {
  // The resident faces into the leaves, rather than showing a sideways face while
  // its front half is being covered. Horizontal hideouts still use a side view.
  if (Math.abs(to.y - from.y) > Math.abs(to.x - from.x) * .45) return to.y < from.y ? "back" : "front";
  return to.x < from.x ? "left" : "right";
}
function burst(state: ClearingActivityState, slot: number, strength: number) {
  const effect = state.bushEffect;
  if (!effect || effect.emitted & (1 << slot)) return;
  effect.emitted |= 1 << slot;
  effect.bursts.push({ at: effect.elapsed, strength, seed: (effect.seed ^ Math.imul(slot + 1, 0x9e3779b9)) >>> 0 });
}
function advanceBush(state: ClearingActivityState) {
  const route = state.routes[state.routeIndex], bush = route?.bush;
  if (!bush) { retrace(state); return; }
  if (state.stage === "bush-prepare") {
    if (state.stageElapsed >= BUSH_PREPARE_SECONDS) { state.stage = "bush-enter"; state.stageElapsed = 0; }
  } else if (state.stage === "bush-enter") {
    state.bushProgress = smooth(state.stageElapsed / BUSH_ENTER_SECONDS); updateBushPosition(state);
    if (state.bushProgress >= .5) burst(state, 0, .85);
    if (state.stageElapsed >= BUSH_ENTER_SECONDS) {
      state.bushProgress = 1; updateBushPosition(state);
      state.stage = state.bushLeaving ? "bush-exit" : "bush-hidden"; state.stageElapsed = 0;
    }
  } else if (state.stage === "bush-hidden") {
    const duration = route.pauseSeconds ?? 4.2;
    if (state.stageElapsed >= .65) burst(state, 1, .7);
    if (state.stageElapsed >= Math.max(1.25, duration * .58)) burst(state, 2, 1);
    if (state.stageElapsed >= duration) { state.stage = "bush-exit"; state.stageElapsed = 0; }
  } else if (state.stage === "bush-exit") {
    const travel = clamp((state.stageElapsed - .18) / (BUSH_EXIT_SECONDS - .18));
    state.bushProgress = 1 - smooth(travel); updateBushPosition(state);
    state.direction = bushDirection(bush.hide, bush.entry);
    if (travel >= .07) burst(state, 3, .65);
    if (state.stageElapsed >= BUSH_EXIT_SECONDS) {
      state.bushProgress = 0; updateBushPosition(state); state.stage = "bush-land"; state.stageElapsed = 0;
    }
  } else if (state.stageElapsed >= BUSH_LAND_SECONDS) {
    if (state.bushWake) beginAttention(state, false, "return");
    else { state.stage = "return"; state.stageElapsed = 0; }
  }
}
function bushFrame(state: ClearingActivityState): Partial<ClearingActivityFrame> {
  const routeBush = state.routeKind === "clearing" ? state.routes[state.routeIndex]?.bush : undefined;
  const effect = state.bushEffect;
  const id = routeBush?.id ?? effect?.id;
  if (!id) return {};
  const matchingEffect = effect?.id === id ? effect : null;
  // Each physical nudge starts one finite damped shake. Pausing freezes this
  // clock, preserving both the moving foliage and every airborne berry.
  const rustle = (matchingEffect?.bursts ?? []).reduce((sum, item) => {
    const age = matchingEffect!.elapsed - item.at;
    return age < 0 || age > 1.3 ? sum : sum + item.strength * smooth(age / .08) * Math.exp(-age * 3.5)
      * (.8 + .2 * Math.cos(age * 20));
  }, 0);
  const foliage = { id, rustle: clamp(rustle), occlude: Boolean(routeBush), occupied: bushStage(state.stage),
    elapsed: matchingEffect?.elapsed ?? 0, bursts: matchingEffect?.bursts ?? [] };
  if (!routeBush || !bushStage(state.stage)) return { bush: foliage };
  const t = state.stageElapsed;
  let lift = 0, compression = 0, pose: PixelPose = "idle", frame = 0;
  if (state.stage === "bush-prepare") {
    compression = .28 * smooth((t - .45) / (BUSH_PREPARE_SECONDS - .45));
    pose = t < .45 ? "wonder" : "idle";
  } else if (state.stage === "bush-enter") {
    const travel = clamp(t / BUSH_ENTER_SECONDS);
    compression = .28 * (1 - smooth(travel / .22)) + smooth((travel - .25) / .75);
    lift = state.size * (.2 * Math.sin(travel * Math.PI) + BUSH_TUCK_LIFT * smooth((travel - .35) / .65));
    pose = "jump"; frame = Math.min(3, Math.floor(travel * 4));
  } else if (state.stage === "bush-hidden") {
    compression = 1; lift = state.size * BUSH_TUCK_LIFT;
    pose = "jump"; frame = 3;
  } else if (state.stage === "bush-exit") {
    const travel = clamp((t - .18) / (BUSH_EXIT_SECONDS - .18));
    compression = 1 - smooth(travel);
    lift = state.size * (BUSH_TUCK_LIFT * (1 - smooth(travel)) + .18 * Math.sin(travel * Math.PI));
    pose = "jump"; frame = Math.min(3, Math.floor(travel * 4));
  } else {
    compression = .2 * Math.sin(Math.PI * clamp(t / .3));
    pose = t < .3 ? "jump" : t < .85 ? "shake" : "blink";
    frame = Math.floor(t * 5) % 4;
  }
  return { bush: foliage, lift, compression: clamp(compression), pose, frame };
}

export function clearingActivityFrame(state: ClearingActivityState, options: { still?: boolean } = {}): ClearingActivityFrame {
  const opacity = state.stage === "home-sleep" ? 0 : state.stage === "entering" || state.stage === "exiting"
    ? 1 - state.doorProgress * state.doorProgress * (3 - 2 * state.doorProgress) : 1;
  const base = { ...state.position, direction: state.direction, opacity, homeSleeping: state.stage === "home-sleep",
    ...bushFrame(state), residing: state.routeKind === "home", attention: !options.still && (state.stage === "attention" || state.waking || state.bushWake || state.bushRequested || state.bushLeaving) };
  if (bushStage(state.stage)) return { ...base, pose: base.pose ?? "idle", frame: base.frame ?? 0 };
  if (state.stage === "home-sleep") return { ...base, pose: "sleep", frame: 0 };
  if (options.still || state.frozen) return { ...base, pose: "idle", frame: 0 };
  if (state.stage === "entering" || state.stage === "exiting") return { ...base, pose: "walk", frame: Math.floor(state.stageElapsed * 5) % 4 };
  if (["outbound", "return", "homebound", "home-return", "free-walk"].includes(state.stage)) {
    return { ...base, pose: state.speed > .05 ? "walk" : "idle", frame: Math.floor(state.walked / (state.size * .075)) % 4 };
  }
  if (state.stage === "activity" || state.stage === "attention") {
    let elapsed = state.stageElapsed;
    for (const step of state.steps) {
      if (elapsed < step.seconds) return { ...base, direction: step.direction ?? "front", pose: step.pose,
        frame: step.pose === "sleep" ? Math.floor(elapsed * .8) % 4 : Math.floor(elapsed / step.seconds * 4) % 4 };
      elapsed -= step.seconds;
    }
  }
  return { ...base, pose: state.elapsed % 5 > 4.75 ? "blink" : "idle", frame: Math.floor(state.elapsed * 2) % 4 };
}
