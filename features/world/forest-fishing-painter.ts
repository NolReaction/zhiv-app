import type { PixelPose } from "@/features/mochlik/pixel-sprite";
import { drawFishingProps, FISHING_PACK_RELEASE, fishingTackleFrame } from "./fishing-props";
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
  const side = direction === "left" || direction === "front" && frame.waterTarget && frame.waterTarget.x < x ? -1 : 1;
  const swing = still ? 0 : Math.sin(phase * Math.PI * 6);
  const casting = action === "cast", pulling = action === "reel", packing = action === "pack";
  const struggle = frame.variation === "struggle", escape = frame.outcome === "miss";
  const check = frame.variation === "check" ? Math.sin(phase * Math.PI) : 0;
  const effort = pulling && struggle ? (.5 + swing * .5) * Math.sin(phase * Math.PI) : 0;
  const recoil = pulling && escape ? Math.sin(smooth((phase - .25) / .75) * Math.PI) : 0;
  const crouch = packing ? Math.round(Math.sin(phase * Math.PI) * 4)
    : pulling ? Math.round(effort * 3 + recoil) : action === "fish" ? frame.variation === "nibble" ? 1 : 2 : 0;
  const grip = { x: x + side * size * (casting ? .42 - .08 * smooth(phase) : pulling ? .34 - .04 * smooth(phase) - effort * .022 : .34),
    y: y - size * (casting ? .25 - .05 * smooth(phase) : pulling ? .2 + .12 * smooth(phase) + effort * .035 - recoil * .025
      : action === "bite" ? .22 + Math.abs(swing) * .013 : .2 + check * .035) };
  const heldFish = { x: x - side * size * .28, y: y - size * (.3 + (action === "catch" && !still ? Math.sin(phase * Math.PI) * .035 : 0)) };
  const traveling = action === "walk" || action === "idle" && !frame.waterTarget;
  const basket = { x: x - side * size * (traveling ? .27 : .43), y: y - size * (traveling ? .15 : .04) };
  const farShoulder = { x: x - side * size * .2, y: y - size * .255 };
  const nearShoulder = { x: x + side * size * .2, y: y - size * .255 };
  const placing = mix(heldFish, { x: basket.x, y: basket.y - size * .14 }, smooth(phase / FISHING_PACK_RELEASE));
  const nearHand = packing || action === "rest" ? { x: x + side * size * .24, y: y - size * .18 } : grip;
  const farHand = traveling && frame.carryingFish ? { x: basket.x, y: basket.y - size * .15 }
    : action === "catch" ? heldFish : packing ? placing
      : pulling && struggle ? { x: x + side * size * .12, y: y - size * (.19 + effort * .03) }
        : { x: x - side * size * (.23 - check * .05), y: y - size * (.18 + check * .13) };
  const pose: PixelPose = action === "walk" ? "fishing-walk" : escape && action === "rest" ? "blink"
    : action === "rest" || traveling ? "idle" : action === "bite" || pulling && escape && phase < .6 ? "wonder"
      : action === "catch" ? "present" : "fish";
  return { grip, heldFish: packing ? placing : heldFish, basket, nearShoulder, farShoulder, nearHand, farHand,
    pose, crouch, phase, side, traveling };
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
    ctx.strokeStyle = armShade; ctx.lineWidth = size * .1;
    ctx.beginPath(); ctx.moveTo(shoulder.x, shoulder.y); ctx.lineTo(elbow.x, elbow.y); ctx.lineTo(hand.x, hand.y); ctx.stroke();
    ctx.strokeStyle = armLight; ctx.lineWidth = size * .065;
    ctx.beginPath(); ctx.moveTo(shoulder.x, shoulder.y - size * .013); ctx.lineTo(elbow.x, elbow.y - size * .013);
    ctx.lineTo(hand.x, hand.y - size * .013); ctx.stroke();
  }
  ctx.save();
  const props = { ...frame, basketFilled: frame.basketFilled ?? (frame.carryingFish && action !== "catch" && (action !== "pack" || phase >= FISHING_PACK_RELEASE)) };
  const drawProps = () => drawFishingProps(ctx, props, still, { ...rig, drawBasket: Boolean(frame.waterTarget || frame.carryingFish) });
  if (direction === "back") { arm(farShoulder, farHand); arm(nearShoulder, nearHand); drawProps(); }
  drawGroundedHero(ctx, { x, y, size, pose: rig.pose, direction, frame: still ? 0 : frame.frame, appearance, shadow,
    rig: { gardening: true, crouch: rig.crouch }, breathe: still ? 0 : Math.sin(phase * Math.PI * 2) * .004 });
  if (direction !== "back") { arm(farShoulder, farHand); arm(nearShoulder, nearHand); drawProps(); }
  if (action !== "rest") {
    const tackle = fishingTackleFrame(props, still, rig);
    ctx.fillStyle = armLight;
    for (const hand of [nearHand, farHand]) {
      ctx.beginPath(); ctx.ellipse(hand.x, hand.y, size * .034, size * .035, 0, 0, Math.PI * 2); ctx.fill();
    }
    if (tackle.visible) {
      // A short finger crosses the cylindrical handle, while its dark end stays
      // visible on both sides of the paw and identifies a real grip.
      const dx = tackle.tip.x - rig.grip.x, dy = tackle.tip.y - rig.grip.y, length = Math.max(1, Math.hypot(dx, dy));
      ctx.strokeStyle = armShade; ctx.lineWidth = size * .021; ctx.lineCap = "round";
      ctx.beginPath(); ctx.moveTo(rig.grip.x - dy / length * size * .029, rig.grip.y + dx / length * size * .029);
      ctx.lineTo(rig.grip.x + dy / length * size * .029, rig.grip.y - dx / length * size * .029); ctx.stroke();
    }
  }
  ctx.restore();
}
