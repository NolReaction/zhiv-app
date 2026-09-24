import type { PixelDirection, PixelPose } from "@/features/mochlik/pixel-sprite";
import type { FixedWorldScene, WorldPath, WorldPoint } from "./tiled/types";

type ClearingAction = "look" | "sniff" | "groom" | "rest";
type ActionStep = { pose: PixelPose; seconds: number; direction?: PixelDirection };
type ClearingRoute = { id: string; points: WorldPoint[]; distances: number[]; length: number;
  activity: ClearingAction; pauseSeconds?: number };
export type ClearingRouteDiagnostic = { id: string; valid: boolean; reason: string | null };
export type ClearingActivityState = {
  home: WorldPoint; position: WorldPoint; size: number; direction: PixelDirection;
  stage: "home" | "outbound" | "activity" | "return";
  elapsed: number; stageElapsed: number; waitSeconds: number; frozen: boolean;
  routes: ClearingRoute[]; diagnostics: ClearingRouteDiagnostic[]; routeIndex: number; previousRoute: number;
  distance: number; speed: number; walked: number; seed: number; steps: ActionStep[];
};
export type ClearingActivityOptions = { enabled: boolean; blocked: boolean; dusk: number; rain: number };
export type ClearingActivityFrame = WorldPoint & { direction: PixelDirection; pose: PixelPose; frame: number };
const clamp = (n: number, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, n));
const finitePoint = (point: WorldPoint) => Number.isFinite(point.x) && Number.isFinite(point.y);
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
  if (path.activity && !["look", "sniff", "groom", "rest"].includes(path.activity)) return "invalid-activity";
  if (path.pauseSeconds !== undefined && (!Number.isFinite(path.pauseSeconds) || path.pauseSeconds < 2 || path.pauseSeconds > 20)) return "invalid-pause";
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
    if (scene.sites.some(site => touchesPolygon(previous, point, site.collision, clearance))) return "building-collision";
    // Exclusions are floating leaves / foreground artwork, never permission to walk on a river.
    if (scene.water?.surfaces.some(surface => touchesPolygon(previous, point, surface.points, clearance))) return "water-collision";
    if (i) length += distance(previous, point);
  }
  if (length < actor.size * .18 || length > radius * 3) return "invalid-length";
  return null;
}

