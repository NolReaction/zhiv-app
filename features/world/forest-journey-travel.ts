import { clearingActivityFrame, isClearingAtPoint, releaseClearingPoint, requestClearingOutside, requestClearingPoint } from "./clearing-activity";
import { economyJourneyAway, type EconomySceneJourney } from "./economy-scene-state";
import { cancelForestDirector } from "./forest-director";
import { fishingActionFrame, fishingCastTarget, fishingCleanupEnd, fishingDirection, fishingWaterTarget, forestFishingCatchState, type ForestFishingFrame } from "./forest-fishing";
import type { ForestSessionState } from "./forest-session";
import { forestTrailDestination } from "./forest-trails";
import { isWalkable } from "./navigation";
import type { FixedWorldScene, WorldPoint } from "./tiled/types";
import { fishSpeciesId, type FishSpeciesId } from "./fish-species";
import { MINING_PORTAL_SECONDS } from "./forest-mining";
import { forestJobFishingPlan, forestJobFishingFrame, forestJobFishingCleanup, type ForestJobFishingPlan } from "./forest-job-fishing";

export type ForestJourneyTravel = {
  jobId: string;
  finishesAt: number;
  cancelled?: boolean;
  phase: "leaving" | "fishing" | "entering" | "working" | "exiting" | "away" | "returning";
  shore: WorldPoint;
  home: WorldPoint;
  beganAt: number;
  requested: boolean;
  scene: FixedWorldScene;
  waterTarget?: WorldPoint;
  fishingAt?: number;
  carryingFish?: boolean;
  basketSpecies?: FishSpeciesId;
  rodId?: string;
  catchSpecies?: FishSpeciesId;
  mining?: { entry: WorldPoint; doorway: WorldPoint; workCue: WorldPoint; phaseAt: number; prepared: boolean };
  jobFishing?: ForestJobFishingPlan;
  jobStartedAt?: number;
  jobAge?: number;
  fishBeganAge?: number;
  /** A server deadline/removal stops ownership immediately, while the visible
   * catch and tackle finish on the shared scene clock before walking away. */
  ending?: { settleAt: number; endsAt: number; source: ForestFishingFrame; finishAge: number };
};
const shoreRoutes = new Set(["shore", "shore_camp"]);
const mineRoutes = new Set(["cave", "deep_cave", "abandoned_quarry", "quarry_work"]);
const distance = (a: WorldPoint, b: WorldPoint) => Math.hypot(a.x - b.x, a.y - b.y);

export const forestJourneyWalking = (state: ForestSessionState) => state.journeyTravel?.phase === "leaving" || state.journeyTravel?.phase === "returning";
export const forestJourneyEnding = (state: ForestSessionState) => Boolean(state.journeyTravel?.ending
  || state.journeyTravel?.mining && (state.journeyTravel.phase==="entering" || state.journeyTravel.phase==="exiting"));

/** Economic time owns rewards. Local shore/mine trips retain their physical
 * walker; the mine hides its body only after the portal crossing completes. */
export function forestJourneyActorAway(state: ForestSessionState, journey: EconomySceneJourney | null | undefined, now: number) {
  const travel = state.journeyTravel;
  return economyJourneyAway(journey, now)
    && !travel?.ending
    && !(travel?.phase === "returning" || travel?.mining && travel.phase === "exiting")
    && !(travel?.jobId === journey?.id && (travel?.phase === "leaving" || travel?.phase === "fishing" || travel?.phase === "entering" || travel?.phase === "exiting"
      || travel?.cancelled));
}

