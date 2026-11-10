import type { FixedWorldScene, WorldPoint } from "@/features/world/tiled/types";
import type { ForestSessionState } from "@/features/world/state/forest-session";
import { economySceneBoatTiming, type EconomySceneBoatFishing } from "@/features/world/state/economy/economy-boat-fishing-state";
import { baseClearingNavigation, isClearingAtPoint, releaseClearingPoint, requestClearingOutside, requestClearingPoint, setClearingNavigationObstacle } from "@/features/world/simulation/clearing-activity";
import { cancelForestDirector } from "@/features/world/simulation/forest-director";
import { gardenBasketFootprint, parkForestGardenBasket } from "@/features/world/activities/garden/forest-garden";
import { fishingBoatPathPoint, fishingBoatRoute, type FishingBoatRoute } from "@/features/world/objects/fishing-boat/fishing-boat-navigation";

export const FISHING_BOAT_TRAVEL = { crossingSeconds: 2.6, sailingSeconds: 18 } as const;
type Phase = "approach" | "boarding" | "outward" | "away" | "landing" | "returning" | "complete";
export type ForestBoatTravel = { id: string; scene: FixedWorldScene; route: FishingBoatRoute | null; phase: Phase;
  phaseAt: number; requested: boolean; home: WorldPoint; boat: EconomySceneBoatFishing; now: number };
const unit = (value: number) => Math.max(0, Math.min(1, value));
const transition = (state: ForestSessionState, travel: ForestBoatTravel, phase: Phase) => {
  travel.phase = phase; travel.phaseAt = state.director.elapsed; travel.requested = false;
};
/** Only entry hydration or a completed gangplank puts the walking feet on its dry anchor. */
function restoreBoatFeet(state: ForestSessionState, point: WorldPoint) {
  Object.assign(state.clearing, { position: { ...point }, stage: "clearing", stageElapsed: 0, distance: 0, speed: 0,
    routeKind: "clearing", routeIndex: -1, freeRoute: null, freePurpose: null, activeInteraction: null,
    requestedPoint: { ...point }, steps: [], doorProgress: 0, waking: false, wakeOnExit: false,
    bushProgress: 0, bushWake: false, bushLeaving: false, bushRequested: false, pendingBush: null,
    pendingInteractionBush: null, returnToSpawn: false, exitAttention: null, attentionResume: null,
    retiring: false, idleSeconds: 0 });
}
export function forestBoatWalking(state: ForestSessionState) {
  return state.boatTravel?.phase === "approach" || state.boatTravel?.phase === "returning";
}
export function forestBoatActorAway(state: ForestSessionState) {
  return Boolean(state.boatTravel && !["approach", "returning", "complete"].includes(state.boatTravel.phase));
}
/** Owns only visible motion; deadlines, casts and cargo remain server authority. */
export function syncForestBoatTravel(state: ForestSessionState, scene: FixedWorldScene,
  boat: EconomySceneBoatFishing | null | undefined, now: number, still: boolean): boolean {
  // A camera can open before its account snapshot arrives. Only a confirmed
  // boat without a voyage means claim/reset; missing data cannot bring it home.
  boat ??= state.boatTravel?.boat;
  const voyage = boat?.voyage;
  let travel = state.boatTravel;
  if (!voyage && !travel) return false;
  if (voyage && travel?.id !== voyage.id) {
    const timing = economySceneBoatTiming(boat, now), age = (now - timing.departedAt) / 1000;
    cancelForestDirector(state, "Отправляется на лодочную рыбалку"); state.reaction = 0; state.animation = null;
    travel = { id: voyage.id, scene, route: fishingBoatRoute(scene), phase: timing.phase === "ready" ? "complete"
      : still || timing.phase !== "outbound" || age > 8 ? "away" : "approach",
      phaseAt: state.director.elapsed, requested: false, home: { ...state.clearing.home }, boat: boat!, now };
    state.boatTravel = travel;
    if (travel.phase === "away" && travel.route) restoreBoatFeet(state, travel.route.land);
    else if (travel.phase === "approach") requestClearingOutside(state.clearing);
  }
  if (!travel) return false;
  if (boat?.voyage?.id === travel.id) travel.boat = boat;
  travel.now = now;
  if (travel.scene !== scene) { travel.scene = scene; travel.route = fishingBoatRoute(scene); travel.requested = false; }
  const timing = economySceneBoatTiming(travel.boat, now), finished = !voyage || timing.phase === "ready";
  const route = travel.route;
  if (travel.phase === "complete") { if (!voyage) { state.boatTravel = undefined; releaseClearingPoint(state.clearing); return false; } return true; }
  if (still || !route) {
    if (finished) { restoreBoatFeet(state, travel.home); transition(state, travel, "complete"); }
    else transition(state, travel, "away");
    return true;
  }
  if (finished && ["away", "outward"].includes(travel.phase)) transition(state, travel, "landing");
  if (travel.phase === "approach") {
    const garden = state.life.garden;
    // A cancelled garden carry may have been in a narrow corridor. Retry on
    // the real approach, without hiding or duplicating its physical basket.
    if (garden.basket?.held && (garden.elapsed >= (garden.basket.dropRetryAt ?? 0) || isClearingAtPoint(state.clearing, route.land))) {
      if (parkForestGardenBasket(garden, state.clearing.position, baseClearingNavigation(state.clearing))) {
        setClearingNavigationObstacle(state.clearing, gardenBasketFootprint(garden));
        travel.requested = false;
      }
    }
    if (finished) transition(state, travel, "returning");
    else if (isClearingAtPoint(state.clearing, route.land) && !garden.basket?.held) transition(state, travel, "boarding");
    else if (!travel.requested) { requestClearingOutside(state.clearing); travel.requested = requestClearingPoint(state.clearing, route.land); }
  }
  if (travel.phase === "boarding" && state.director.elapsed - travel.phaseAt >= FISHING_BOAT_TRAVEL.crossingSeconds) transition(state, travel, finished ? "landing" : "outward");
  if (travel.phase === "outward" && state.director.elapsed - travel.phaseAt >= FISHING_BOAT_TRAVEL.sailingSeconds) transition(state, travel, "away");
  if (travel.phase === "landing" && state.director.elapsed - travel.phaseAt >= FISHING_BOAT_TRAVEL.crossingSeconds) {
    restoreBoatFeet(state, route.land); transition(state, travel, "returning");
  }
  if (travel.phase === "returning") {
    if (isClearingAtPoint(state.clearing, travel.home)) { transition(state, travel, "complete"); releaseClearingPoint(state.clearing); }
    else if (!travel.requested) { requestClearingOutside(state.clearing); travel.requested = requestClearingPoint(state.clearing, travel.home); }
  }
  return true;
}
export type ForestFishingBoatFrame = { x: number; y: number; heading: number; opacity: number; passenger: boolean; moving: boolean;
  age: number; width: number; level: number; modules?: EconomySceneBoatFishing["modules"]; upgrades: readonly string[]; artifacts: readonly string[];
  gangway: { from: WorldPoint; to: WorldPoint }; crossing?: WorldPoint & { inward: boolean; frame: number } };
