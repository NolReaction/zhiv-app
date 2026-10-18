import { clearingActivityFrame, isClearingAtPoint, releaseClearingPoint, requestClearingOutside, requestClearingPoint } from "@/features/world/simulation/clearing-activity";
import { cancelForestDirector } from "@/features/world/simulation/forest-director";
import { forestTrailDestination } from "@/features/world/navigation/forest-trails";
import { isWalkable } from "@/features/world/navigation/navigation";
import { economyJourneyAway, type EconomySceneJourney } from "@/features/world/state/economy/economy-scene-state";
import type { ForestSessionState } from "@/features/world/state/forest-session";
import type { FixedWorldScene, WorldPoint } from "@/features/world/tiled/types";
import { GATHERING_PACK_SECONDS, GATHERING_SETDOWN_SECONDS, gatheringGesture, gatheringSeed, gatheringStow, isForestSupplyRoute, type ForestGatheringFrame, type GatheringGesture } from "./forest-gathering";

export type ForestSupplyTravel = { seed: number; phaseAt: number; filled: boolean; stowing?: GatheringGesture; stowLift?: number; released?: boolean };
const distance=(a:WorldPoint,b:WorldPoint)=>Math.hypot(a.x-b.x,a.y-b.y);

/** Restoring an already underway job before its first paint is different from
 * moving a visible actor. Every later displacement uses clearing navigation. */
function restoreSupplyFeet(state: ForestSessionState, point: WorldPoint) {
  Object.assign(state.clearing,{position:{...point},stage:"clearing",stageElapsed:0,distance:0,speed:0,
    routeKind:"clearing",routeIndex:-1,freeRoute:null,freePurpose:null,activeInteraction:null,
    requestedPoint:{...point},steps:[],doorProgress:0,waking:false,wakeOnExit:false,
    bushProgress:0,bushWake:false,bushLeaving:false,bushRequested:false,pendingBush:null,
    pendingInteractionBush:null,returnToSpawn:false,exitAttention:null,attentionResume:null,
    retiring:false,idleSeconds:0});
}

export function forestJourneyGatheringFrame(state: ForestSessionState, scene: FixedWorldScene, still=false): ForestGatheringFrame|null {
  const travel=state.journeyTravel, supply=travel?.gathering;
  if (!travel || !supply || travel.scene!==scene || travel.phase==="away") return null;
  const body=clearingActivityFrame(state.clearing,{still}), walking=travel.phase==="leaving"||travel.phase==="returning";
  if(body.residing||body.homeSleeping||body.bush?.occupied||body.opacity<1) return null;
  const age=Math.max(0,state.director.elapsed-supply.phaseAt);
  let gesture=travel.phase==="packing"&&supply.stowing
    ? gatheringStow(supply.stowing,still?0:state.director.elapsed-supply.phaseAt)
    : gatheringGesture(Math.max(0,age-GATHERING_SETDOWN_SECONDS),supply.seed,still);
  const working=travel.phase==="gathering"||travel.phase==="packing";
  const setdown=travel.phase==="gathering"&&age<GATHERING_SETDOWN_SECONDS&&!still;
  const lift=travel.phase==="packing" ? (supply.stowLift??0)+(1-(supply.stowLift??0))*Math.max(0,Math.min(1,(gesture.progress-.55)/.45))
    : setdown?1-age/GATHERING_SETDOWN_SECONDS:working?0:1;
  if(setdown)gesture={...gesture,action:"setdown",progress:age/GATHERING_SETDOWN_SECONDS,direction:"right",crouch:2*Math.sin(age/GATHERING_SETDOWN_SECONDS*Math.PI),lean:0,itemVisible:false};
  const held=!working||lift>0, size=state.clearing.size;
  if(held)gesture={...gesture,hand:{x:.37,y:-.16*lift-.32*.82}};
  return {...gesture,x:body.x,y:body.y,size,held,filled:!travel.cancelled&&supply.filled,
    pose:walking ? body.pose : "idle",frame:still?0:body.frame,
    ...(walking ? {action:"walk" as const,direction:body.direction,itemVisible:false,crouch:0,lean:0}
      : travel.phase==="ready" ? {action:"ready" as const,itemVisible:false,crouch:0,lean:0} : {}),
    basket:{x:body.x+size*.37,y:body.y-size*.16*lift,size:size*.32}};
}

/** Returns true only while this specific supply assignment owns presentation.
 * Deadlines/removal are read from the account snapshot; no commands are sent. */