/** Mine work is a local portal, not a new navigation corridor through rock. */
function syncMiningTravel(state: ForestSessionState, scene: FixedWorldScene, journey: EconomySceneJourney | null | undefined,
  now: number, still: boolean, cancelled: readonly string[]) {
  const active = economyJourneyAway(journey, now), miningJob = active && mineRoutes.has(journey?.routeId ?? "");
  if (!miningJob && !state.journeyTravel?.mining) return false;
  const id = miningJob ? journey!.id : null;
  let travel = state.journeyTravel;
  // A new assignment in reduced motion switches to its own static scene;
  // otherwise a frozen return from the old job would block it indefinitely.
  if (still && active && travel?.mining && journey?.id !== travel.jobId) {
    state.journeyTravel = undefined; state.explorationId = null; travel = undefined;
    releaseClearingPoint(state.clearing);
  }
  if (travel?.mining && travel.phase === "away" && travel.jobId !== id) {
    state.journeyTravel = undefined; travel = undefined;
  }
  if (id && travel?.jobId !== id && !travel?.mining) {
    const place = forestTrailDestination(scene, "quarry"), site = scene.sites.find(site => site.id === "quarry");
    // A freshly confirmed job can reach a newly mounted camera before it has
    // observed the idle snapshot. Such a job still departs visibly from base.
    const age = Math.max(0, (now - Date.parse(journey!.startedAt)) / 1000);
    const restoring = still || state.explorationId === undefined && age > 15;
    state.explorationId = id;
    cancelForestDirector(state, "Отправился в шахту"); state.reaction=0; state.animation=null;
    if (!place || !site?.doorway || !state.clearing.navigation || !isWalkable(state.clearing.navigation, place)
      || state.life.garden.basket?.held) { state.journeyTravel=undefined; return true; }
    travel = { jobId:id, finishesAt:Date.parse(journey!.finishesAt), phase:"leaving", shore:place,
      home:{...state.clearing.home}, beganAt:state.clearing.elapsed, requested:false, scene,
      mining:{ entry:{...site.entry}, doorway:{...site.doorway},
        workCue:{x:site.anchor.x,y:site.bounds.y-state.clearing.size*.12},phaseAt:state.director.elapsed,
        prepared:restoring || isClearingAtPoint(state.clearing,state.clearing.home) } };
    state.journeyTravel=travel;
    if (restoring) { restoreAtShore(state,place); travel.phase="working"; }
    else requestClearingOutside(state.clearing);
  }
  if (!travel?.mining) return miningJob;
  if(travel.phase==="away") {
    if(!active) { state.journeyTravel=undefined; state.explorationId=null; releaseClearingPoint(state.clearing); }
    return true;
  }
  if (travel.scene!==scene) {
    const place=forestTrailDestination(scene,"quarry"), site=scene.sites.find(site=>site.id==="quarry");
    if(!place || !site?.doorway) { travel.phase="away"; return true; }
    travel.scene=scene; travel.shore=place; travel.mining.entry={...site.entry}; travel.mining.doorway={...site.doorway};
    travel.mining.workCue={x:site.anchor.x,y:site.bounds.y-state.clearing.size*.12};
  }
  const mine=travel.mining;
  if (cancelled.includes(travel.jobId) || !active && !journey && now<travel.finishesAt) travel.cancelled=true;
  const finished = !miningJob || journey?.id !== travel.jobId || travel.cancelled;
  if (finished) {
    state.explorationId=active && travel.cancelled ? travel.jobId : null;
    if (travel.phase === "working") {
      // There is no portal motion to resume in reduced motion. Its actual
      // feet already occupy the safe outdoor marker; reveal that static body.
      travel.phase=still ? "returning" : "exiting"; mine.phaseAt=state.director.elapsed;
      if(still) { travel.requested=false; releaseClearingPoint(state.clearing); }
    }
    else if (travel.phase === "entering") {
      const progress=Math.max(0,Math.min(1,(state.director.elapsed-mine.phaseAt)/MINING_PORTAL_SECONDS));
      travel.phase="exiting"; mine.phaseAt=state.director.elapsed-(1-progress)*MINING_PORTAL_SECONDS;
    } else if (travel.phase === "leaving") { travel.phase="returning"; travel.requested=false; travel.beganAt=state.clearing.elapsed; releaseClearingPoint(state.clearing); }
  }
  if (still) { state.director.reason=travel.phase==="working" ? "Работает внутри шахты" : "Шахтная вылазка — движение приостановлено"; return true; }
  if (travel.phase==="entering" || travel.phase==="exiting") {
    if (state.director.elapsed-mine.phaseAt>=MINING_PORTAL_SECONDS-1e-9) {
      if (travel.phase==="entering") travel.phase="working";
      else { travel.phase="returning"; travel.requested=false; travel.beganAt=state.clearing.elapsed; releaseClearingPoint(state.clearing); }
    }
    return true;
  }
  if (travel.phase==="working") { state.director.reason="Работает внутри шахты"; return true; }
  const target=travel.phase==="leaving" && mine.prepared ? travel.shore : travel.home;
  if (isClearingAtPoint(state.clearing,target)) {
    if (travel.phase==="leaving" && !mine.prepared) {
      // Walk home first to collect the helmet and pickaxe. Never reset the
      // actual feet to the spawn or cut through a porch/bush interaction.
      mine.prepared=true; travel.requested=false; travel.beganAt=state.clearing.elapsed;
      releaseClearingPoint(state.clearing); state.director.reason="Взял каску и кирку у дома";
    }
    else if (travel.phase==="leaving") { travel.phase="entering"; mine.phaseAt=state.director.elapsed; state.director.reason="Заходит внутрь шахты"; }
    else {
      // Keep a cancelled receipt fenced until the authoritative snapshot drops
      // the job. Repeated cameras must not send the same miner back inside.
      if(travel.cancelled && active && journey?.id===travel.jobId) { travel.phase="away"; travel.mining=undefined; }
      else state.journeyTravel=undefined;
      releaseClearingPoint(state.clearing); state.director.reason="Вернулся из шахты"; state.director.nextDecisionAt=state.director.elapsed+7;
    }
    return true;
  }
  if (travel.requested && (!state.clearing.requestedPoint || distance(state.clearing.requestedPoint,target)>.001)) travel.requested=false;
  if (!travel.requested) travel.requested=requestClearingPoint(state.clearing,target);
  if (!travel.requested && state.clearing.behavior.reason==="requested-point-unreachable"
    || state.clearing.elapsed-travel.beganAt>120) {
    releaseClearingPoint(state.clearing); travel.phase="away"; return true;
  }
  state.director.reason=travel.phase==="leaving" ? mine.prepared ? "Идёт от дома к шахте с каской и киркой" : "Возвращается к дому за каской и киркой" : "Возвращается из шахты домой";
  return true;
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
  travel.fishBeganAge=travel.jobAge ?? 0;
  state.clearing.direction = fishingDirection(travel.shore, travel.waterTarget);
  state.director.reason = travel.waterTarget ? "Ловит рыбу на берегу" : "Отдыхает на берегу — безопасного места для заброса нет";
}

