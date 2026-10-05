import type { PixelPose } from "@/features/mochlik/pixel-sprite";
import { drawFishingProps, FISHING_PACK_RELEASE, FISHING_REEL_HANDOFF, fishingTackleFrame, fishingCatchFrame, fishingPackCenter, fishingBasketHandle, fishingReelHand } from "./fishing-props";
import type { ForestFishingFrame } from "./forest-fishing";
import { drawGroundedHero } from "./grounding";
import type { WorldPoint } from "./tiled/types";

type Appearance = { palette: string; head: string | null; neck: string | null };
const clamp = (value: number) => Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
const smooth = (value: number) => { const t = clamp(value); return t * t * (3 - 2 * t); };
const mix = (a: WorldPoint, b: WorldPoint, t: number) => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });

/** Body and tackle use the same physical hand anchors. Rod and fish belong to
 * opposite paws; the free paw lowers its catch into the basket on that side. */
export function forestFishingHeroRig(frame: ForestFishingFrame, still: boolean) {
  const { x, size, action, direction } = frame, phase = still ? .5 : clamp(frame.phase);
  const walking = action === "walk" && !still;
  const y = frame.y - (walking && frame.frame % 2 ? size / 24 : 0);
  // A small per-cast water offset must not swap the occupied paws or basket.
  const side = direction === "left" ? -1 : 1;
  const swing = still ? 0 : Math.sin(phase * Math.PI * 6);
  const casting = action === "cast", pulling = action === "reel", packing = action === "pack";
  const struggle = frame.variation === "struggle", escape = frame.outcome === "miss";
  const check = frame.variation === "check" ? Math.sin(phase * Math.PI) : 0;
  const effort = pulling && struggle ? (.5 + swing * .5) * Math.sin(phase * Math.PI) : 0;
  const recoil = pulling && escape ? Math.sin(smooth((phase - .25) / .75) * Math.PI) : 0;
  const preparing = action === "idle" && Boolean(frame.waterTarget);
  const castStroke = smooth((phase - .22) / .42);
  const hookSet = action === "bite" ? smooth(phase / .32) : 0;
  const lean = packing ? -side * Math.sin(phase * Math.PI) * 2 : casting ? side * (-1 + castStroke * 2)
    : preparing ? -side * smooth(phase) : pulling ? -side * (1 - smooth(phase)) * (1 + effort * 2)
      : action === "bite" ? side * (1 - hookSet * 3 + smooth((phase - .5) / .5)) : action === "fish" ? side : 0;
  const crouch = packing ? Math.round(Math.sin(phase * Math.PI) * 3)
    : pulling ? Math.round(effort * 2 + recoil) : action === "fish" ? 1 : casting ? Math.round(castStroke)
      : action === "bite" ? Math.round(1 - hookSet) : 0;
  const landing = action === "catch" || packing;
  const waiting = { x: x + side * size * .36, y: y - size * .29 };
  const raised = { x: x + side * size * .42, y: y - size * .43 };
  const landed = { x: x + side * size * .3, y: y - size * .32 };
  const biteGrip = { x: x + side * size * .35, y: y - size * .37 };
  const restingGrip = { x: x + side * size * .31, y: y - size * .22 };
  const grip = landing ? landed : action === "rest" ? mix(landed, restingGrip, smooth(phase / .4)) : casting ? mix(raised, waiting, castStroke)
    : preparing ? mix(restingGrip, raised, smooth(phase))
      : pulling ? mix(biteGrip, landed, smooth(phase)) : action === "bite" ? mix(waiting, biteGrip, hookSet)
        : { ...waiting, y: waiting.y - size * check * .025 };
  const heldFish = { x: x - side * size * .31, y: y - size * (.3 + (action === "catch" && !still ? Math.sin(phase * Math.PI) * .025 : 0)) };
  const traveling = action === "walk" || action === "idle" && !frame.waterTarget;
  const basketScale = .775;
  const basket = { x: x - side * size * (traveling ? .3 : .49), y: y - size * (traveling ? .17 : .134) };
  const handoff = smooth((phase - FISHING_REEL_HANDOFF) / (1 - FISHING_REEL_HANDOFF));
  const working = preparing || casting || action === "fish" || action === "bite" || pulling;
  const bodyOffset = Math.round(lean) * size / 48;
  const farShoulder = { x: x + bodyOffset + side * size * (working ? .045 * (1 - handoff) - .2 * handoff : -.2), y: y - size * .255 };
  const nearShoulder = { x: x + bodyOffset + side * size * .2, y: y - size * .255 };
  const placing = fishingPackCenter(heldFish, basket, size, phase, basketScale);
  const actualFish = packing ? placing : heldFish;
  let pitch = landing ? 1.2 : action === "rest" ? 1.2 - .46 * smooth(phase / .4) : pulling ? .96 + .24 * smooth(phase) : action === "bite" ? .48 + .48 * hookSet
    : casting ? 1.22 - .74 * castStroke : preparing ? .74 + .48 * smooth(phase) : .48;
  if (action === "fish" && !still) pitch += check * .07 + (frame.variation === "nibble" ? Math.sin(phase * Math.PI * 6) * .025 : 0);
  const rodAngle = side > 0 ? -pitch : -Math.PI + pitch;
  const tackleAnchors = { grip, heldFish: actualFish, basket, basketScale, rodAngle, rodLength: .96, tautLine: true, keepRod: true };
  const catchFrame = fishingCatchFrame(frame, still, tackleAnchors);
  const relaxed = { x: x - side * size * (.23 - check * .05), y: y - size * (.18 + check * .13) };
  const nearHand = grip;
  const farHand = traveling && frame.carryingFish ? fishingBasketHandle(basket, size, basketScale)
    : action === "catch" ? catchFrame.wrist : packing ? mix(catchFrame.wrist, relaxed, smooth((phase - FISHING_PACK_RELEASE) / (1 - FISHING_PACK_RELEASE)))
      : pulling ? mix(fishingReelHand(frame, still, tackleAnchors),
        escape ? relaxed : catchFrame.wrist, escape ? smooth((phase - .65) / .35) : handoff)
        : preparing ? mix(relaxed, fishingReelHand(frame, true, tackleAnchors), smooth(phase / .45))
          : working ? fishingReelHand(frame, true, tackleAnchors) : relaxed;
  const pose: PixelPose = action === "walk" ? "fishing-walk" : escape && action === "rest" ? "blink"
    : action === "rest" || traveling ? "idle" : action === "bite" || pulling && escape && phase < .6 ? "wonder"
      : action === "catch" ? "present" : "fish";
  return { ...tackleAnchors, nearShoulder, farShoulder, nearHand, farHand,
    pose, crouch, lean, phase, side, traveling,
    bodyDirection: direction === "front" && frame.waterTarget ? side > 0 ? "right" as const : "left" as const : direction };
}

