import type { PixelDirection, PixelPose } from "@/features/mochlik/pixel-sprite";
import type { FixedWorldScene, WorldPath, WorldPoint } from "./tiled/types";

type ClearingAction = "look" | "sniff" | "groom" | "rest" | "bush";
type ClearingBush = { id: string; entry: WorldPoint; hide: WorldPoint };
type ActionStep = { pose: PixelPose; seconds: number; direction?: PixelDirection };
type ClearingRoute = { id: string; points: WorldPoint[]; distances: number[]; length: number;
  activity: ClearingAction; pauseSeconds?: number; bush?: ClearingBush };
type ClearingStage = "home" | "outbound" | "activity" | "return" | "attention"
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
  bushProgress: number; bushWake: boolean; bushLeaving: boolean; pendingBush: number | null; bushRequested: boolean;
};
export type ClearingActivityOptions = {
  enabled: boolean; blocked: boolean; dusk: number; rain: number;
  /** Set only while the target home visual is available. Missing routes remain harmless. */
  homeAvailable?: boolean;
  idleEligible?: boolean;
};
export type ClearingActivityFrame = WorldPoint & {
  direction: PixelDirection; pose: PixelPose; frame: number;
  opacity: number; homeSleeping: boolean; attention: boolean; residing: boolean;
  /** Feet remain on their ground path; only the sprite is raised during a jump. */
  lift?: number; bush?: { id: string; rustle: number; occlude: boolean };
};
export const CLEARING_HOME_IDLE_SECONDS = 180;
export const CLEARING_AWAKE_GRACE_SECONDS = 30;
const DOOR_FADE_SECONDS = .8;
const BUSH_PREPARE_SECONDS = 1.1, BUSH_ENTER_SECONDS = .8, BUSH_EXIT_SECONDS = .95, BUSH_LAND_SECONDS = .95;
const bushStage = (stage: ClearingStage) => stage.startsWith("bush-");
const clamp = (n: number, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, n));
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
  return { home, position: { ...home }, size: scene.actor?.size ?? 56, direction: "front", stage: "home",
    elapsed: 0, stageElapsed: 0, waitSeconds: 2.5, frozen: false, routes, diagnostics, routeIndex: -1,
    previousRoute: -1, distance: 0, speed: 0, walked: 0, seed: Math.trunc(seed) >>> 0, steps: [],
    homeRoute: homePath ? compileRoute(homePath, home, scene) : null, doorway, doorProgress: 0,
    doorSeconds: homeSite && doorway ? Math.max(DOOR_FADE_SECONDS, distance(homeSite.entry, doorway) / ((scene.actor?.size ?? 56) * .24)) : DOOR_FADE_SECONDS,
    waking: false, routeKind: "clearing", idleSeconds: 0,
    awakeUntil: 0, retiring: false, homeEnabled: false, attentionResume: null, attentionQuietUntil: 0,
    wakeOnExit: false, lastActivity: null, lastVariant: -1,
    bushProgress: 0, bushWake: false, bushLeaving: false, pendingBush: null, bushRequested: false };
}
function random(state: ClearingActivityState) {
  state.seed = (Math.imul(state.seed, 1664525) + 1013904223) >>> 0;
  return state.seed / 0x100000000;
}
function startActivity(state: ClearingActivityState, options: ClearingActivityOptions, route?: ClearingRoute) {
  if (route?.activity === "bush" && route.bush) {
    state.stage = "bush-prepare"; state.stageElapsed = 0; state.speed = 0; state.steps = [];
    state.bushProgress = 0; state.bushWake = false; state.bushLeaving = false;
    state.direction = route.bush.hide.x < route.bush.entry.x ? "left" : "right";
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
  state.waitSeconds = 2.8 + random(state) * 3 + clamp(dusk) * 2;
}
export function isClearingAtHome(state: ClearingActivityState) {
  return state.stage !== "attention" && state.routeKind === "clearing" && state.distance === 0 && distance(state.position, state.home) < .001;
}
/** Whether an automatic prop routine may take ownership of the stationary actor. */
export function canStartClearingLife(state: ClearingActivityState) {
  return state.stage === "home" && !state.retiring && !state.bushRequested && state.pendingBush === null && state.elapsed >= state.attentionQuietUntil
    && !(state.homeEnabled && state.idleSeconds >= CLEARING_HOME_IDLE_SECONDS);
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
  state.stageElapsed = 0;
  if (state.routeKind === "home") { state.stage = "home-return"; state.speed = 0; }
  else if (state.distance === 0 || state.routeIndex < 0) arriveHome(state, 0);
  else { state.stage = "return"; state.speed = 0; }
}
/** DEV / deliberate scene requests also bring a sleeping resident back outside. */
export function returnClearingHome(state: ClearingActivityState) {
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
    } else state.stage = resume === "activity" ? state.routeIndex < 0 ? "home" : "return"
      : resume === "outbound" && state.routes[state.routeIndex]?.bush ? "return" : resume;
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
  const resume = state.routeKind === "home" ? "home-return" : state.stage === "activity" ? state.routeIndex < 0 ? "home" : "return"
    : state.stage === "outbound" && state.routes[state.routeIndex]?.activity === "bush" ? "return" : state.stage;
  state.steps = [];
  if (resume === "return" && state.routes[state.routeIndex]?.bush) state.bushLeaving = true;
  beginAttention(state, sleepy, resume);
  return true;
}
function advanceWalk(state: ClearingActivityState, dt: number, options: ClearingActivityOptions) {
  const route = state.routeKind === "home" ? state.homeRoute : state.routes[state.routeIndex];
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
    if (returning) arriveHome(state, options.dusk);
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
  if (!state.homeEnabled && state.routeKind === "home" && state.stage !== "home-return" && state.stage !== "exiting") {
    state.retiring = false; retrace(state);
  }
  if (state.homeEnabled && !state.retiring && state.idleSeconds >= CLEARING_HOME_IDLE_SECONDS
    && state.stage !== "attention" && state.routeKind !== "home") {
    state.retiring = true; retrace(state);
  }
  if (bushStage(state.stage)) { advanceBush(state, dt); return; }
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
      if (state.stage === "home") state.waitSeconds = Math.max(5, state.waitSeconds);
    }
    return;
  }
  if (state.stage === "home") {
    if (state.retiring && state.homeEnabled) {
      state.stage = "homebound"; state.routeKind = "home"; state.stageElapsed = 0; state.distance = 0; state.speed = 0; return;
    }
    if (state.pendingBush !== null) {
      state.routeIndex = state.pendingBush; state.pendingBush = null; state.previousRoute = state.routeIndex;
      state.stage = "outbound"; state.stageElapsed = 0; state.distance = 0; state.speed = 0; return;
    }
    if (state.stageElapsed < state.waitSeconds) return;
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
    if (state.routeIndex >= 0) { state.stage = "return"; state.stageElapsed = 0; state.steps = []; }
    else arriveHome(state, options.dusk);
    return;
  }
  advanceWalk(state, dt, options);
}