/** Validate once when the scene is mounted, never in the animation loop. */
export function clearingRouteDiagnostics(scene: FixedWorldScene): ClearingRouteDiagnostic[] {
  return scene.paths.filter(path => path.behavior === "clearing").map(path => {
    const reason = validateRoute(scene, path);
    return { id: path.id, valid: reason === null, reason };
  });
}
export function createClearingActivity(scene: FixedWorldScene, seed = Math.random() * 0x100000000): ClearingActivityState {
  const diagnostics = clearingRouteDiagnostics(scene), home = { ...scene.actor?.spawn ?? { x: scene.focus.x + scene.focus.width / 2, y: scene.focus.y + scene.focus.height / 2 } };
  const routes: ClearingRoute[] = [];
  for (const [index, path] of scene.paths.filter(path => path.behavior === "clearing").entries()) {
    if (!diagnostics[index].valid) continue;
    const points = [{ ...home }, ...path.points.slice(1).map(point => ({ ...point }))], distances = [0];
    for (let i = 1; i < points.length; i++) distances.push(distances[i - 1] + distance(points[i - 1], points[i]));
    routes.push({ id: path.id, points, distances, length: distances.at(-1)!, activity: path.activity ?? "look", pauseSeconds: path.pauseSeconds });
  }
  return { home, position: { ...home }, size: scene.actor?.size ?? 56, direction: "front", stage: "home",
    elapsed: 0, stageElapsed: 0, waitSeconds: 2.5, frozen: false, routes, diagnostics, routeIndex: -1,
    previousRoute: -1, distance: 0, speed: 0, walked: 0, seed: Math.trunc(seed) >>> 0, steps: [] };
}
function random(state: ClearingActivityState) {
  state.seed = (Math.imul(state.seed, 1664525) + 1013904223) >>> 0;
  return state.seed / 0x100000000;
}
function startActivity(state: ClearingActivityState, options: ClearingActivityOptions, route?: ClearingRoute) {
  const night = clamp(options.dusk), wet = clamp(options.rain), choice = random(state);
  const activity = route?.activity ?? (wet > .45 ? "sniff" : night > .5 ? "rest" : choice < .35 ? "groom" : "look");
  let steps: ActionStep[];
  if (activity === "rest") steps = [{ pose: "yawn", seconds: 1.2 }, { pose: "drowsy", seconds: 1.2 },
    { pose: "sleep", seconds: 3 + night * 4 }, { pose: "drowsy", seconds: .8 }, { pose: "stretch", seconds: 1.1 }, { pose: "blink", seconds: .5 }];
  else if (activity === "groom") steps = [{ pose: "blink", seconds: .45 }, { pose: "groom", seconds: 1.7 },
    { pose: "scratch", seconds: 1.4 }, { pose: "shake", seconds: .8 }, { pose: "idle", seconds: .8 }];
  else if (activity === "sniff") steps = [{ pose: "wonder", seconds: .8 }, { pose: "sniff", seconds: 1.5 },
    { pose: "crouch", seconds: .8 }, { pose: wet > .4 ? "shake" : choice < .35 ? "sneeze" : "sniff", seconds: 1.1 }, { pose: "idle", seconds: .7 }];
  else steps = [{ pose: "idle", seconds: .8 }, { pose: "wonder", seconds: 1.3, direction: choice < .5 ? "left" : "right" },
    { pose: "blink", seconds: .4 }, { pose: "wonder", seconds: 1.1, direction: choice < .5 ? "right" : "left" },
    { pose: "stretch", seconds: 1 }, { pose: "idle", seconds: .7 }];
  const naturalDuration = steps.reduce((sum, step) => sum + step.seconds, 0);
  const duration = route?.pauseSeconds ?? naturalDuration * (.88 + random(state) * .3);
  steps = steps.map(step => ({ ...step, seconds: step.seconds * duration / naturalDuration }));
  state.stage = "activity"; state.stageElapsed = 0; state.steps = steps; state.speed = 0; state.direction = "front";
}
function arriveHome(state: ClearingActivityState, dusk: number) {
  state.position = { ...state.home }; state.stage = "home"; state.stageElapsed = 0; state.distance = 0;
  state.speed = 0; state.routeIndex = -1; state.direction = "front"; state.steps = [];
  state.waitSeconds = 2.8 + random(state) * 3 + clamp(dusk) * 2;
}
export function isClearingAtHome(state: ClearingActivityState) {
  return state.distance === 0 && distance(state.position, state.home) < .001;
}
/** Interrupt an endpoint action or outgoing leg, then retrace only the authored path. */
export function returnClearingHome(state: ClearingActivityState) {
  if (state.stage === "return" || state.stage === "home") return;
  state.steps = []; state.stageElapsed = 0;
  if (isClearingAtHome(state) || state.routeIndex < 0) arriveHome(state, 0);
  else { state.stage = "return"; state.speed = 0; }
}

/** Single-owner active time. Hidden tabs cannot produce a catch-up jump. */
export function advanceClearingActivity(state: ClearingActivityState, delta: number, options: ClearingActivityOptions) {
  state.frozen = !options.enabled || options.blocked;
  if (state.frozen || !Number.isFinite(delta) || delta <= 0) return;
  const dt = Math.min(delta, .1);
  state.elapsed += dt; state.stageElapsed += dt;
  if (state.stage === "home") {
    if (state.stageElapsed < state.waitSeconds) return;
    if (!state.routes.length) { startActivity(state, options); return; }
    const candidates = state.routes.map((route, index) => ({ index,
      weight: route.activity === "rest" ? 1 + clamp(options.dusk) * 2
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
  const route = state.routes[state.routeIndex];
  if (!route) { arriveHome(state, options.dusk); return; }
  const returning = state.stage === "return", remaining = returning ? state.distance : route.length - state.distance;
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
    else startActivity(state, options, route);
  }
}

export function clearingActivityFrame(state: ClearingActivityState, options: { still?: boolean } = {}): ClearingActivityFrame {
  const base = { ...state.position, direction: state.direction };
  if (options.still || state.frozen) return { ...base, pose: "idle", frame: 0 };
  if (state.stage === "outbound" || state.stage === "return") {
    return { ...base, pose: state.speed > .05 ? "walk" : "idle", frame: Math.floor(state.walked / (state.size * .075)) % 4 };
  }
  if (state.stage === "activity") {
    let elapsed = state.stageElapsed;
    for (const step of state.steps) {
      if (elapsed < step.seconds) return { ...base, direction: step.direction ?? "front", pose: step.pose,
        frame: step.pose === "sleep" ? Math.floor(elapsed * .8) % 4 : Math.floor(elapsed / step.seconds * 4) % 4 };
      elapsed -= step.seconds;
    }
  }
  return { ...base, pose: state.elapsed % 5 > 4.75 ? "blink" : "idle", frame: Math.floor(state.elapsed * 2) % 4 };
}
