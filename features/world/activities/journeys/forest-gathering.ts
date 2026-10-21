import type { PixelDirection, PixelPose } from "@/features/mochlik/pixel-sprite";
import type { WorldPoint } from "@/features/world/tiled/types";

/** These saved exploration targets gather woodland materials. Coastal and
 * upland expeditions deliberately keep their own off-map presentation. */
export const isForestSupplyRoute = (route: string | undefined) => route === "forest" || route === "forest_camp" || route === "old_woodland";
export type GatheringAction = "look" | "search" | "pick" | "lift" | "pack" | "rest" | "walk" | "ready" | "setdown";
export type GatheringGesture = {
  action: GatheringAction; progress: number; crouch: number; lean: number;
  hand: WorldPoint; item: "twig" | "stone" | "fiber"; itemVisible: boolean; direction: PixelDirection;
};
export type ForestGatheringFrame = GatheringGesture & {
  x: number; y: number; size: number; pose: PixelPose; frame: number;
  held: boolean; filled: boolean; basket: { x: number; y: number; size: number };
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
 * This never counts inventory: the basket is a cosmetic expedition prop. */
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

/** Finish the currently displayed gesture without snapping a bent body upright. */
export function gatheringStow(source: GatheringGesture, elapsed: number): GatheringGesture {
  const p=Math.max(0,Math.min(1,elapsed/GATHERING_PACK_SECONDS));
  return {...source,action:"pack",progress:p,crouch:mix(source.crouch,0,p),lean:mix(source.lean,0,p),
    hand:{x:mix(source.hand.x,.37,p/.55),y:mix(source.hand.y,-.32*.82,p/.55)},itemVisible:source.itemVisible&&p<.55};
}
