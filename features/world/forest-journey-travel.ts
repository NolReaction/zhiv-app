import { clearingActivityFrame, isClearingAtPoint, releaseClearingPoint, requestClearingOutside, requestClearingPoint } from "./clearing-activity";
import { economyJourneyAway, type EconomySceneJourney } from "./economy-scene-state";
import { cancelForestDirector } from "./forest-director";
import { fishingActionFrame, fishingDirection, fishingWaterTarget, FOREST_FISHING_FIRST_CATCH_SECONDS, type ForestFishingFrame } from "./forest-fishing";
import type { ForestSessionState } from "./forest-session";
import { forestTrailDestination } from "./forest-trails";
import { isWalkable } from "./navigation";
import type { FixedWorldScene, WorldPoint } from "./tiled/types";

export type ForestJourneyTravel = {
  jobId: string;
  phase: "leaving" | "fishing" | "away" | "returning";
  shore: WorldPoint;
  home: WorldPoint;
  beganAt: number;
  requested: boolean;
  scene: FixedWorldScene;
  waterTarget?: WorldPoint;
  fishingAt?: number;
  carryingFish?: boolean;
};
const shoreRoutes = new Set(["shore", "shore_camp"]);
const distance = (a: WorldPoint, b: WorldPoint) => Math.hypot(a.x - b.x, a.y - b.y);

export const forestJourneyWalking = (state: ForestSessionState) => state.journeyTravel?.phase === "leaving" || state.journeyTravel?.phase === "returning";

/** Economic time owns rewards. A coastal job keeps its actor physically present
 * throughout travel and fishing; other expeditions retain their off-map absence. */
export function forestJourneyActorAway(state: ForestSessionState, journey: EconomySceneJourney | null | undefined, now: number) {
  const travel = state.journeyTravel;
  return economyJourneyAway(journey, now)
    && !(travel?.jobId === journey?.id && (travel?.phase === "leaving" || travel?.phase === "fishing"));
}

/** Reconstruct a server-confirmed ongoing fishing job only when the session
 * first opens (or starts in reduced motion). No visible trip calls this helper. */
function restoreAtShore(state: ForestSessionState, shore: WorldPoint) {
  const clearing = state.clearing;
  Object.assign(clearing, { position: { ...shore }, stage: "clearing", stageElapsed: 0, distance: 0, speed: 0,
    routeKind: "clearing", routeIndex: -1, freeRoute: null, freePurpose: null, activeInteraction: null,
    requestedPoint: { ...shore }, steps: [], doorProgress: 0, waking: false, wakeOnExit: false,
    bushProgress: 0, bushWake: false, bushLeaving: false, bushRequested: false, pendingBush: null,
    pendingInteractionBush: null, returnToSpawn: false, exitAttention: null, attentionResume: null,
    retiring: false, idleSeconds: 0 });
}

function beginFishing(state: ForestSessionState, travel: ForestJourneyTravel) {
  travel.phase = "fishing"; travel.fishingAt = state.director.elapsed;
  state.clearing.direction = fishingDirection(travel.shore, travel.waterTarget);
  state.director.reason = travel.waterTarget ? "Ловит рыбу на берегу" : "Отдыхает на берегу — безопасного места для заброса нет";
}

/** Detached frame shares the session clock, actual feet and authored water.
 * Rest is the truthful fallback if a map has no usable water near its marker. */
export function forestJourneyFishingFrame(state: ForestSessionState, scene: FixedWorldScene, still = false): ForestFishingFrame | null {
  const travel = state.journeyTravel;
  if (!travel || travel.scene !== scene || state.life.garden.basket?.held) return null;
  if (forestJourneyWalking(state)) {
    const body = clearingActivityFrame(state.clearing, { still });
    if (body.residing || body.homeSleeping || body.bush?.occupied || body.opacity < 1) return null;
    return { ...state.clearing.position, size: state.clearing.size, direction: body.direction,
      action: body.pose === "walk" ? "walk" : "idle", phase: 0, frame: body.frame,
      carryingFish: Boolean(travel.carryingFish) };
  }
  if (travel.phase !== "fishing" || !isClearingAtPoint(state.clearing, travel.shore)) return null;
  return { ...state.clearing.position, size: state.clearing.size,
    direction: fishingDirection(travel.shore, travel.waterTarget),
    ...(travel.waterTarget ? fishingActionFrame(state.director.elapsed - (travel.fishingAt ?? state.director.elapsed), still)
      : { action: "rest" as const, phase: 0, frame: 0, carryingFish: false }),
    ...(travel.waterTarget ? { waterTarget: { ...travel.waterTarget } } : {}) };
}

/** Session-local cosmetic travel. Job ownership/deadlines never enter memory,
 * inventory or rewards. Reloading an ongoing shore job restores its visible
 * fishing place; newly confirmed jobs use the existing collision-safe walker. */
