import catalog from "@/apps/api/src/main/resources/world/economy-catalog.json";
import type { PixelDirection } from "@/features/mochlik/pixel-sprite";
import { isClearingAtPoint, releaseClearingPoint, requestClearingOutside, requestClearingPoint } from "@/features/world/simulation/clearing-activity";
import { cancelForestDirector } from "@/features/world/simulation/forest-director";
import { economyJourneyAway, type EconomySceneJourney } from "@/features/world/state/economy/economy-scene-state";
import type { ForestSessionState } from "@/features/world/state/forest-session";
import type { FixedWorldScene, WorldPoint } from "@/features/world/tiled/types";
import { isWalkable } from "@/features/world/navigation/navigation";
import { forestOutsideEdge } from "./forest-outside-edge";

export type ForestOutsideTravel = {
  entry: WorldPoint; offscreen: WorldPoint; duration: number; phaseAt: number;
  crossing?: "out" | "in";
  unavailable?: boolean; completed?: boolean; retryAt?: number;
};
const local = new Set(["forest", "old_woodland", "coastal_deposits", "shore", "shore_camp", "quarry_work"]);
const distant = new Set(["uplands", "far_bank_path", "far_bank_grove", "ancient_ruins", "cave", "deep_cave", "abandoned_quarry"]);
const baseDurations = new Map(catalog.explorations.map(route => [route.id, route.seconds]));
/** Server acceleration cannot turn a distant route into a local activity. */
export function isForestOutsideRoute(routeId: string | undefined): boolean {
  return Boolean(routeId && !local.has(routeId) && !routeId.startsWith("quarry_")
    && (distant.has(routeId) || (baseDurations.get(routeId) ?? 0) >= 3600));
}
/** The confirmed travel controller owns the worn prop through the whole road
 * home, including cancellation. A pending job or a completed stale receipt
 * cannot dress the hero; hydration uses the same controller as both cameras. */
export function forestOutsideJourneyBackpack(state: ForestSessionState, scene: FixedWorldScene): boolean {
  const travel = state.journeyTravel;
  return Boolean(travel?.outside && !travel.outside.completed && travel.scene === scene
    && (travel.phase === "leaving" || travel.phase === "returning"));
}
const unit = (n: number) => Math.max(0, Math.min(1, n));
const distance = (a: WorldPoint, b: WorldPoint) => Math.hypot(a.x - b.x, a.y - b.y);
function progress(outside: ForestOutsideTravel, elapsed: number) {
  const age = unit((elapsed - outside.phaseAt) / outside.duration);
  return outside.crossing === "in" ? 1 - age : age;
}
export function forestOutsideJourneyFrame(state: ForestSessionState, scene: FixedWorldScene, still = false):
  (WorldPoint & { size: number; pose: "walk"; direction: PixelDirection; frame: number; opacity: 1 }) | null {
  const travel = state.journeyTravel, outside = travel?.outside;
  if (!travel || !outside?.crossing || travel.scene !== scene) return null;
  const p = progress(outside, state.director.elapsed), inward = outside.crossing === "in" ? -1 : 1;
  const dx = (outside.offscreen.x - outside.entry.x) * inward, dy = (outside.offscreen.y - outside.entry.y) * inward;
  return { x: outside.entry.x + (outside.offscreen.x - outside.entry.x) * p,
    y: outside.entry.y + (outside.offscreen.y - outside.entry.y) * p, size: state.clearing.size,
    pose: "walk", direction: Math.abs(dx) > Math.abs(dy) ? dx > 0 ? "right" : "left" : dy > 0 ? "front" : "back",
    frame: still ? 0 : Math.floor(state.director.elapsed * 7) % 4, opacity: 1 };
}

/** Only initial hydration can reconstruct unseen feet at the saved route edge. */
function restoreOutsideFeet(state: ForestSessionState, point: WorldPoint) {
  Object.assign(state.clearing, { position: { ...point }, stage: "clearing", stageElapsed: 0, distance: 0, speed: 0,
    routeKind: "clearing", routeIndex: -1, freeRoute: null, freePurpose: null, activeInteraction: null,
    requestedPoint: { ...point }, steps: [], doorProgress: 0, waking: false, wakeOnExit: false,
    bushProgress: 0, bushWake: false, bushLeaving: false, bushRequested: false, pendingBush: null,
    pendingInteractionBush: null, returnToSpawn: false, exitAttention: null, attentionResume: null,
    retiring: false, idleSeconds: 0 });
}

/** A cosmetic trip shares the existing bounded walker and local active clock.
 * Its off-map projection never changes navigation feet, jobs or resources. */
