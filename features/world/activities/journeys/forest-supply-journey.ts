import { baseClearingNavigation, clearingActivityFrame, isClearingAtPoint, releaseClearingPoint, requestClearingOutside, requestClearingPoint, setClearingNavigationObstacle } from "@/features/world/simulation/clearing-activity";
import { cancelForestDirector } from "@/features/world/simulation/forest-director";
import { forestTrailDestination } from "@/features/world/navigation/forest-trails";
import { isWalkable } from "@/features/world/navigation/navigation";
import { economyJourneyAway, type EconomySceneJourney } from "@/features/world/state/economy/economy-scene-state";
import type { ForestSessionState } from "@/features/world/state/forest-session";
import type { FixedWorldScene, WorldPoint } from "@/features/world/tiled/types";
import { gardenBasketFootprint, parkForestGardenBasket } from "@/features/world/activities/garden/forest-garden";
import { GATHERING_PACK_SECONDS, GATHERING_SETDOWN_SECONDS, coastalGatheringGesture, gatheringGesture, gatheringSeed, gatheringStow, isForestSupplyRoute, type ForestGatheringFrame, type GatheringGesture } from "./forest-gathering";

export type ForestSupplyTravel = {
  seed: number; phaseAt: number; frozenAt?: number; filled: boolean; tool: "basket" | "shovel";
  basketStage?: "approach" | "pickup" | "carry" | "deposit" | "returned";
  basketFrom?: WorldPoint; groundBasket?: WorldPoint; keepBasketHeld?: boolean;
  resumeGathering?: boolean; stowing?: GatheringGesture; stowLift?: number; released?: boolean;
};
const distance = (a: WorldPoint, b: WorldPoint) => Math.hypot(a.x - b.x, a.y - b.y);
const unit = (n: number) => Math.max(0, Math.min(1, n));
const mix = (a: WorldPoint, b: WorldPoint, n: number) => { const p = unit(n), t = p * p * (3 - 2 * p); return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }; };
export const isForestLocalSupplyRoute = (route: string | undefined) => isForestSupplyRoute(route) || route === "coastal_deposits";
const destination = (scene: FixedWorldScene, tool: ForestSupplyTravel["tool"]) => forestTrailDestination(scene, tool === "shovel" ? "fishing" : "foraging");

/** Initial hydration may restore the server-owned work place before its first
 * paint. Every later change of feet belongs to the normal navigation walker. */
function restoreSupplyFeet(state: ForestSessionState, point: WorldPoint) {
  Object.assign(state.clearing, { position: { ...point }, stage: "clearing", stageElapsed: 0, distance: 0, speed: 0,
    routeKind: "clearing", routeIndex: -1, freeRoute: null, freePurpose: null, activeInteraction: null,
    requestedPoint: { ...point }, steps: [], doorProgress: 0, waking: false, wakeOnExit: false,
    bushProgress: 0, bushWake: false, bushLeaving: false, bushRequested: false, pendingBush: null,
    pendingInteractionBush: null, returnToSpawn: false, exitAttention: null, attentionResume: null,
    retiring: false, idleSeconds: 0 });
}