function fishingFrameAt(state: ForestSessionState, scene: FixedWorldScene, travel: ForestJourneyTravel,
  age: number, still = false): ForestFishingFrame {
  const action = travel.jobFishing ? forestJobFishingFrame(travel.jobFishing,age,travel.fishBeganAge ?? 0,still)
    : fishingActionFrame(age, still, travel.catchSpecies);
  return { ...state.clearing.position, size: state.clearing.size,
    direction: fishingDirection(travel.shore, travel.waterTarget),
    ...(travel.waterTarget ? action : { action: "rest" as const, phase: 0, frame: 0, carryingFish: false }),
    ...(travel.waterTarget ? { waterTarget: fishingCastTarget(scene, travel.waterTarget, state.clearing.size, action.castIndex ?? 0) } : {}),
    rodId: travel.rodId };
}

function beginFishingEnd(state: ForestSessionState, scene: FixedWorldScene, travel: ForestJourneyTravel) {
  const age = travel.jobFishing ? travel.jobAge ?? 0 : Math.max(0, state.director.elapsed - (travel.fishingAt ?? state.director.elapsed));
  const cleanup = travel.jobFishing ? forestJobFishingCleanup(travel.jobFishing,age) : fishingCleanupEnd(age), finishAge = cleanup ?? age;
  const settleAt = state.director.elapsed + Math.max(0, finishAge - age);
  travel.ending = { settleAt, endsAt: settleAt + (cleanup === undefined ? .6 : .4), finishAge,
    // Across repeated cycles modulo rounding can sample pack(1) just before
    // rest(0); choose the unambiguous completed side of that same boundary.
    source: fishingFrameAt(state, scene, travel, finishAge + (cleanup === undefined ? 0 : 1e-9)) };
  state.director.reason = travel.cancelled ? "Убирает снасти после отмены вылазки" : "Убирает снасти перед возвращением";
}