function advanceBush(state: ClearingActivityState, dt: number) {
  const route = state.routes[state.routeIndex], bush = route?.bush;
  if (!bush) { retrace(state); return; }
  if (state.stage === "bush-prepare") {
    if (state.stageElapsed >= BUSH_PREPARE_SECONDS) { state.stage = "bush-enter"; state.stageElapsed = 0; }
  } else if (state.stage === "bush-enter") {
    state.bushProgress = clamp(state.bushProgress + dt / BUSH_ENTER_SECONDS); updateBushPosition(state);
    if (state.bushProgress >= 1) { state.stage = state.bushLeaving ? "bush-exit" : "bush-hidden"; state.stageElapsed = 0; }
  } else if (state.stage === "bush-hidden") {
    if (state.stageElapsed >= (route.pauseSeconds ?? 4.2)) { state.stage = "bush-exit"; state.stageElapsed = 0; }
  } else if (state.stage === "bush-exit") {
    state.bushProgress = clamp(state.bushProgress - dt / BUSH_EXIT_SECONDS); updateBushPosition(state);
    state.direction = bush.entry.x < bush.hide.x ? "left" : "right";
    if (state.bushProgress <= 0) { state.stage = "bush-land"; state.stageElapsed = 0; }
  } else if (state.stageElapsed >= BUSH_LAND_SECONDS) {
    if (state.bushWake) beginAttention(state, false, "return");
    else { state.stage = "return"; state.stageElapsed = 0; }
  }
}
function bushFrame(state: ClearingActivityState, still: boolean): Partial<ClearingActivityFrame> {
  const route = state.routes[state.routeIndex], bush = route?.bush;
  if (!bush || !bushStage(state.stage)) return {};
  const t = state.stageElapsed, progress = state.bushProgress;
  const jumping = state.stage === "bush-enter" || state.stage === "bush-exit";
  const hidden = state.stage === "bush-hidden";
  const rustle = state.stage === "bush-enter" ? Math.sin(Math.PI * clamp((progress - .3) / .7))
    : state.stage === "bush-exit" ? Math.sin(Math.PI * clamp((1 - progress) / .65))
    : hidden ? .25 + .55 * Math.max(0, Math.sin(t * 2.3)) ** 3
    : state.stage === "bush-land" ? .35 * Math.exp(-t * 5) : 0;
  return { lift: jumping ? Math.sin(progress * Math.PI) * state.size * (state.stage === "bush-enter" ? .28 : .2) : 0,
    bush: { id: bush.id, rustle: still ? 0 : clamp(rustle), occlude: true },
    opacity: hidden ? 0 : 1,
    pose: jumping ? progress > .78 ? "crouch" : "jump" : state.stage === "bush-prepare" ? t < .65 ? "wonder" : "crouch"
      : state.stage === "bush-land" ? t < .2 ? "crouch" : t < .75 ? "shake" : "blink" : "crouch",
    frame: jumping ? Math.min(3, Math.floor((state.stage === "bush-enter" ? progress : 1 - progress) * 4)) : Math.floor(t * 5) % 4 };
}

export function clearingActivityFrame(state: ClearingActivityState, options: { still?: boolean } = {}): ClearingActivityFrame {
  const opacity = state.stage === "home-sleep" ? 0 : state.stage === "entering" || state.stage === "exiting"
    ? 1 - state.doorProgress * state.doorProgress * (3 - 2 * state.doorProgress) : 1;
  const base = { ...state.position, direction: state.direction, opacity, homeSleeping: state.stage === "home-sleep",
    residing: state.routeKind === "home", attention: !options.still && (state.stage === "attention" || state.waking || state.bushWake || state.bushRequested || state.bushLeaving) };
  if (bushStage(state.stage)) return { ...base, pose: "idle", frame: 0, ...bushFrame(state, Boolean(options.still || state.frozen)) };
  if (state.stage === "home-sleep") return { ...base, pose: "sleep", frame: 0 };
  if (options.still || state.frozen) return { ...base, pose: "idle", frame: 0 };
  if (state.stage === "entering" || state.stage === "exiting") return { ...base, pose: "walk", frame: Math.floor(state.stageElapsed * 5) % 4 };
  if (["outbound", "return", "homebound", "home-return"].includes(state.stage)) {
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
