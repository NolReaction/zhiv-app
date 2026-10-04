import { isClearingAtPoint, releaseClearingPoint, requestClearingOutside, requestClearingPoint } from "./clearing-activity";
import { economyJourneyAway, type EconomySceneJourney } from "./economy-scene-state";
import { cancelForestDirector } from "./forest-director";
import type { ForestSessionState } from "./forest-session";
import { forestTrailDestination } from "./forest-trails";
import type { FixedWorldScene, WorldPoint } from "./tiled/types";

export type ForestJourneyTravel = {
  jobId: string;
  phase: "leaving" | "away" | "returning";
  shore: WorldPoint;
  home: WorldPoint;
  beganAt: number;
  requested: boolean;
};
const shoreRoutes = new Set(["shore", "shore_camp"]);
const distance = (a: WorldPoint, b: WorldPoint) => Math.hypot(a.x - b.x, a.y - b.y);

export const forestJourneyWalking = (state: ForestSessionState) => state.journeyTravel?.phase === "leaving" || state.journeyTravel?.phase === "returning";

/** Economic time still owns absence/rewards. Only the first visible departure
 * is delayed until the actor reaches the shore; neither camera owns a job. */
export function forestJourneyActorAway(state: ForestSessionState, journey: EconomySceneJourney | null | undefined, now: number) {
  return economyJourneyAway(journey, now) && state.journeyTravel?.phase !== "leaving";
}

/** Session-local cosmetic travel. No field is serialized by forest-memory;
 * hydrating an existing job never replays a departure or teleports the actor. */
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
      const fresh = observed && now >= Date.parse(journey!.startedAt) && now - Date.parse(journey!.startedAt) < 15_000;
      if (shore && state.clearing.navigationEnabled) {
        const leaving = fresh && !still && !state.life.garden.basket?.held;
        state.journeyTravel = { jobId: id, phase: leaving ? "leaving" : "away", shore,
          home: { ...state.clearing.home }, beganAt: state.clearing.elapsed, requested: false };
        if (leaving) requestClearingOutside(state.clearing);
      } else state.journeyTravel = undefined;
    } else if (previous) {
      const travel = state.journeyTravel;
      if (travel && !still && distance(state.clearing.position, travel.home) > .5) {
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
  // An explicit collection after the server timer finishes takes precedence:
  // the garden director can approach its bush from this actual outdoor point.
  if (travel.phase === "returning" && (state.life.garden.harvest || state.pendingLife)) {
    state.journeyTravel = undefined; return;
  }
  if (still) {
    releaseClearingPoint(state.clearing);
    if (active) travel.phase = "away"; else state.journeyTravel = undefined;
    return;
  }
  const target = travel.phase === "leaving" ? travel.shore : travel.home;
  if (isClearingAtPoint(state.clearing, target)) {
    if (travel.phase === "leaving") { travel.phase = "away"; state.director.reason = journey?.label || "Исследует берег"; }
    else {
      state.journeyTravel = undefined; releaseClearingPoint(state.clearing);
      state.director.reason = "Вернулся домой с берега"; state.director.nextDecisionAt = state.director.elapsed + 7;
    }
    return;
  }
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
