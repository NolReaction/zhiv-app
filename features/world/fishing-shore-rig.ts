import type { PixelDirection, PixelPose } from "@/features/mochlik/pixel-sprite";
import { fishingBasketHandle, fishingCatchFrame, fishingPackCenter, fishingReelHand, fishingTackleFrame, fishingLineFrame, projectFishingRod,
  FISHING_PACK_RELEASE, FISHING_REEL_HANDOFF, type FishingPropFrame } from "./fishing-props";
import type { WorldPoint } from "./tiled/types";

const clamp = (t: number) => Math.max(0, Math.min(1, Number.isFinite(t) ? t : 0));
const smooth = (t: number) => { t = clamp(t); return t * t * (3 - 2 * t); };
const mix = (a: WorldPoint, b: WorldPoint, t: number) => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });

/** Two fixed short bones: targets cannot stretch a paw across the torso. */
export function fishingArm(shoulder: WorldPoint, target: WorldPoint, size: number, bendSide: number,
  lengths = { upper: .21, lower: .23 }) {
  const upper = size * lengths.upper, lower = size * lengths.lower;
  const dx = target.x - shoulder.x, dy = target.y - shoulder.y, raw = Math.hypot(dx, dy);
  const distance = Math.max(.001, Math.min(upper + lower - size * .001, Math.max(Math.abs(upper - lower) + .001, raw)));
  const ux = raw > .001 ? dx / raw : bendSide, uy = raw > .001 ? dy / raw : 0;
  const hand = { x: shoulder.x + ux * distance, y: shoulder.y + uy * distance };
  const along = (upper * upper - lower * lower + distance * distance) / (2 * distance);
  const bend = Math.sqrt(Math.max(0, upper * upper - along * along));
  const elbow = { x: shoulder.x + ux * along - uy * bend * bendSide,
    y: shoulder.y + uy * along + ux * bend * bendSide };
  return { shoulder, elbow, hand, reachable: raw <= upper + lower - size * .001 };
}

export type FishingShoreRig = {
  grip: WorldPoint; heldFish: WorldPoint; basket: WorldPoint; basketScale: number;
  rodTip: WorldPoint; rodElevation: number; rodLength: number; castOrigin: WorldPoint; settlingLine?: { bobber: WorldPoint; control: WorldPoint; floatPart: number };
  tautLine: boolean; keepRod: boolean; drawBasket: boolean;
  nearShoulder: WorldPoint; farShoulder: WorldPoint; nearHand: WorldPoint; farHand: WorldPoint;
  nearArm: ReturnType<typeof fishingArm>; farArm: ReturnType<typeof fishingArm>;
  pose: PixelPose; crouch: number; lean: number; phase: number; side: number; traveling: boolean; bodyDirection: PixelDirection; fishingStance: boolean;
};

/** Both residents aim in the ground plane. Height is projected separately;
 * screen-space water below their feet never becomes an arbitrary rightward cast. */
