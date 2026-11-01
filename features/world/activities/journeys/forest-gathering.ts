import type { PixelDirection, PixelPose } from "@/features/mochlik/pixel-sprite";
import type { WorldPoint } from "@/features/world/tiled/types";

/** Woodland gathering uses the shared garden basket. Coastal digging and
 * distant journeys are selected separately by the presentation controller. */
export const isForestSupplyRoute = (route: string | undefined) => route === "forest" || route === "old_woodland";
export type GatheringAction = "look" | "search" | "pick" | "lift" | "pack" | "rest" | "walk" | "ready" | "setdown" | "dig" | "shake";
export type GatheringGesture = {
  action: GatheringAction; progress: number; crouch: number; lean: number;
  hand: WorldPoint; item: "twig" | "stone" | "fiber"; itemVisible: boolean; direction: PixelDirection;
  tool?: "basket" | "shovel";
  /** Tool endpoints in hero-size units; both paws follow this same shaft. */
  shovel?: { handle: WorldPoint; blade: WorldPoint; soil: number };
};
export type ForestGatheringFrame = GatheringGesture & {
  x: number; y: number; size: number; pose: PixelPose; frame: number;
  held: boolean; filled: boolean; basket: { x: number; y: number; size: number; berries?: number; itemIds?: (string | undefined)[] };
};
export const GATHERING_PACK_SECONDS = 1.2;
export const GATHERING_SETDOWN_SECONDS = 1.2;
const smooth = (n: number) => { const p = Math.max(0, Math.min(1,n)); return p*p*(3-2*p); };
const mix = (a: number,b: number,p: number) => a+(b-a)*smooth(p);

export function gatheringSeed(id: string) {
  let value=0; for (const ch of id) value=(value*31+ch.charCodeAt(0))>>>0;
  return value;
}

/** Small purposeful loops, with long quiet pauses and alternating finds.
 * This never counts inventory: findings on the shared basket are cosmetic. */
export function gatheringGesture(elapsed: number, seed: number, still=false): GatheringGesture {
  const age=Number.isFinite(elapsed) ? Math.max(0,elapsed) : 0;
  const cycle=still?0:Math.floor(age/28), local=age%28;
  const side=(cycle+seed)%2 ? 1 : -1;
  const item=(["twig","fiber","stone"] as const)[(cycle+seed)%3];
  let action: GatheringAction="rest", progress=0,crouch=0,lean=0,hand={x:side*.22,y:-.30},itemVisible=false;
  if (still) return {action:"look",progress:0,crouch:0,lean:0,hand,item,itemVisible:false,direction:side<0?"left":"right"};
  if(local<4) { action="look";progress=local/4;hand={x:side*.20,y:-.35}; }
  else if(local<9) { action="search";progress=(local-4)/5;crouch=mix(0,7,progress);lean=mix(0,side*3,progress);hand={x:mix(side*.20,side*.35,progress),y:mix(-.35,-.08,progress)}; }
  else if(local<12) { action="pick";progress=(local-9)/3;crouch=7;lean=side*3;hand={x:side*(.35+Math.sin(progress*Math.PI)*.025),y:-.08};itemVisible=progress>.58; }
  else if(local<15) { action="lift";progress=(local-12)/3;crouch=mix(7,1,progress);lean=mix(side*3,0,progress);hand={x:mix(side*.35,side*.22,progress),y:mix(-.08,-.34,progress)};itemVisible=true; }
  else if(local<19) { action="pack";progress=(local-15)/4;crouch=mix(1,3,Math.sin(progress*Math.PI));hand={x:mix(side*.22,.37,progress),y:mix(-.34,-.12,progress)};itemVisible=progress<.78; }
  else if(local<22) { action="look";progress=(local-19)/3;crouch=mix(3,0,progress);hand={x:mix(.37,side*.22,progress),y:mix(-.12,-.30,progress)}; }
  return {action,progress,crouch,lean,hand,item,itemVisible,direction:side<0?"left":"right"};
}

