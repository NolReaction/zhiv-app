import type { PixelDirection } from "@/features/mochlik/pixel-sprite";
import type { ForestVillagerFrame } from "@/features/world/characters/forest-villager-types";
import { canTraverse, findWorldPath, isWalkable, type WorldNavigation } from "@/features/world/navigation/navigation";
import { desiredSteeringSpeed, prepareSteeringPath, type SteeringPath } from "@/features/world/navigation/steering";
import { canTraverseResidents, residentRouteIntent, residentWalkingStep, type ResidentOccupant } from "@/features/world/navigation/resident-traffic";
import type { FixedWorldScene, WorldPoint } from "@/features/world/tiled/types";
import { leaftailBoatRoute, LEAFTAIL_BOAT_GEOMETRY, type LeaftailBoatRoute } from "./leaftail-boat-navigation";

export type LeaftailBoatArrivalPhase = "waiting" | "sailing" | "landing" | "walking" | "greeting" | "complete" | "blocked";
export type LeaftailBoatArrivalState = { scene: FixedWorldScene; phase: LeaftailBoatArrivalPhase; completed: boolean;
  unlocked: boolean; allowed: boolean; route: LeaftailBoatRoute | null; position: WorldPoint; direction: PixelDirection;
  elapsed: number; age: number; distance: number; walked: number; speed: number; path: SteeringPath | null; target: WorldPoint | null;
  blockedSeconds: number; reason: string | null;
  /** Shared through geometry clones so a camera remount cannot acknowledge twice. */
  completionNotice?: { delivered: boolean; pending?: object } };
export type LeaftailBoatArrivalFrame = { phase: LeaftailBoatArrivalPhase; resident: ForestVillagerFrame;
  boat: WorldPoint & { opacity: number; rowing: boolean; phase: number };
  gangplank: { from: WorldPoint; to: WorldPoint; opacity: number } | null };
export const LEAFTAIL_BOAT_ARRIVAL_LIMITS = { sailSpeed: 48, walkSpeed: 40, landingSpeed: 18, greeting: 3.6,
  maximumDelta: .5, blockedSeconds: 24 } as const;