function preservePackedCatch(travel: ForestJourneyTravel, frame: ForestFishingFrame) {
  travel.carryingFish = Boolean(!travel.cancelled && travel.waterTarget && frame.basketFilled);
  travel.basketSpecies = travel.carryingFish ? frame.basketSpecies : undefined;
}

/** Detached frame shares the session clock, actual feet and authored water.
 * Rest is the truthful fallback if a map has no usable water near its marker. */
export function forestJourneyFishingFrame(state: ForestSessionState, scene: FixedWorldScene, still = false): ForestFishingFrame | null {
  const travel = state.journeyTravel;
  if (!travel || travel.mining || travel.scene !== scene || state.life.garden.basket?.held) return null;
  if (forestJourneyWalking(state)) {
    const body = clearingActivityFrame(state.clearing, { still });
    if (body.residing || body.homeSleeping || body.bush?.occupied || body.opacity < 1) return null;
    return { ...state.clearing.position, size: state.clearing.size, direction: body.direction,
      action: body.pose === "walk" ? "walk" : "idle", phase: 0, frame: body.frame,
      carryingFish: Boolean(travel.carryingFish), basketSpecies: travel.basketSpecies, rodId: travel.rodId };
  }
  if (travel.phase !== "fishing" || !isClearingAtPoint(state.clearing, travel.shore)) return null;
  const ending = travel.ending;
  if (ending && state.director.elapsed >= ending.settleAt) {
    const phase = still ? 1 : Math.max(0, Math.min(1, (state.director.elapsed - ending.settleAt) / (ending.endsAt - ending.settleAt)));
    return { ...ending.source, action: "rest", phase: 1, frame: 0, waterTarget: undefined,
      settling: { from: ending.source, phase } };
  }
  return fishingFrameAt(state, scene, travel,
    ending ? ending.finishAge-Math.max(0,ending.settleAt-state.director.elapsed)
      : travel.jobFishing ? travel.jobAge ?? 0 : state.director.elapsed - (travel.fishingAt ?? state.director.elapsed), still);
}

/** Session-local cosmetic travel. Job ownership/deadlines never enter memory,
 * inventory or rewards. Reloading an ongoing shore job restores its visible
 * fishing place; newly confirmed jobs use the existing collision-safe walker. */
