import type { PixelDirection, PixelPose } from "@/features/mochlik/pixel-sprite";
import { fishingCatchFrame, fishingPackCenter, fishingReelHand, fishingTackleFrame, fishingLineFrame,
  FISHING_PACK_RELEASE, FISHING_REEL_HANDOFF, type FishingPropFrame } from "./fishing-props";
import type { WorldPoint } from "@/features/world/tiled/types";

const clamp = (t: number) => Math.max(0, Math.min(1, Number.isFinite(t) ? t : 0));
const smooth = (t: number) => { t = clamp(t); return t * t * (3 - 2 * t); };
const mix = (a: WorldPoint, b: WorldPoint, t: number) => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });

/** The screen pole leaves the lower belly toward the actual float. A flat
 * backswing rotates that same projected length; height cannot cancel it. */
function shorePole(frame: FishingPropFrame, grip: WorldPoint, turn = 0) {
  const side = frame.direction === "left" ? -1 : 1;
  const target = frame.waterTarget ?? { x: grip.x + side * frame.size * .22, y: grip.y + frame.size * .72 };
  const dx = target.x - grip.x, dy = target.y - grip.y, distance = Math.max(.001, Math.hypot(dx, dy));
  const length = Math.min(frame.size * .82, distance * .78), angle = Math.atan2(dy, dx) + turn;
  return { x: grip.x + Math.cos(angle) * length, y: grip.y + Math.sin(angle) * length };
}

/** Fold the full pole outward before carrying it upright; blending opposite
 * tips directly would briefly shrink the shaft into the gripping paw. */
function foldPole(from: { grip: WorldPoint; rodTip: WorldPoint }, to: { grip: WorldPoint; rodTip: WorldPoint },
  grip: WorldPoint, t: number): WorldPoint {
  if (t === 0) return from.rodTip;
  if (t === 1) return to.rodTip;
  const a = { x: from.rodTip.x - from.grip.x, y: from.rodTip.y - from.grip.y };
  const b = { x: to.rodTip.x - to.grip.x, y: to.rodTip.y - to.grip.y };
  const angle = Math.atan2(a.y, a.x);
  let turn = Math.atan2(b.y, b.x) - angle;
  if (turn > Math.PI) turn -= Math.PI * 2;
  if (turn < -Math.PI) turn += Math.PI * 2;
  const length = Math.hypot(a.x, a.y) + (Math.hypot(b.x, b.y) - Math.hypot(a.x, a.y)) * t;
  return { x: grip.x + Math.cos(angle + turn * t) * length, y: grip.y + Math.sin(angle + turn * t) * length };
}

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
  rodTip: WorldPoint; rodElevation: number; rodLength: number; detailScale: number; anatomicalSide: number; castOrigin: WorldPoint; castArc: number; settlingLine?: { bobber: WorldPoint; control: WorldPoint; floatPart: number };
  tautLine: boolean; keepRod: boolean; drawBasket: boolean;
  nearShoulder: WorldPoint; farShoulder: WorldPoint; nearHand: WorldPoint; farHand: WorldPoint;
  nearArm: ReturnType<typeof fishingArm>; farArm: ReturnType<typeof fishingArm>;
  pose: PixelPose; crouch: number; lean: number; phase: number; side: number; traveling: boolean; bodyDirection: PixelDirection; fishingStance: boolean;
};

/** One lower-belly grip and screen axis for both residents. The actual water
 * target owns the forward direction; props never rise beside the face. */