/** Continuous compact arms replace cached arms; the palm is repainted over the
 * actual handle after the shared rod, never below a floating fishing prop. */
export function drawForestFishingHero(ctx: CanvasRenderingContext2D, frame: ForestFishingFrame,
  appearance: Appearance | undefined, still: boolean, shadow = true) {
  if (![frame.x, frame.y, frame.size].every(Number.isFinite) || frame.size <= 0) return;
  const { x, y, size, action, direction } = frame, rig = forestFishingHeroRig(frame, still);
  const { phase, nearShoulder, farShoulder, nearHand, farHand } = rig;
  const armShade = direction === "back" ? appearance?.palette === "fern" ? "#345649" : appearance?.palette === "autumn" ? "#7a5637" : "#58683b" : "#d8bf83";
  const armLight = direction === "back" ? appearance?.palette === "fern" ? "#49816b" : appearance?.palette === "autumn" ? "#b27b42" : "#7c8845" : "#f4e4ae";
  function arm(shoulder: WorldPoint, hand: WorldPoint) {
    const elbow = { x: shoulder.x + (hand.x - shoulder.x) * .48, y: Math.max(shoulder.y, hand.y) + size * .035 };
    ctx.lineCap = "round"; ctx.lineJoin = "round";
    ctx.strokeStyle = armShade; ctx.lineWidth = size * .082;
    ctx.beginPath(); ctx.moveTo(shoulder.x, shoulder.y); ctx.lineTo(elbow.x, elbow.y); ctx.lineTo(hand.x, hand.y); ctx.stroke();
    ctx.strokeStyle = armLight; ctx.lineWidth = size * .052;
    ctx.beginPath(); ctx.moveTo(shoulder.x, shoulder.y - size * .013); ctx.lineTo(elbow.x, elbow.y - size * .013);
    ctx.lineTo(hand.x, hand.y - size * .013); ctx.stroke();
  }
  ctx.save();
  const props = { ...frame, basketFilled: frame.basketFilled ?? (frame.carryingFish && action !== "catch" && (action !== "pack" || phase >= FISHING_PACK_RELEASE)) };
  const drawProps = () => drawFishingProps(ctx, props, still, { ...rig, drawBasket: Boolean(frame.waterTarget || frame.carryingFish) });
  if (direction === "back") { arm(farShoulder, farHand); arm(nearShoulder, nearHand); drawProps(); }
  drawGroundedHero(ctx, { x, y, size, pose: rig.pose, direction: rig.bodyDirection, frame: still ? 0 : frame.frame, appearance, shadow,
    rig: { gardening: true, crouch: rig.crouch, lean: rig.lean, fishingStance: Boolean(frame.waterTarget) },
    breathe: still ? 0 : Math.sin(phase * Math.PI * 2) * .004 });
  if (direction !== "back") { arm(farShoulder, farHand); arm(nearShoulder, nearHand); drawProps(); }
  {
    const tackle = fishingTackleFrame(props, still, rig);
    if (tackle.visible) {
      // A short finger crosses the cylindrical handle, while its dark end stays
      // visible on both sides of the paw and identifies a real grip.
      const dx = tackle.tip.x - rig.grip.x, dy = tackle.tip.y - rig.grip.y, length = Math.max(1, Math.hypot(dx, dy));
      ctx.strokeStyle = armLight; ctx.lineWidth = size * .017; ctx.lineCap = "round";
      for (const along of [-.013, .014]) {
        const at = { x: rig.grip.x + dx / length * size * along, y: rig.grip.y + dy / length * size * along };
        ctx.beginPath(); ctx.moveTo(at.x - dy / length * size * .025, at.y + dx / length * size * .025);
        ctx.lineTo(at.x + dy / length * size * .025, at.y - dx / length * size * .025); ctx.stroke();
      }
    }
    const fish = fishingCatchFrame(props, still, rig);
    if (fish.visible && (action === "pack" || phase >= .18)) {
      ctx.strokeStyle = armLight; ctx.lineWidth = size * .013; ctx.lineCap = "round";
      for (const offset of [-.014, .014]) {
        ctx.beginPath(); ctx.moveTo(fish.wrist.x + offset * size, fish.wrist.y + size * .012);
        ctx.lineTo(fish.wrist.x + offset * size, fish.wrist.y - size * .007); ctx.stroke();
      }
    }
  }
  ctx.restore();
}