export function syncForestSupplyJourney(state: ForestSessionState, scene: FixedWorldScene,
  journey: EconomySceneJourney|null|undefined, now:number, still:boolean, cancelled:readonly string[]):boolean {
  const supplyJob=isForestSupplyRoute(journey?.routeId), active=economyJourneyAway(journey,now);
  let travel=state.journeyTravel;
  if (!supplyJob&&!travel?.gathering) return false;
  if (supplyJob&&cancelled.includes(journey!.id)&&!travel?.gathering) return true;
  if (supplyJob&&travel?.jobId!==journey!.id && (!travel||travel.phase==="ready"||travel.phase==="returning"||travel.phase==="away")) {
    const place=forestTrailDestination(scene,"foraging");
    if (!place||!state.clearing.navigation||!isWalkable(state.clearing.navigation,place)||state.life.garden.basket?.held) return false;
    const firstObservation=state.explorationId===undefined, age=Math.max(0,(now-Date.parse(journey!.startedAt))/1000);
    cancelForestDirector(state,"Отправился за лесными припасами"); state.reaction=0;state.animation=null;
    travel={jobId:journey!.id,finishesAt:Date.parse(journey!.finishesAt),phase:active?"leaving":"ready",shore:place,
      home:{...state.clearing.home},beganAt:state.clearing.elapsed,requested:false,scene,
      gathering:{seed:gatheringSeed(journey!.id),phaseAt:state.director.elapsed,filled:!active}};
    state.journeyTravel=travel;state.explorationId=journey!.id;
    if (active&&firstObservation&&(age>15||still)) {
      restoreSupplyFeet(state,place);travel.phase="gathering";
      travel.gathering!.phaseAt=state.director.elapsed-GATHERING_SETDOWN_SECONDS-age%28;
    } else if(active) requestClearingOutside(state.clearing);
  }
  if(!travel?.gathering) return false;
  const supply=travel.gathering, same=supplyJob&&journey?.id===travel.jobId;
  if(supply.released) {
    if(!same) {state.journeyTravel=undefined;state.explorationId=null;return !active;}
    return true;
  }
  const removedEarly=!journey&&now<travel.finishesAt;
  if(cancelled.includes(travel.jobId)||removedEarly) {travel.cancelled=true;supply.filled=false;}
  if(travel.scene!==scene) {
    const place=forestTrailDestination(scene,"foraging");
    if(!place||!state.clearing.navigation||!isWalkable(state.clearing.navigation,place)) {travel.phase="away";return true;}
    travel.scene=scene;travel.shore=place;releaseClearingPoint(state.clearing);travel.requested=false;
    if(travel.phase==="gathering") {travel.phase="leaving";travel.beganAt=state.clearing.elapsed;}
  }
  if(travel.phase==="away") {if(!same||!active) state.journeyTravel=undefined;return true;}
  const finished=!same||!active||travel.cancelled;
  if(travel.phase==="gathering") {
    if(state.director.elapsed-supply.phaseAt>=GATHERING_SETDOWN_SECONDS+19) supply.filled=!travel.cancelled;
    if(finished) {
      const source=forestJourneyGatheringFrame(state,scene,still);
      supply.stowing=source??undefined;
      supply.stowLift=source?Math.max(0,Math.min(1,(source.y-source.basket.y)/(source.size*.16))):0;
      supply.phaseAt=state.director.elapsed;
      travel.phase=still?"returning":"packing";travel.requested=false;
      if(still) releaseClearingPoint(state.clearing);
    }
  } else if(finished&&travel.phase==="leaving") {
    travel.phase="returning";travel.requested=false;travel.beganAt=state.clearing.elapsed;releaseClearingPoint(state.clearing);
  }
  if(travel.phase==="packing"&&(still||state.director.elapsed-supply.phaseAt>=GATHERING_PACK_SECONDS)) {
    travel.phase="returning";travel.requested=false;travel.beganAt=state.clearing.elapsed;releaseClearingPoint(state.clearing);
  }
  // A newly accepted assignment starts at the real current feet. It need not
  // wait for an obsolete cosmetic journey all the way back to the house.
  if(!same&&active&&travel.phase==="returning") {
    state.journeyTravel=undefined;state.explorationId=null;releaseClearingPoint(state.clearing);
    return supplyJob ? syncForestSupplyJourney(state,scene,journey,now,still,cancelled) : false;
  }
  if((travel.phase==="returning"||travel.phase==="ready")&&(state.pendingLife||state.life.garden.harvest)) {
    supply.released=true;travel.phase="away";releaseClearingPoint(state.clearing);return true;
  }
  if(travel.phase==="ready") {
    state.director.reason="Припасы готовы — можно получить результат вылазки";
    if(!same||travel.cancelled) {
      state.journeyTravel=undefined;state.explorationId=null;releaseClearingPoint(state.clearing);
      if(!same&&active)return false;
    }
    return true;
  }
  if(travel.phase==="gathering"||travel.phase==="packing") {
    state.director.reason=travel.phase==="packing" ? "Укладывает корзинку перед возвращением" : "Ищет, подбирает и складывает лесные припасы";
    return true;
  }
  if(still) {state.director.reason=travel.cancelled?"Вылазка отменена — движение приостановлено":"За припасами — движение приостановлено";return true;}
  const target=travel.phase==="leaving"?travel.shore:travel.home;
  if(isClearingAtPoint(state.clearing,target)) {
    releaseClearingPoint(state.clearing);travel.requested=false;
    if(travel.phase==="leaving") {travel.phase="gathering";supply.phaseAt=state.director.elapsed;}
    else if(same&&!travel.cancelled) {travel.phase="ready";supply.filled=true;}
    else {state.journeyTravel=undefined;state.explorationId=null;state.director.nextDecisionAt=state.director.elapsed+7;}
    return true;
  }
  if(travel.requested&&(!state.clearing.requestedPoint||distance(state.clearing.requestedPoint,target)>.001))travel.requested=false;
  if(!travel.requested)travel.requested=requestClearingPoint(state.clearing,target);
  // An edited/unreachable route may never force a cosmetic position write.
  if(!travel.requested&&state.clearing.behavior.reason==="requested-point-unreachable"||state.clearing.elapsed-travel.beganAt>120) {
    releaseClearingPoint(state.clearing);travel.phase="away";
  }
  state.director.reason=travel.phase==="leaving"?"Идёт в лес за припасами":travel.cancelled?"Возвращается из леса без припасов":"Возвращается с лесными припасами";
  return true;
}