export function syncForestJourneyTravel(state: ForestSessionState, scene: FixedWorldScene,
  journey: EconomySceneJourney | null | undefined, now: number, still: boolean, cancelledExplorations: readonly string[] = []) {
  // A background quarry job can become visible as soon as a fishing receipt
  // is claimed/cancelled. Let its already visible catch, tackle and walk home
  // finish before the miner takes over the same physical actor.
  const previousTravel = state.journeyTravel;
  if (!still && mineRoutes.has(journey?.routeId ?? "") && previousTravel && !previousTravel.mining && previousTravel.phase !== "away") journey = null;
  if (syncMiningTravel(state,scene,journey,now,still,cancelledExplorations)) return;
  const active = economyJourneyAway(journey, now), id = active ? journey!.id : null;
  const observed = state.explorationId !== undefined, previous = state.explorationId;
  const current = state.journeyTravel;
  // The first ending frame must equal the last painted one, including a clock
  // correction/claim/cancel. Missed wall-time catch windows are never replayed.
  if (current?.jobFishing && current.jobStartedAt !== undefined && !current.ending && active && id===current.jobId
    && !cancelledExplorations.includes(current.jobId) && !current.cancelled)
    current.jobAge=Math.max(0,(now-current.jobStartedAt)/1000);
  if (current && (cancelledExplorations.includes(current.jobId)
    || !active && !journey && now < current.finishesAt && !current.jobId.startsWith("dev-fishing:"))) {
    // A confirmed removal before its deadline forfeits the trip on every view.
    // Local cancellation receipts also cover ready jobs already walking home.
    current.cancelled = true; current.carryingFish = false; current.basketSpecies = undefined;
  }
  let cleaned = false;
  if (current?.ending) {
    // Sampling another camera or receiving the same snapshot cannot restart
    // the gesture. Pausing freezes director.elapsed and therefore this ending.
    if (!still && current.scene === scene && state.director.elapsed < current.ending.endsAt) return;
    preservePackedCatch(current, current.ending.source);
    current.ending = undefined; cleaned = true;
  }
  if (current?.phase === "fishing" && !cleaned && (current.cancelled || id !== previous && Boolean(previous))
    && !still && current.scene === scene && current.waterTarget && isClearingAtPoint(state.clearing, current.shore)) {
    beginFishingEnd(state, scene, current); return;
  }
  if (current?.cancelled && id === previous && !current.ending && current.phase === "fishing") {
    // A local cancellation receipt may precede the next account snapshot.
    // Its actor still returns visibly instead of becoming an off-map job.
    current.phase = "returning"; current.requested = false; current.beganAt = state.clearing.elapsed;
    releaseClearingPoint(state.clearing); requestClearingOutside(state.clearing);
  }
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
        const travel: ForestJourneyTravel = { jobId: id, finishesAt: Date.parse(journey!.finishesAt), phase: "leaving", shore,
          home: { ...state.clearing.home }, beganAt: state.clearing.elapsed, requested: false,
          ...(journey!.fishing ? { rodId: journey!.fishing.rodId, catchSpecies: fishSpeciesId(journey!.fishing.fishId) } : {}),
          ...(!id.startsWith("dev-fishing:") ? {jobFishing:forestJobFishingPlan(journey!),jobStartedAt:Date.parse(journey!.startedAt),
            jobAge:Math.max(0,(now-Date.parse(journey!.startedAt))/1000)} : {}),
          scene, waterTarget: fishingWaterTarget(scene, shore, state.clearing.size) };
        state.journeyTravel = travel;
        if (restoring) { restoreAtShore(state, shore); beginFishing(state, travel); }
        else requestClearingOutside(state.clearing);
      } else state.journeyTravel = undefined;
    } else if (previous) {
      const travel = state.journeyTravel;
      if (travel && !still && distance(state.clearing.position, travel.home) > .5) {
        if (!cleaned) travel.carryingFish = Boolean(!travel.cancelled && travel.waterTarget && travel.fishingAt !== undefined
          && (travel.jobFishing ? forestJobFishingFrame(travel.jobFishing,travel.jobAge ?? 0,travel.fishBeganAge ?? 0).basketFilled
            : forestFishingCatchState(state.director.elapsed - travel.fishingAt).packed > 0));
        if (!cleaned && travel.carryingFish) {
          const catchFrame = travel.jobFishing ? forestJobFishingFrame(travel.jobFishing,travel.jobAge ?? 0,travel.fishBeganAge ?? 0)
            : fishingActionFrame(state.director.elapsed - travel.fishingAt!, false);
          travel.basketSpecies = catchFrame.basketSpecies;
        }
        travel.phase = "returning"; travel.requested = false; travel.beganAt = state.clearing.elapsed;
        releaseClearingPoint(state.clearing); requestClearingOutside(state.clearing);
      } else {
        state.journeyTravel = undefined; releaseClearingPoint(state.clearing);
      }
      state.clearing.idleSeconds = 0;
      state.director.reason = travel?.cancelled ? "Вылазка отменена — возвращается без добычи" : "Вернулся из исследования";
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
      state.director.reason = travel.cancelled ? "Вернулся домой без добычи" : "Вернулся домой с берега"; state.director.nextDecisionAt = state.director.elapsed + 7;
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
  state.director.reason = travel.phase === "leaving" ? "Идёт по тропинке к берегу"
    : travel.cancelled ? "Возвращается с берега без добычи" : "Возвращается с берега домой";
}