type DigKeyframe = { at: number; action: GatheringAction; handle: WorldPoint; blade: WorldPoint; crouch: number; lean: number; soil: number };
const digging: readonly DigKeyframe[] = [
  { at: 0, action: "look", handle: {x:.26,y:-.47}, blade: {x:.45,y:.015}, crouch: 0, lean: 0, soil: 0 },
  { at: 4, action: "dig", handle: {x:.26,y:-.47}, blade: {x:.45,y:.015}, crouch: 0, lean: 0, soil: 0 },
  { at: 7, action: "dig", handle: {x:.23,y:-.40}, blade: {x:.47,y:.025}, crouch: 6, lean: 2, soil: 0 },
  { at: 10, action: "lift", handle: {x:.13,y:-.35}, blade: {x:.49,y:-.035}, crouch: 5, lean: 2.5, soil: 1 },
  { at: 13, action: "shake", handle: {x:.20,y:-.48}, blade: {x:.49,y:-.20}, crouch: 1, lean: 0, soil: 1 },
  { at: 15, action: "setdown", handle: {x:.26,y:-.46}, blade: {x:.58,y:-.20}, crouch: 0, lean: 0, soil: 0 },
  { at: 18, action: "rest", handle: {x:.26,y:-.47}, blade: {x:.45,y:.015}, crouch: 0, lean: 0, soil: 0 },
  { at: 28, action: "look", handle: {x:.26,y:-.47}, blade: {x:.45,y:.015}, crouch: 0, lean: 0, soil: 0 },
];

/** A few slow shovel strokes, then a long inspection pause. The blade touches
 * the ground before lifting; its tiny soil load is presentation, never loot. */
export function coastalGatheringGesture(elapsed: number, seed: number, still=false): GatheringGesture {
  const age = Number.isFinite(elapsed) ? Math.max(0, elapsed) : 0, local = still ? 0 : age % 28;
  const index = Math.max(0, digging.findIndex((frame, i) => i < digging.length - 1 && local >= frame.at && local < digging[i + 1].at));
  const from = digging[index], to = digging[index + 1], progress = (local - from.at) / (to.at - from.at);
  const side = seed % 2 ? -1 : 1;
  const position = (a: WorldPoint, b: WorldPoint) => ({x:side*mix(a.x,b.x,progress),y:mix(a.y,b.y,progress)});
  const handle = position(from.handle, to.handle), blade = position(from.blade, to.blade);
  return { tool:"shovel", action:from.action, progress, crouch:mix(from.crouch,to.crouch,progress),
    lean:side*mix(from.lean,to.lean,progress), hand:handle, item:"stone", itemVisible:false,
    direction:side<0?"left":"right", shovel:{handle,blade,soil:mix(from.soil,to.soil,progress)} };
}

/** Finish the currently displayed gesture without snapping a bent body upright. */
export function gatheringStow(source: GatheringGesture, elapsed: number): GatheringGesture {
  const p=Math.max(0,Math.min(1,elapsed/GATHERING_PACK_SECONDS));
  if (source.tool === "shovel" && source.shovel) {
    const side=source.direction==="left"?-1:1;
    const handle={x:mix(source.shovel.handle.x,side*.27,p),y:mix(source.shovel.handle.y,-.43,p)};
    return {...source,action:"pack",progress:p,crouch:mix(source.crouch,0,p),lean:mix(source.lean,0,p),
      hand:handle,itemVisible:false,shovel:{handle,blade:{x:mix(source.shovel.blade.x,side*.41,p),y:mix(source.shovel.blade.y,-.04,p)},soil:source.shovel.soil*(1-smooth(p))}};
  }
  return {...source,action:"pack",progress:p,crouch:mix(source.crouch,0,p),lean:mix(source.lean,0,p),
    hand:{x:mix(source.hand.x,.37,p/.55),y:mix(source.hand.y,-.32*.82,p/.55)},itemVisible:source.itemVisible&&p<.55};
}