export function forestJourneyGatheringFrame(state: ForestSessionState, scene: FixedWorldScene, still = false): ForestGatheringFrame | null {
  const travel = state.journeyTravel, supply = travel?.gathering;
  if (!travel || !supply || travel.scene !== scene || travel.phase === "away" || travel.phase === "ready"
    || supply.basketStage === "approach" || supply.basketStage === "returned") return null;
  const body = clearingActivityFrame(state.clearing, { still });
  if (body.residing || body.homeSleeping || body.bush?.occupied || body.opacity < 1) return null;
  const age = Math.max(0, (supply.frozenAt ?? state.director.elapsed) - supply.phaseAt), walking = travel.phase === "leaving" || travel.phase === "returning";
  const realBasket = state.life.garden.basket;
  const basketSize = realBasket?.size ?? state.clearing.size * .28;
  const carry = { x: body.x + state.clearing.size * .37, y: body.y - state.clearing.size * .16 };
  const ground = supply.groundBasket ?? { x: body.x + state.clearing.size * .37, y: body.y };
  let gesture = travel.phase === "packing" && supply.stowing ? gatheringStow(supply.stowing, still ? 0 : age)
    : supply.tool === "shovel" ? coastalGatheringGesture(age, supply.seed, still)
      : gatheringGesture(Math.max(0, age - GATHERING_SETDOWN_SECONDS), supply.seed, still);
  const working = travel.phase === "gathering" || travel.phase === "packing";
  const setdown = supply.tool === "basket" && travel.phase === "gathering" && age < GATHERING_SETDOWN_SECONDS && !still;
  let held = !working, basketPoint = carry;
  if (supply.tool === "basket") {
    if (supply.basketStage === "pickup") {
      const p = unit(age / GATHERING_SETDOWN_SECONDS);
      basketPoint = mix(supply.basketFrom ?? realBasket?.position ?? ground, carry, p);
      held = p > 0;
      gesture = { ...gesture, action: "setdown", progress: p, crouch: 2 * Math.sin(p * Math.PI), lean: 0, itemVisible: false };
    } else if (supply.basketStage === "deposit") {
      const p = unit(age / GATHERING_SETDOWN_SECONDS);
      basketPoint = mix(supply.basketFrom ?? carry, realBasket?.homePosition ?? ground, p);
      held = p < 1;
      gesture = { ...gesture, action: "setdown", progress: p, crouch: 2 * Math.sin(p * Math.PI), lean: 0, itemVisible: false };
    } else if (setdown) {
      const p = age / GATHERING_SETDOWN_SECONDS; basketPoint = mix(carry, ground, p); held = true;
      gesture = { ...gesture, action: "setdown", progress: p, crouch: 2 * Math.sin(p * Math.PI), lean: 0, itemVisible: false };
    } else if (travel.phase === "packing") {
      const lift = unit((gesture.progress - .55) / .45), from = supply.basketFrom ?? ground;
      basketPoint = mix(from, carry, lift); held = lift > 0 || (supply.stowLift ?? 0) > 0;
    } else if (working) { basketPoint = supply.keepBasketHeld ? carry : ground; held = Boolean(supply.keepBasketHeld); }
    if (held || supply.basketStage === "pickup" || supply.basketStage === "deposit") {
      gesture = { ...gesture, hand: { x: (basketPoint.x - body.x) / state.clearing.size,
        y: (basketPoint.y - basketSize * 12 / 14 - body.y) / state.clearing.size } };
    }
  }
  return { ...gesture, tool: supply.tool, x: body.x, y: body.y, size: state.clearing.size, held,
    filled: !travel.cancelled && supply.filled, pose: walking ? body.pose : "idle", frame: still ? 0 : body.frame,
    ...(walking ? { action: "walk" as const, direction: body.direction, itemVisible: false, crouch: 0, lean: 0 } : {}),
    basket: { ...basketPoint, size: basketSize, berries: realBasket && state.life.garden.production === undefined ? realBasket.berries : 0 } };
}

function ownBasket(state: ForestSessionState) {
  const travel = state.journeyTravel, basket = state.life.garden.basket;
  if (travel?.gathering?.tool === "basket" && basket) {
    basket.journeyOwner = travel.jobId; basket.held = true;
    setClearingNavigationObstacle(state.clearing, null);
  }
}
function syncBasket(state: ForestSessionState, scene: FixedWorldScene, still: boolean) {
  const basket = state.life.garden.basket;
  if (!basket?.journeyOwner) return;
  const frame = forestJourneyGatheringFrame(state, scene, still);
  if (frame?.tool === "basket") { basket.position = { x: frame.basket.x, y: frame.basket.y }; basket.held = frame.held; }
}
function workingBasket(state: ForestSessionState) {
  const basket = state.life.garden.basket, supply = state.journeyTravel?.gathering;
  if (!basket || supply?.tool !== "basket") return;
  // Reuse the garden's tested placement solver, including corridor clearance.
  supply.keepBasketHeld = !parkForestGardenBasket(state.life.garden, state.clearing.position, baseClearingNavigation(state.clearing));
  supply.groundBasket = { ...basket.position };
  basket.held = true;
}
function releaseBasket(state: ForestSessionState, home = false) {
  const basket = state.life.garden.basket;
  if (!basket?.journeyOwner) return;
  delete basket.journeyOwner;
  if (home) { basket.position = { ...basket.homePosition }; basket.approach = { ...basket.homeApproach }; basket.held = false; }
  else parkForestGardenBasket(state.life.garden, state.clearing.position, baseClearingNavigation(state.clearing));
  setClearingNavigationObstacle(state.clearing, gardenBasketFootprint(state.life.garden));
}

/** One assignment borrows the existing berry basket. No second prop, rewards,
 * deadlines or production state are created by this presentation controller. */