const copy = (p: WorldPoint) => ({ ...p });
function pointAt(path: SteeringPath, distance: number) {
  let low = 1, high = path.points.length - 1;
  while (low < high) { const middle = (low + high) >> 1; if (path.distances[middle] <= distance) low = middle + 1; else high = middle; }
  const a = path.points[Math.max(0, low - 1)], b = path.points[low] ?? a;
  const t = Math.max(0, Math.min(1, (distance - path.distances[Math.max(0, low - 1)]) / (path.distances[low] - path.distances[Math.max(0, low - 1)] || 1)));
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
}
function transition(state: LeaftailBoatArrivalState, phase: LeaftailBoatArrivalPhase, path: SteeringPath | null = null) {
  state.phase = phase; state.path = path; state.distance = 0; state.speed = 0; state.age = 0; state.blockedSeconds = 0;
}
export function createLeaftailBoatArrival(scene: FixedWorldScene): LeaftailBoatArrivalState {
  return { scene, phase: "waiting", completed: false, unlocked: false, allowed: false, route: null,
    position: { x: 0, y: 0 }, direction: "front", elapsed: 0, age: 0, distance: 0, walked: 0, speed: 0,
    path: null, target: null, blockedSeconds: 0, reason: null, completionNotice: { delivered: false } };
}
/** Called when the confirmed economy or permission changes, never by a draw. */
export function configureLeaftailBoatArrival(state: LeaftailBoatArrivalState, scene: FixedWorldScene,
  options: { unlocked: boolean; confirmed: boolean; seen: boolean; allowArrival: boolean }) {
  state.completionNotice ??= { delivered: false };
  state.allowed = options.confirmed && options.unlocked && options.allowArrival;
  state.unlocked = options.confirmed && options.unlocked;
  if (!state.unlocked) { transition(state, "waiting"); state.completed = false; return; }
  if (options.seen) { state.completionNotice.delivered = true; state.completed = true; transition(state, "complete"); return; }
  if (state.completed) return;
  const changed = state.scene !== scene; state.scene = scene;
  if ((!changed && state.phase !== "waiting") || !state.allowed) return;
  const route = leaftailBoatRoute(scene); state.route = route;
  if (!route) { transition(state, "blocked"); state.reason = "Для лодки нужен свободный причал и путь от берега к фургону."; return; }
  state.target = copy(route.target); state.reason = null;
  // A camera/visual-level change rechecks the remainder from the same feet.
  // Failed geometry never restarts the boat at the lower edge mid-crossing.
  if (changed && state.phase !== "waiting") {
    const navigation = state.phase === "sailing" ? route.water : state.phase === "landing" ? route.shore : route.ground;
    const target = state.phase === "sailing" ? route.dock : state.phase === "landing" ? route.land : route.target;
    const pathEnd = state.path?.points.at(-1), sameTarget = pathEnd && Math.hypot(pathEnd.x - target.x, pathEnd.y - target.y) < .01;
    let previous = state.position;
    const safeRemainder = sameTarget && state.path!.points.every((point, index) => {
      if (state.path!.distances[index] <= state.distance + 1e-7) return true;
      const safe = canTraverse(navigation, previous, point); previous = point; return safe;
    });
    if (isWalkable(navigation, state.position) && (safeRemainder
      || state.phase === "greeting" && Math.hypot(state.position.x - target.x, state.position.y - target.y) < .01)) return;
    const points = findWorldPath(navigation, state.position, target);
    const path = points && prepareSteeringPath(navigation, points, LEAFTAIL_BOAT_GEOMETRY.size);
    if (!path || !isWalkable(navigation, state.position)) {
      state.reason = "Разметка берега изменилась во время прибытия. Открой поляну заново."; transition(state, "blocked");
    } else {
      if (state.phase !== "sailing" && state.phase !== "landing") state.phase = "walking";
      state.path = path; state.distance = 0; state.speed = 0; state.blockedSeconds = 0;
    }
    return;
  }
  state.position = copy(route.sail.points[0]); transition(state, "sailing", route.sail);
}
export function settleLeaftailBoatArrival(state: LeaftailBoatArrivalState, occupants?: readonly ResidentOccupant[]) {
  if (!state.unlocked || !state.allowed || !state.route || state.completed) return false;
  if (!canTraverseResidents(state.route.target, state.route.target, LEAFTAIL_BOAT_GEOMETRY.size, occupants, "leaftail")) return false;
  state.position = copy(state.route.target); state.completed = true; transition(state, "complete"); return true;
}
function face(state: LeaftailBoatArrivalState, target: WorldPoint) {
  const dx = target.x - state.position.x, dy = target.y - state.position.y;
  if (Math.hypot(dx, dy) < .01) return;
  const horizontal = state.direction === "left" || state.direction === "right";
  if (horizontal ? Math.abs(dy) > Math.abs(dx) * 1.2 : Math.abs(dx) > Math.abs(dy) * 1.2)
    state.direction = horizontal ? dy > 0 ? "front" : "back" : dx > 0 ? "right" : "left";
  else state.direction = horizontal ? dx >= 0 ? "right" : "left" : dy >= 0 ? "front" : "back";
}
function walk(state: LeaftailBoatArrivalState, dt: number, navigation: WorldNavigation, speed: number, occupants: readonly ResidentOccupant[]) {
  const path = state.path; if (!path) return;
  const acceleration = 70, desired = desiredSteeringSpeed(path, state.distance, speed, acceleration);
  const nextSpeed = Math.max(state.speed - acceleration * dt, Math.min(desired, state.speed + acceleration * dt));
  const at = Math.min(path.length, state.distance + Math.max(.1, (state.speed + nextSpeed) / 2) * dt);
  const position = pointAt(path, at);
  if (!canTraverse(navigation, state.position, position)) { transition(state, "blocked"); state.reason = "Путь к фургону перекрыт."; return; }
  const land = state.phase === "walking", clear = land ? residentWalkingStep({ owner: state, navigation, from: state.position,
    target: path.points.at(-1)!, size: LEAFTAIL_BOAT_GEOMETRY.size, occupants, selfId: "leaftail", time: state.elapsed }, position)
    : { clear: state.phase !== "landing" || canTraverseResidents(state.position, position, LEAFTAIL_BOAT_GEOMETRY.size, occupants, "leaftail") };
  if (!clear.clear) {
    state.speed = 0; state.blockedSeconds = Math.min(LEAFTAIL_BOAT_ARRIVAL_LIMITS.blockedSeconds, state.blockedSeconds + dt);
    if ("path" in clear && clear.path) {
      const detour = prepareSteeringPath(navigation, clear.path, LEAFTAIL_BOAT_GEOMETRY.size);
      if (detour) { state.path = detour; state.distance = 0; state.blockedSeconds = 0; }
    }
    if (state.blockedSeconds >= LEAFTAIL_BOAT_ARRIVAL_LIMITS.blockedSeconds) {
      state.reason = "Листохвост ждёт, пока освободится подход к берегу или фургону.";
    }
    return;
  }
  state.blockedSeconds = 0; state.reason = null; face(state, pointAt(path, Math.min(path.length, at + 7)));
  state.walked += Math.hypot(position.x - state.position.x, position.y - state.position.y);
  state.position = position; state.distance = at; state.speed = nextSpeed;
  if (path.length - at > .001) return;
  if (state.phase === "sailing") transition(state, "landing", state.route!.landing);
  else if (state.phase === "landing") transition(state, "walking", state.route!.walk);
  else { state.direction = "front"; transition(state, "greeting"); }
}
/** One owner advances this with the shared session's active delta. Camera paints
 * are read-only, and pause/hidden/reduced-motion time cannot age the crossing. */