export function syncForestJourneyTravel(state: ForestSessionState, scene: FixedWorldScene,
  journey: EconomySceneJourney | null | undefined, now: number, still: boolean) {
  const active = economyJourneyAway(journey, now), id = active ? journey!.id : null;
  const observed = state.explorationId !== undefined, previous = state.explorationId;
  if (id !== previous) {
    state.explorationId = id;
    if (id) {
      cancelForestDirector(state, "Отправился исследовать окрестности");
      state.reaction = 0; state.animation = null; state.director.stimulus = null;
      state.director.reason = journey?.label || "Исследует окрестности";
      const shore = journey?.routeId && shoreRoutes.has(journey.routeId) ? forestTrailDestination(scene, "fishing") : null;
      if (shore && state.clearing.navigationEnabled && state.clearing.navigation
        && isWalkable(state.clearing.navigation, shore) && !state.life.garden.basket?.held) {
        const restoring = !observed || still;
        const travel: ForestJourneyTravel = { jobId: id, phase: "leaving", shore,
          home: { ...state.clearing.home }, beganAt: state.clearing.elapsed, requested: false,
          scene, waterTarget: fishingWaterTarget(scene, shore, state.clearing.size) };
        state.journeyTravel = travel;
        if (restoring) { restoreAtShore(state, shore); beginFishing(state, travel); }
        else requestClearingOutside(state.clearing);
      } else state.journeyTravel = undefined;
    } else if (previous) {
      const travel = state.journeyTravel;
      if (travel && !still && distance(state.clearing.position, travel.home) > .5) {
        travel.carryingFish = Boolean(travel.waterTarget && travel.fishingAt !== undefined
          && state.director.elapsed - travel.fishingAt >= FOREST_FISHING_FIRST_CATCH_SECONDS);
        travel.phase = "returning"; travel.requested = false; travel.beganAt = state.clearing.elapsed;
        releaseClearingPoint(state.clearing); requestClearingOutside(state.clearing);
      } else {
        state.journeyTravel = undefined; releaseClearingPoint(state.clearing);
      }
      state.clearing.idleSeconds = 0;
      state.director.reason = "Вернулся из исследования";
      state.director.nextDecisionAt = state.director.elapsed + 7;
    }
  }
  const travel = state.journeyTravel;
  if (!travel || travel.phase === "away") return;
  if (travel.scene !== scene && active) {
    const shore = forestTrailDestination(scene, "fishing");
    releaseClearingPoint(state.clearing);
    if (!shore || !state.clearing.navigation || !isWalkable(state.clearing.navigation, shore)) {
      travel.phase = "away"; return;
    }
    travel.scene = scene; travel.shore = shore;
    travel.waterTarget = fishingWaterTarget(scene, shore, state.clearing.size);
    travel.phase = "leaving"; travel.requested = false; travel.beganAt = state.clearing.elapsed;
    requestClearingOutside(state.clearing);
  }
  if (travel.phase === "fishing") return;
  // An explicit collection after the server timer finishes takes precedence:
  // the garden director can approach its bush from this actual outdoor point.
  if (travel.phase === "returning" && (state.life.garden.harvest || state.pendingLife)) {
    state.journeyTravel = undefined; return;
  }
  if (still) {
    // Changing accessibility preferences mid-walk freezes the actual feet.
    // It must not create a sudden jump to the shore or replay the departure.
    if (!active) { releaseClearingPoint(state.clearing); state.journeyTravel = undefined; }
    return;
  }
  const target = travel.phase === "leaving" ? travel.shore : travel.home;
  if (isClearingAtPoint(state.clearing, target)) {
    if (travel.phase === "leaving") beginFishing(state, travel);
    else {
      state.journeyTravel = undefined; releaseClearingPoint(state.clearing);
      state.director.reason = "Вернулся домой с берега"; state.director.nextDecisionAt = state.director.elapsed + 7;
    }
    return;
  }
  // DEV poses or another cancelled local scene can release the shared request.
  // Reacquire the same destination instead of keeping a stale ownership flag.
  if (travel.requested && (!state.clearing.requestedPoint || distance(state.clearing.requestedPoint, target) > .001)) travel.requested = false;
  if (!travel.requested) {
    travel.requested = requestClearingPoint(state.clearing, target);
    if (!travel.requested && state.clearing.behavior.reason === "requested-point-unreachable") {
      if (active) travel.phase = "away"; else state.journeyTravel = undefined;
      return;
    }
  }
  // A changed obstacle cannot trap a server reward behind a cosmetic walk.
  // Keep the last safe physical position; there is deliberately no position write.
  if (state.clearing.elapsed - travel.beganAt > 120) {
    releaseClearingPoint(state.clearing);
    if (active) travel.phase = "away"; else state.journeyTravel = undefined;
    return;
  }
  state.director.reason = travel.phase === "leaving" ? "Идёт по тропинке к берегу" : "Возвращается с берега домой";
}