export function forestFishingBoatFrame(state: ForestSessionState | undefined, scene: FixedWorldScene,
  boat: EconomySceneBoatFishing | null | undefined, now: number, still = false): ForestFishingBoatFrame | null {
  boat ??= state?.boatTravel?.boat;
  const route = fishingBoatRoute(scene); if (!route || boat === undefined || boat === null) return null;
  const travel = state?.boatTravel, active = travel && travel.id === boat.voyage?.id || travel && !boat.voyage && travel.phase !== "complete" ? travel : undefined;
  const age = state?.director.elapsed ?? 0;
  const result: ForestFishingBoatFrame = { ...route.dock, heading: 0, opacity: 1, passenger: false, moving: false, age,
    width: 44 * Math.min(scene.width, scene.height) / 1254, level: boat.level,
    modules: boat.modules ?? { hull: boat.level, engine: Number(Boolean(boat.upgrades?.includes("oars"))), tank: 0 },
    upgrades: boat.upgrades ?? [], artifacts: boat.artifacts ?? [],
    gangway: { from: route.land, to: route.dock } };
  const timing = economySceneBoatTiming(active?.boat ?? boat, now);
  if (active?.phase === "boarding" || active?.phase === "landing") {
    const inward = active.phase === "landing", p = unit((age - active.phaseAt) / FISHING_BOAT_TRAVEL.crossingSeconds);
    result.crossing = { ...fishingBoatPathPoint(route.gangway, inward ? 1 - p : p), inward, frame: still ? 0 : Math.floor(age * 7) % 4 };
  } else if (active?.phase === "outward") {
    const p = unit((age - active.phaseAt) / FISHING_BOAT_TRAVEL.sailingSeconds);
    Object.assign(result, fishingBoatPathPoint(route.sail, p), { passenger: true, moving: !still, opacity: 1 - unit((p - .88) / .12) });
  } else if (boat.voyage && timing.phase === "inbound" || active && !["approach", "returning", "complete"].includes(active.phase)) {
    if (timing.phase === "inbound") {
      const seconds = Math.min(FISHING_BOAT_TRAVEL.sailingSeconds, (timing.returnsAt - timing.returnStartedAt) / 1000);
      const p = unit((now - (timing.returnsAt - seconds * 1000)) / (seconds * 1000));
      Object.assign(result, fishingBoatPathPoint(route.sail, 1 - p), { passenger: true, moving: !still, opacity: unit(p / .12) });
      result.heading += Math.PI;
    } else result.opacity = 0;
  } else if (boat.voyage && !["ready", "idle"].includes(timing.phase) && !active) result.opacity = 0;
  return result;
}