export function advanceLeaftailBoatArrival(state: LeaftailBoatArrivalState, seconds: number, env: {
  active?: boolean; paused?: boolean; hidden?: boolean; reducedMotion?: boolean; occupants?: readonly ResidentOccupant[];
} = {}) {
  if (!state.allowed || env.active === false || env.paused || env.hidden || env.reducedMotion
    || !Number.isFinite(seconds) || seconds <= 0 || !state.route || !["sailing", "landing", "walking", "greeting"].includes(state.phase)) return;
  let remaining = Math.min(LEAFTAIL_BOAT_ARRIVAL_LIMITS.maximumDelta, seconds);
  while (remaining > 1e-7 && !state.completed && state.phase !== "blocked") {
    const dt = Math.min(1 / 60, remaining); remaining -= dt; state.elapsed += dt; state.age += dt;
    if (state.phase === "greeting") {
      if (state.age >= LEAFTAIL_BOAT_ARRIVAL_LIMITS.greeting) { state.completed = true; transition(state, "complete"); }
    } else {
      const phase = state.phase;
      walk(state, dt, phase === "sailing" ? state.route.water : phase === "landing" ? state.route.shore : state.route.ground,
        phase === "sailing" ? LEAFTAIL_BOAT_ARRIVAL_LIMITS.sailSpeed : phase === "landing" ? LEAFTAIL_BOAT_ARRIVAL_LIMITS.landingSpeed : LEAFTAIL_BOAT_ARRIVAL_LIMITS.walkSpeed,
        env.occupants ?? []);
    }
  }
}
export function leaftailBoatArrivalFrame(state: LeaftailBoatArrivalState): LeaftailBoatArrivalFrame | null {
  if (!state.route || ["waiting", "complete", "blocked"].includes(state.phase)) return null;
  const seated = state.phase === "sailing", opacity = seated ? Math.min(1, state.age / .8) : state.phase === "walking" ? Math.max(0, 1 - state.age / 2) : state.phase === "greeting" ? 0 : 1;
  return { phase: state.phase, boat: { ...(seated ? state.position : state.route.dock), opacity, rowing: seated, phase: state.elapsed },
    gangplank: seated && state.distance < state.path!.length - 45 || opacity <= 0 ? null
      : { from: copy(state.route.dock), to: copy(state.route.land), opacity },
    resident: { id: "leaftail", ...state.position, y: state.position.y + (seated ? -2 : 0), size: LEAFTAIL_BOAT_GEOMETRY.size,
      direction: seated ? "front" : state.direction, action: seated ? "idle" : state.phase === "greeting" ? "greet" : "walk",
      frame: seated ? Math.floor(state.elapsed * 2) : Math.floor(state.walked / 2.75) % 16, phase: state.age,
      opacity: seated ? Math.min(1, state.age / .8) : 1, arriving: true } };
}
export function leaftailBoatArrivalOccupant(state: LeaftailBoatArrivalState): ResidentOccupant | null {
  if (!["landing", "walking", "greeting"].includes(state.phase)) return null;
  return { id: "leaftail", position: copy(state.position), size: LEAFTAIL_BOAT_GEOMETRY.size, moving: Boolean(state.path),
    intent: state.path ? residentRouteIntent(state.path, state.position, state.distance, LEAFTAIL_BOAT_GEOMETRY.size, 3) : undefined };
}