export function syncForestSupplyJourney(state: ForestSessionState, scene: FixedWorldScene,
  journey: EconomySceneJourney | null | undefined, now: number, still: boolean, cancelled: readonly string[]): boolean {
  const supplyJob = isForestLocalSupplyRoute(journey?.routeId), active = economyJourneyAway(journey, now);
  let travel = state.journeyTravel;
  if (travel?.outside || !supplyJob && !travel?.gathering) return false;
  if (supplyJob && cancelled.includes(journey!.id) && !travel?.gathering) return true;
  const ordinaryWalk = travel && !travel.gathering && !travel.mining && !travel.ending
    && (travel.phase === "leaving" || travel.phase === "returning");
  if (supplyJob && travel?.jobId !== journey!.id && (!travel || travel.phase === "ready" || travel.phase === "away" || ordinaryWalk)) {
    const tool = journey?.routeId === "coastal_deposits" ? "shovel" : "basket", place = destination(scene, tool);
    if (!place || !state.clearing.navigation || !isWalkable(state.clearing.navigation, place) || tool === "basket" && !state.life.garden.basket) return false;
    const first = state.explorationId === undefined, age = Math.max(0, (now - Date.parse(journey!.startedAt)) / 1000);
    cancelForestDirector(state, tool === "shovel" ? "Отправился к прибрежным отложениям" : "Берёт корзинку для лесных припасов");
    state.reaction = 0; state.animation = null;
    travel = { jobId: journey!.id, finishesAt: Date.parse(journey!.finishesAt), phase: active ? "leaving" : "ready", shore: place,
      home: { ...state.clearing.home }, beganAt: state.clearing.elapsed, requested: false, scene,
      gathering: { seed: gatheringSeed(journey!.id), phaseAt: state.director.elapsed, filled: !active, tool,
        ...(tool === "basket" ? { basketStage: active ? state.life.garden.basket!.held ? "carry" : "approach" : "returned" } : {}) } };
    state.journeyTravel = travel; state.explorationId = journey!.id;
    if (active && first && (age > 15 || still)) {
      restoreSupplyFeet(state, place); travel.phase = "gathering";
      if (tool === "basket") { travel.gathering!.basketStage = "carry"; ownBasket(state); workingBasket(state); }
      travel.gathering!.phaseAt = state.director.elapsed - GATHERING_SETDOWN_SECONDS - age % 28;
    } else if (active) { if (travel.gathering!.basketStage === "carry") ownBasket(state); requestClearingOutside(state.clearing); }
  }
  if (!travel?.gathering) return false;
  const supply = travel.gathering, basket = state.life.garden.basket, same = supplyJob && journey?.id === travel.jobId;
  if (supply.released) { if (!same) { state.journeyTravel = undefined; state.explorationId = null; return !active; } return true; }
  if (cancelled.includes(travel.jobId) || !journey && now < travel.finishesAt) { travel.cancelled = true; supply.filled = false; }
  if (travel.scene !== scene) {
    const place = destination(scene, supply.tool);
    if (!place || !state.clearing.navigation || !isWalkable(state.clearing.navigation, place)) {
      releaseBasket(state); travel.phase = "away"; return true;
    }
    if (travel.phase === "gathering") {
      const source = forestJourneyGatheringFrame(state, travel.scene, still);
      supply.stowing = source ?? undefined; supply.basketFrom = source ? { ...source.basket } : undefined;
      supply.stowLift = source?.held ? 1 : 0; supply.phaseAt = state.director.elapsed;
      supply.resumeGathering = true; travel.phase = "packing";
    }
    travel.scene = scene; travel.shore = place; releaseClearingPoint(state.clearing); travel.requested = false;
  }
  if (travel.phase === "away") { if (!same || !active) { releaseBasket(state); state.journeyTravel = undefined; } return true; }
  const finished = !same || !active || travel.cancelled;
  if (still) supply.frozenAt ??= state.director.elapsed;
  else if (supply.frozenAt !== undefined) { supply.phaseAt += Math.max(0, state.director.elapsed - supply.frozenAt); delete supply.frozenAt; }
  if (still && finished && basket?.journeyOwner === travel.jobId) {
    // Accessibility stops animation, never ownership. Place the one prop at
    // these actual feet so another confirmed assignment can take over.
    releaseBasket(state); supply.basketStage = "returned"; travel.phase = "returning"; travel.beganAt = state.clearing.elapsed;
    travel.requested = false; releaseClearingPoint(state.clearing);
  }
  if (supply.basketStage === "pickup") {
    if (!still && state.director.elapsed - supply.phaseAt >= GATHERING_SETDOWN_SECONDS) {
      supply.basketStage = "carry"; travel.phase = finished ? "returning" : "leaving";
      supply.phaseAt = state.director.elapsed; travel.beganAt = state.clearing.elapsed; travel.requested = false; releaseClearingPoint(state.clearing);
    } else { syncBasket(state, scene, still); return true; }
  }
  if (supply.basketStage === "deposit") {
    if (still || state.director.elapsed - supply.phaseAt >= GATHERING_SETDOWN_SECONDS) {
      releaseBasket(state, true); supply.basketStage = "returned"; travel.phase = "returning"; travel.beganAt = state.clearing.elapsed;
      travel.requested = false; releaseClearingPoint(state.clearing);
    } else { syncBasket(state, scene, still); return true; }
  }
  if (travel.phase === "gathering") {
    if (state.director.elapsed - supply.phaseAt >= GATHERING_SETDOWN_SECONDS + 19) supply.filled = !travel.cancelled;
    if (finished) {
      const source = forestJourneyGatheringFrame(state, scene, still);
      supply.stowing = source ?? undefined; supply.basketFrom = source ? { ...source.basket } : undefined;
      supply.stowLift = source?.held ? 1 : 0; supply.phaseAt = state.director.elapsed;
      travel.phase = still ? "returning" : "packing"; travel.beganAt = state.clearing.elapsed; travel.requested = false;
      if (still) releaseClearingPoint(state.clearing);
    }
  } else if (finished && travel.phase === "leaving") {
    travel.phase = "returning"; travel.requested = false; travel.beganAt = state.clearing.elapsed; releaseClearingPoint(state.clearing);
  }
  if (travel.phase === "packing" && (still || state.director.elapsed - supply.phaseAt >= GATHERING_PACK_SECONDS)) {
    travel.phase = supply.resumeGathering && same && active && !travel.cancelled ? "leaving" : "returning";
    supply.resumeGathering = false; travel.requested = false; travel.beganAt = state.clearing.elapsed; releaseClearingPoint(state.clearing);
  }
  if (!same && active && travel.phase === "returning" && !basket?.journeyOwner) {
    state.journeyTravel = undefined; state.explorationId = null; releaseClearingPoint(state.clearing);
    return supplyJob ? syncForestSupplyJourney(state, scene, journey, now, still, cancelled) : false;
  }
  if ((travel.phase === "returning" || travel.phase === "ready") && (state.pendingLife || state.life.garden.harvest)) {
    // Transfer the same held prop to an explicit harvest, without teleporting it home.
    if (basket?.journeyOwner === travel.jobId) { delete basket.journeyOwner; basket.held = true; setClearingNavigationObstacle(state.clearing, null); }
    supply.released = true; travel.phase = "away"; releaseClearingPoint(state.clearing); return true;
  }
  if (travel.phase === "ready") {
    state.director.reason = "Припасы готовы, можно получить результат вылазки";
    if (!same || travel.cancelled) { state.journeyTravel = undefined; state.explorationId = null; releaseClearingPoint(state.clearing); if (!same && active) return false; }
    return true;
  }
  if (travel.phase === "gathering" || travel.phase === "packing") {
    state.director.reason = supply.tool === "shovel" ? "Осматривает берег и аккуратно копает отложения" : travel.phase === "packing" ? "Поднимает корзинку перед возвращением" : "Ищет и складывает лесные припасы в корзинку";
    syncBasket(state, scene, still); return true;
  }
  if (still) { state.director.reason = "Вылазка: движение приостановлено"; syncBasket(state, scene, true); return true; }
  const target = travel.phase === "leaving" ? supply.basketStage === "approach" && basket ? basket.approach : travel.shore
    : basket?.journeyOwner === travel.jobId ? basket.homeApproach : travel.home;
  if (isClearingAtPoint(state.clearing, target)) {
    releaseClearingPoint(state.clearing); travel.requested = false;
    if (travel.phase === "leaving" && supply.basketStage === "approach" && basket) {
      supply.basketFrom = { ...basket.position }; ownBasket(state); supply.basketStage = "pickup"; travel.phase = "packing"; supply.phaseAt = state.director.elapsed;
    } else if (travel.phase === "leaving") {
      travel.phase = "gathering"; supply.phaseAt = state.director.elapsed; if (supply.tool === "basket") workingBasket(state);
    } else if (basket?.journeyOwner === travel.jobId) {
      supply.basketFrom = forestJourneyGatheringFrame(state, scene)?.basket; supply.basketStage = "deposit";
      travel.phase = "packing"; supply.phaseAt = state.director.elapsed;
    } else if (same && !travel.cancelled) { travel.phase = "ready"; supply.filled = true; }
    else { state.journeyTravel = undefined; state.explorationId = null; state.director.nextDecisionAt = state.director.elapsed + 7; }
    syncBasket(state, scene, still); return true;
  }
  if (travel.requested && (!state.clearing.requestedPoint || distance(state.clearing.requestedPoint, target) > .001)) travel.requested = false;
  if (!travel.requested) travel.requested = requestClearingPoint(state.clearing, target);
  if (!travel.requested && state.clearing.behavior.reason === "requested-point-unreachable" || state.clearing.elapsed - travel.beganAt > 180) {
    releaseClearingPoint(state.clearing); releaseBasket(state); travel.phase = "away";
  }
  state.director.reason = travel.phase === "leaving" ? supply.basketStage === "approach" ? "Идёт за ягодной корзинкой" : supply.tool === "shovel" ? "Несёт лопату к берегу" : "Несёт корзинку в лес"
    : basket?.journeyOwner ? "Возвращает корзинку на место" : travel.cancelled ? "Возвращается без припасов" : "Возвращается с припасами";
  syncBasket(state, scene, still); return true;
}