export function fishingShoreRig(frame: FishingPropFrame, still: boolean, style: "mochlik" | "plesk" = "mochlik"): FishingShoreRig {
  const { x, size, action, direction } = frame, phase = still ? .5 : clamp(frame.phase);
  const plesk = style === "plesk";
  const arm = (shoulder: WorldPoint, hand: WorldPoint, bend: number) => fishingArm(shoulder, hand, size, bend,
    { upper: .12, lower: .13 });
  const walking = action === "walk" && !still;
  const y = frame.y - (walking && frame.frame % 2 ? size / 24 : 0);
  const side = direction === "left" ? -1 : 1;
  const casting = action === "cast", pulling = action === "reel", packing = action === "pack";
  const preparing = action === "idle" && Boolean(frame.waterTarget) && frame.variation === "check";
  const resting = action === "rest" || action === "idle" && !preparing;
  const landing = action === "catch" || packing;
  const traveling = action === "walk" || (action === "idle" || action === "rest") && !frame.waterTarget
    || (action === "greet" || action === "trade") && !frame.waterTarget;
  const castStroke = smooth((phase - .18) / .34), hookSet = action === "bite" ? smooth(phase / .32) : 0;
  const effort = pulling && frame.variation === "struggle" && !still ? Math.sin(phase * Math.PI) * (1 + Math.sin(phase * Math.PI * 6)) / 2 : 0;
  const escape = frame.outcome === "miss", check = frame.variation === "check" ? Math.sin(phase * Math.PI) : 0;
  const handoff = pulling ? smooth((phase - FISHING_REEL_HANDOFF) / (1 - FISHING_REEL_HANDOFF)) : 0;
  const basketSide = plesk ? side : -side;
  const lean = packing ? basketSide * Math.sin(phase * Math.PI) : casting ? side * (-1 + castStroke * 2)
    : preparing ? -side * smooth(phase) : pulling ? -side * (1 - smooth(phase)) * (1 + effort)
      : action === "bite" ? side * (1 - hookSet * 3 + smooth((phase - .5) / .5)) : action === "fish" ? side : 0;
  const crouch = packing ? Math.round(Math.sin(phase * Math.PI) * 2) : pulling ? Math.round(effort)
    : action === "fish" ? 1 : casting ? Math.round(castStroke) : action === "bite" ? Math.round(1 - hookSet) : 0;
  const bodyOffset = Math.round(lean) * size / 48;
  // Shoulders remain anatomical through all phase buckets, including the end
  // of a waiting/check action. Only the free hand leaves the reel at handoff.
  const nearShoulder = { x: x + bodyOffset + side * size * .1, y: y - size * .28 };
  // The supporting shoulder turns toward the basket only during the real
  // handoff. Waiting never pulls it around the body at a phase boundary.
  const release = packing ? smooth((phase - FISHING_PACK_RELEASE) / (1 - FISHING_PACK_RELEASE)) : 0;
  const lifting = action === "catch" ? smooth((phase - .2) / .55) : 0;
  const basketShoulder = (plesk ? .23 : -.23);
  const farOffset = packing ? basketShoulder + (-.1 - basketShoulder) * release
    : action === "catch" ? -.1 + (basketShoulder + .1) * lifting
      : -.1;
  const farShoulder = { x: x + bodyOffset + side * size * farOffset, y: y - size * .28 };
  const gripX = x + side * size * .02;
  const waiting = { x: gripX, y: y - size * .2 };
  const raised = { x: gripX - side * size * .025, y: y - size * .23 };
  const landed = { x: gripX, y: y - size * .22 };
  const biteGrip = { x: gripX, y: y - size * .23 };
  const restingGrip = { ...waiting };
  const desiredGrip = traveling ? { x: x + side * size * .18, y: y - size * .24 }
    : landing ? landed : resting ? mix(landed, restingGrip, smooth(phase / .4))
    : casting ? mix(raised, waiting, castStroke) : preparing ? mix(restingGrip, raised, smooth(phase))
      : pulling ? mix(biteGrip, landed, smooth(phase)) : action === "bite" ? mix(waiting, biteGrip, hookSet)
        : { ...waiting, y: waiting.y - size * check * .015 };
  const nearArm = arm(nearShoulder, desiredGrip, side);
  const grip = nearArm.hand;
  const heldFish = { x: x + basketSide * size * .25, y: y - size * .27 };
  const basketScale = plesk ? .8 : .775;
  // At the basket's widest painted rim the half-width is .168size; .46 puts
  // that rim beyond Pleska's .23size torso with a visible gap on the ground.
  const basket = { x: x + side * size * (plesk ? .46 : -.4),
    y: y - size * (plesk ? .1296 : .173 * basketScale) };
  const actualFish = packing ? fishingPackCenter(heldFish, basket, size, phase, basketScale) : heldFish;
  if (packing) {
    // Shore baskets sit beside the short paws: clear the rim with a low arc,
    // without lifting a large catch back across the eyes or muzzle.
    actualFish.y += Math.sin(smooth(phase / FISHING_PACK_RELEASE) * Math.PI) * size * .12;
  }
  const turn = casting ? -.6 * side * (1 - castStroke) : preparing ? -.6 * side * smooth(phase) : 0;
  const aimedTip = shorePole(frame, grip, turn);
  const restingTip = shorePole({ ...frame, waterTarget: undefined }, grip);
  const carriedTip = { x: grip.x + side * size * .3, y: grip.y - size * .85 };
  const rodTip = traveling ? carriedTip : resting ? mix(aimedTip, restingTip, smooth(phase / .4))
    : preparing ? mix(restingTip, aimedTip, smooth(phase)) : aimedTip;
  const releaseGrip = mix(raised, waiting, smooth((.34 - .18) / .34));
  const releaseStroke = smooth((.34 - .18) / .34);
  const releaseTip = shorePole(frame, releaseGrip, -.6 * side * (1 - releaseStroke));
  const castOrigin = { x: releaseTip.x, y: releaseTip.y + size * .16 };
  const castArc = Math.min(size * .22, Math.max(0, (frame.waterTarget?.y ?? castOrigin.y) - castOrigin.y) * .4);
  const anchors = { grip, heldFish: actualFish, basket, basketScale, rodTip, rodElevation: 0, rodLength: .82, detailScale: .45, anatomicalSide: side, castOrigin, castArc,
    tautLine: true, keepRod: true, drawBasket: !traveling && Boolean(frame.waterTarget
      && [frame.waterTarget.x, frame.waterTarget.y].every(Number.isFinite)) };
  const catchFrame = fishingCatchFrame(frame, still, anchors);
  const relaxed = { x: x - side * size * .1, y: y - size * .22 };
  const reelHand = fishingReelHand(frame, still, anchors);
  const support = fishingReelHand(frame, true, anchors);
  const withdraw = mix(catchFrame.wrist, relaxed, release);
  withdraw.y -= size * .18 * Math.sin(release * Math.PI);
  const desiredFar = traveling ? relaxed : action === "catch" ? catchFrame.wrist : packing ? withdraw
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
  const targetPole = { grip: result.grip, rodTip: result.rodTip };
  result.nearShoulder = mix(from.nearShoulder, result.nearShoulder, t);
  result.farShoulder = mix(from.farShoulder, result.farShoulder, t);
  result.grip = result.nearHand = mix(from.grip, result.grip, t);
  result.farHand = mix(from.farHand, result.farHand, t);
  result.rodTip = foldPole(from, targetPole, result.grip, t);
  result.basket = from.basket;
  result.drawBasket = from.drawBasket && t < 1;
  result.nearArm = arm(result.nearShoulder, result.nearHand, side);
  result.farArm = arm(result.farShoulder, result.farHand, -side);
  result.lean = from.lean + (result.lean - from.lean) * t;
  result.crouch = Math.round(from.crouch + (result.crouch - from.crouch) * t);
  result.pose = t < 1 ? from.pose : result.pose;
  result.fishingStance = t < 1 ? from.fishingStance : result.fishingStance;
  return result;
}