export function syncForestOutsideJourney(state: ForestSessionState, scene: FixedWorldScene,
  journey: EconomySceneJourney | null | undefined, now: number, still: boolean, cancelled: readonly string[]): boolean {
  const active = economyJourneyAway(journey, now), outsideJob = active && isForestOutsideRoute(journey?.routeId);
  let travel = state.journeyTravel;
  if (!travel?.outside && !outsideJob) return false;
  // Finish the one borrowed basket, fishing tackle and local mine portal first.
  if (!travel?.outside && (travel?.gathering && travel.phase !== "ready" || travel?.ending || travel?.mining
    || travel?.phase === "fishing" || state.life.garden.basket?.held)) return false;
  if (!travel?.outside) {
    const first = state.explorationId === undefined, age = Math.max(0, (now - Date.parse(journey!.startedAt)) / 1000);
    const nav = state.clearing.navigation;
    const from = nav && isWalkable(nav, state.clearing.position) ? state.clearing.position : state.clearing.home;
    const edge = nav && state.clearing.navigationEnabled ? forestOutsideEdge(scene, nav, from, state.clearing.size) : null;
    cancelForestDirector(state, "Отправляется в дальнюю вылазку");
    state.reaction = 0; state.animation = null; state.explorationId = journey!.id;
    travel = { jobId: journey!.id, finishesAt: Date.parse(journey!.finishesAt), phase: "leaving",
      shore: edge?.entry ?? { ...state.clearing.position }, home: { ...state.clearing.home }, scene,
      beganAt: state.clearing.elapsed, requested: false,
      outside: { ...(edge ?? { entry: { ...state.clearing.position }, offscreen: { ...state.clearing.position }, duration: 1, unavailable: true }),
        phaseAt: state.director.elapsed } };
    state.journeyTravel = travel;
    if (edge && first && age > 15 && !cancelled.includes(travel.jobId)) { restoreOutsideFeet(state, edge.entry); travel.phase = "away"; }
    else requestClearingOutside(state.clearing);
  }
  const outside = travel.outside!;
  const same = journey?.id === travel.jobId;
  if (same) travel.finishesAt = Date.parse(journey!.finishesAt);
  if (cancelled.includes(travel.jobId) || !journey && now < travel.finishesAt) travel.cancelled = true;
  const finished = !same || !active || travel.cancelled;
  if (outside.completed) {
    if (!same || !active) { state.journeyTravel = undefined; state.explorationId = null; return false; }
    return true;
  }
  if (travel.scene !== scene) {
    travel.scene = scene;
    if (!state.clearing.navigation || !isWalkable(state.clearing.navigation, outside.entry)) outside.unavailable = true;
  }
  if (finished && travel.phase !== "returning") {
    if (outside.crossing === "out") {
      const p = progress(outside, state.director.elapsed);
      outside.crossing = "in"; outside.phaseAt = state.director.elapsed - (1 - p) * outside.duration;
    } else if (travel.phase === "away") { outside.crossing = "in"; outside.phaseAt = state.director.elapsed; }
    travel.phase = "returning"; travel.requested = false; travel.beganAt = state.clearing.elapsed;
    if (!outside.crossing) releaseClearingPoint(state.clearing);
  }
  if (outside.crossing) {
    if (!still && state.director.elapsed - outside.phaseAt >= outside.duration - 1e-9) {
      const out = outside.crossing === "out";
      outside.crossing = undefined;
      if (out) { travel.phase = "away"; state.director.reason = "Исследует дальние края"; }
      else { travel.requested = false; releaseClearingPoint(state.clearing); }
    }
    return true;
  }
  if (travel.phase === "away") return true;
  if (outside.unavailable && !finished) { state.director.reason = "Дальняя вылазка: безопасный выход с карты недоступен"; return true; }
  if (still) { state.director.reason = "Дальняя вылазка: движение приостановлено"; return true; }
  const target = travel.phase === "leaving" ? outside.entry : travel.home;
  if (isClearingAtPoint(state.clearing, target)) {
    if (travel.phase === "leaving") { outside.crossing = "out"; outside.phaseAt = state.director.elapsed; }
    else {
      releaseClearingPoint(state.clearing); state.director.reason = "Вернулся из дальней вылазки";
      state.director.nextDecisionAt = state.director.elapsed + 7;
      if (same && active && travel.cancelled) outside.completed = true;
      else { state.journeyTravel = undefined; state.explorationId = null; }
    }
    return true;
  }
  if (travel.requested && (!state.clearing.requestedPoint || distance(state.clearing.requestedPoint, target) > .001)) travel.requested = false;
  if (!travel.requested && state.director.elapsed >= (outside.retryAt ?? 0)) {
    travel.requested = requestClearingPoint(state.clearing, target);
    outside.retryAt = state.director.elapsed + 1;
    if (!travel.requested && state.clearing.behavior.reason === "requested-point-unreachable") outside.unavailable = true;
  }
  state.director.reason = travel.phase === "leaving" ? "Идёт к краю леса" : "Возвращается из дальней вылазки домой";
  return true;
}
