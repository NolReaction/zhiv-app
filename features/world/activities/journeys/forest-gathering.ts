import type { PixelDirection, PixelPose } from "@/features/mochlik/pixel-sprite";
import type { WorldPoint } from "@/features/world/tiled/types";
import type { ForestGardenVisualFrame } from "@/features/world/activities/garden/forest-garden-painter";

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
  basketActivity?: { phase: "carry" | "pickup" | "deposit" | "collect" | "stow"; elapsed: number;
    from?: WorldPoint; ground: WorldPoint; keepHeld?: boolean; source?: ForestGardenVisualFrame };
};
export const GATHERING_PACK_SECONDS = 1.2;
export const GATHERING_SETDOWN_SECONDS = 1.2;
export const GATHERING_DEPOSIT_SECONDS = 1.5;
export const FORAGING_BASKET_CYCLE = { lowerEnd: .65, pickStart: 3, pickSeconds: 3, liftStart: 7, end: 8.2 } as const;
const smooth = (n: number) => { const p = Math.max(0, Math.min(1,n)); return p*p*(3-2*p); };
const mix = (a: number,b: number,p: number) => a+(b-a)*smooth(p);

export function gatheringSeed(id: string) {
  let value=0; for (const ch of id) value=(value*31+ch.charCodeAt(0))>>>0;
  return value;
}

// The handle is measured at the D-grip; the blade and both hands follow one rigid shaft.
const shovelLength = .72;
const carryAngle = .13;
function shovelPose(handle: WorldPoint, side: number, angle: number, soil: number) {
  return { handle, blade: { x: handle.x + side * Math.cos(angle) * shovelLength,
    y: handle.y + Math.sin(angle) * shovelLength }, soil };
}

export function coastalCarryShovel(side: number) {
  return shovelPose({ x: -side * .18, y: -.255 }, side, carryAngle, 0);
}

type DigKeyframe = { at: number; action: GatheringAction; handle: WorldPoint; angle: number; crouch: number; lean: number; soil: number };
const resting = { handle: { x: -.19, y: -.285 }, angle: .41, crouch: 0, lean: 0, soil: 0 };
const digging: readonly DigKeyframe[] = [
  { at: 0, action: "look", ...resting },
  { at: 4, action: "dig", ...resting },
  { at: 7, action: "dig", handle: { x: -.115, y: -.18 }, angle: .30, crouch: 4, lean: 2, soil: 0 },
  { at: 10, action: "lift", handle: { x: -.15, y: -.20 }, angle: .18, crouch: 3, lean: 2, soil: 1 },
  { at: 13, action: "shake", handle: { x: -.19, y: -.28 }, angle: .08, crouch: 1, lean: 0, soil: 1 },
  { at: 15, action: "setdown", handle: { x: -.13, y: -.24 }, angle: -.10, crouch: 0, lean: 0, soil: 0 },
  { at: 18, action: "rest", ...resting },
  { at: 28, action: "look", ...resting },
];

/** A few slow shovel strokes, then a long inspection pause. The blade touches
 * the ground before lifting; its tiny soil load is presentation, never loot. */
export function coastalGatheringGesture(elapsed: number, seed: number, still=false): GatheringGesture {
  const age = Number.isFinite(elapsed) ? Math.max(0, elapsed) : 0, local = still ? 0 : age % 28;
  const index = Math.max(0, digging.findIndex((frame, i) => i < digging.length - 1 && local >= frame.at && local < digging[i + 1].at));
  const from = digging[index], to = digging[index + 1], progress = (local - from.at) / (to.at - from.at);
  const side = seed % 2 ? -1 : 1;
  const handle = { x: side * mix(from.handle.x, to.handle.x, progress), y: mix(from.handle.y, to.handle.y, progress) };
  return { tool:"shovel", action:from.action, progress, crouch:mix(from.crouch,to.crouch,progress),
    lean:side*mix(from.lean,to.lean,progress), hand:handle, item:"stone", itemVisible:false,
    direction:side<0?"left":"right", shovel:shovelPose(handle, side, mix(from.angle,to.angle,progress), mix(from.soil,to.soil,progress)) };
}

/** Finish the currently displayed gesture without snapping a bent body upright. */
export function coastalGatheringStow(source: GatheringGesture, elapsed: number): GatheringGesture {
  const p=Math.max(0,Math.min(1,elapsed/GATHERING_PACK_SECONDS));
  if (source.tool === "shovel" && source.shovel) {
    const side=source.direction==="left"?-1:1;
    const carry = coastalCarryShovel(side);
    const { handle: grip, blade, soil } = source.shovel;
    const handle = { x: mix(grip.x, carry.handle.x, p), y: mix(grip.y, carry.handle.y, p) };
    const angle = Math.atan2(blade.y - grip.y, side * (blade.x - grip.x));
    const shovel = p === 0 ? source.shovel : p === 1 ? carry : shovelPose(handle, side, mix(angle, carryAngle, p), soil * (1 - smooth(p)));
    return {...source,action:"pack",progress:p,crouch:mix(source.crouch,0,p),lean:mix(source.lean,0,p),
      hand:handle,itemVisible:false,shovel};
  }
  return { ...source, action: "pack", progress: p, itemVisible: false };
}