export function fishingShoreRig(frame: FishingPropFrame, still: boolean, style: "mochlik" | "plesk" = "mochlik"): FishingShoreRig {
  const { x, size, action, direction } = frame, phase = still ? .5 : clamp(frame.phase);
  const plesk = style === "plesk";
  const arm = (shoulder: WorldPoint, hand: WorldPoint, bend: number) => fishingArm(shoulder, hand, size, bend,
    plesk ? { upper: .12, lower: .13 } : undefined);
  const walking = action === "walk" && !still;
  const y = frame.y - (walking && frame.frame % 2 ? size / 24 : 0);
  const side = direction === "left" ? -1 : 1;
  const dx = frame.waterTarget ? frame.waterTarget.x - x : side;
  const dy = frame.waterTarget ? frame.waterTarget.y - frame.y : 0;
  const distance = Math.max(.001, Math.hypot(dx, dy)), ux = dx / distance;
  const casting = action === "cast", pulling = action === "reel", packing = action === "pack";
  const preparing = action === "idle" && Boolean(frame.waterTarget) && (!plesk || frame.variation === "check");
  const resting = action === "rest" || plesk && action === "idle" && !preparing;
  const landing = action === "catch" || packing;
  const traveling = action === "walk" || (action === "idle" || action === "rest") && !frame.waterTarget
    || plesk && (action === "greet" || action === "trade") && !frame.waterTarget;
  const castStroke = smooth((phase - .18) / .34), hookSet = action === "bite" ? smooth(phase / .32) : 0;
  const effort = pulling && frame.variation === "struggle" && !still ? Math.sin(phase * Math.PI) * (1 + Math.sin(phase * Math.PI * 6)) / 2 : 0;
  const escape = frame.outcome === "miss", check = frame.variation === "check" ? Math.sin(phase * Math.PI) : 0;
  const handoff = pulling ? smooth((phase - FISHING_REEL_HANDOFF) / (1 - FISHING_REEL_HANDOFF)) : 0;
  const lean = packing ? -side * Math.sin(phase * Math.PI) : casting ? side * (-1 + castStroke * 2)
    : preparing ? -side * smooth(phase) : pulling ? -side * (1 - smooth(phase)) * (1 + effort)
      : action === "bite" ? side * (1 - hookSet * 3 + smooth((phase - .5) / .5)) : action === "fish" ? side : 0;
  const crouch = packing ? Math.round(Math.sin(phase * Math.PI) * 2) : pulling ? Math.round(effort)
    : action === "fish" ? 1 : casting ? Math.round(castStroke) : action === "bite" ? Math.round(1 - hookSet) : 0;
  const bodyOffset = Math.round(lean) * size / 48;
  // Shoulders remain anatomical through all phase buckets, including the end
  // of a waiting/check action. Only the free hand leaves the reel at handoff.
  const nearShoulder = { x: x + bodyOffset + side * size * (plesk ? .16 : .15), y: y - size * (plesk ? .31 : .26) };
  const farShoulder = { x: x + bodyOffset + (plesk ? side * size * .12 : 0), y: y - size * (plesk ? .31 : .26) };
  const gripX = x + size * (side * (plesk ? .23 : .32) + ux * (plesk ? .02 : .05));
  const waiting = { x: gripX, y: y - size * (plesk ? .33 : .29) };
  const raised = { x: gripX + (plesk ? side * size * .045 - ux * size * .035 : -ux * size * .055), y: y - size * (plesk ? .34 : .36) };
  const landed = { x: x + side * size * (plesk ? .18 : .22), y: y - size * (plesk ? .3 : .29) };
  const biteGrip = { x: gripX - side * size * (plesk ? .025 : .045) - ux * size * (plesk ? .02 : .035), y: y - size * (plesk ? .35 : .34) };
  const restingGrip = { x: x + side * size * (plesk ? .18 : .22), y: y - size * (plesk ? .3 : .23) };
  const desiredGrip = traveling ? plesk && action === "greet" ? { x: x + side * size * .2, y: y - size * (.3 + .12 * Math.sin(phase * Math.PI)) } : restingGrip
    : landing ? landed : resting ? mix(landed, restingGrip, smooth(phase / .4))
    : casting ? mix(raised, waiting, castStroke) : preparing ? mix(restingGrip, raised, smooth(phase))
      : pulling ? mix(biteGrip, landed, smooth(phase)) : action === "bite" ? mix(waiting, biteGrip, hookSet)
        : { ...waiting, y: waiting.y - size * check * .015 };
  const nearArm = arm(nearShoulder, desiredGrip, side);
  const grip = nearArm.hand;
  const heldFish = { x: x + side * size * (plesk ? .19 : -.23), y: y - size * (plesk ? .27 : .28) };
  const basketScale = plesk ? .8 : .775;
  const carryingBasket = frame.carryingBasket || frame.carryingFish;
  const basket = { x: x + side * size * (plesk ? traveling ? .23 : .29 : traveling ? -.29 : -.4),
    y: y - size * (plesk ? traveling ? .19 : .144 : traveling ? .15 : .173 * basketScale) };
  if (plesk && action === "trade") {
    const placed = smooth(phase / .2);
    basket.x += side * size * .06 * placed; basket.y += size * .046 * placed;
  }
  const actualFish = packing ? fishingPackCenter(heldFish, basket, size, phase, basketScale) : heldFish;
  if (plesk && packing) {
    // Her basket sits beside the short paws: clear its rim with a low arc,
    // without lifting a large catch back across the muzzle.
    actualFish.y += Math.sin(smooth(phase / FISHING_PACK_RELEASE) * Math.PI) * size * .12;
  }
  let elevation = plesk ? landing ? 1.05 : resting ? 1.05 - .1 * smooth(phase / .4)
    : pulling ? .82 + .23 * smooth(phase) : action === "bite" ? .5 + .32 * hookSet
      : casting ? 1.2 - .7 * castStroke : preparing ? .95 + .25 * smooth(phase) : traveling ? .95 : .5
    : landing ? 1.38 : resting ? 1.38 - .16 * smooth(phase / .4)
    : pulling ? 1.26 + .12 * smooth(phase) : action === "bite" ? 1.08 + .18 * hookSet
      : casting ? 1.42 - .34 * castStroke : preparing ? 1.22 + .2 * smooth(phase) : traveling ? 1.22 : 1.08;
  if (action === "fish" && !still) elevation += check * .045;
  const aimedTip = projectFishingRod(frame, grip, elevation, .96);
  const carriedTip = projectFishingRod({ ...frame, waterTarget: undefined }, grip, elevation, .96);
  const rodTip = resting ? mix(aimedTip, carriedTip, smooth(phase / .4))
    : preparing ? mix(carriedTip, aimedTip, smooth(phase)) : aimedTip;
  const releaseGrip = mix(raised, waiting, smooth((.34 - .18) / .34));
  const releaseTip = projectFishingRod(frame, releaseGrip, (plesk ? 1.2 : 1.42) - (plesk ? .7 : .34) * smooth((.34 - .18) / .34), .96);
  const castOrigin = { x: releaseTip.x, y: releaseTip.y + size * .16 };
  const anchors = { grip, heldFish: actualFish, basket, basketScale, rodTip, rodElevation: elevation, rodLength: .96, castOrigin,
    tautLine: true, keepRod: true, drawBasket: Boolean(frame.waterTarget || carryingBasket) };
  const catchFrame = fishingCatchFrame(frame, still, anchors);
  const relaxed = { x: x + side * size * (plesk ? .1 : -.16), y: y - size * (plesk ? .31 : .18) };
  const reelHand = fishingReelHand(frame, still, anchors);
  const support = fishingReelHand(frame, true, anchors);
  const desiredFar = plesk && action === "trade" ? mix(fishingBasketHandle(basket, size, basketScale), relaxed, smooth((phase - .1) / .15))
    : traveling && carryingBasket ? fishingBasketHandle(basket, size, basketScale)
    : action === "catch" ? catchFrame.wrist : packing ? mix(catchFrame.wrist, relaxed, smooth((phase - FISHING_PACK_RELEASE) / (1 - FISHING_PACK_RELEASE)))
      : pulling ? mix(reelHand, escape ? relaxed : catchFrame.wrist, escape ? smooth((phase - .65) / .35) : handoff)
        : preparing ? mix(relaxed, support, smooth(phase / .45))
          : casting || action === "fish" || action === "bite" ? support : relaxed;
  const farArm = arm(farShoulder, desiredFar, -side);
  const pose: PixelPose = action === "walk" ? "fishing-walk" : escape && action === "rest" ? "blink"
    : resting || traveling ? "idle" : action === "bite" || pulling && escape && phase < .6 ? "wonder"
      : action === "catch" ? "present" : "fish";
  const result: FishingShoreRig = { ...anchors, nearShoulder, farShoulder, nearHand: grip, farHand: farArm.hand,
    nearArm, farArm, pose, crouch, lean, phase, side, traveling, bodyDirection: direction, fishingStance: Boolean(frame.waterTarget) };
  if (!frame.settling) return result;
  const from = fishingShoreRig({ ...frame.settling.from, settling: undefined }, false, style);
  const sourceTackle = fishingTackleFrame(frame.settling.from, false, from);
  const sourceLine = fishingLineFrame(frame.settling.from, false, from, sourceTackle);
  result.settlingLine = { bobber: sourceTackle.bobber, control: sourceLine.control, floatPart: sourceLine.floatPart };
  const t = smooth(frame.settling.phase);
  result.nearShoulder = mix(from.nearShoulder, result.nearShoulder, t);
  result.farShoulder = mix(from.farShoulder, result.farShoulder, t);
  result.grip = result.nearHand = mix(from.grip, result.grip, t);
  result.farHand = mix(from.farHand, result.farHand, t);
  result.rodTip = mix(from.rodTip, result.rodTip, t);
  result.basket = mix(from.basket, result.basket, t);
  result.nearArm = arm(result.nearShoulder, result.nearHand, side);
  result.farArm = arm(result.farShoulder, result.farHand, -side);
  result.lean = from.lean + (result.lean - from.lean) * t;
  result.crouch = Math.round(from.crouch + (result.crouch - from.crouch) * t);
  result.pose = t < 1 ? from.pose : result.pose;
  result.fishingStance = t < 1 ? from.fishingStance : result.fishingStance;
  return result;
}
