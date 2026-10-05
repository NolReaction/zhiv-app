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
  const side = direction === "left" || direction === "front" && frame.waterTarget && frame.waterTarget.x < x ? -1 : 1;
  const swing = still ? 0 : Math.sin(phase * Math.PI * 6);
  const casting = action === "cast", pulling = action === "reel", packing = action === "pack";
  const struggle = frame.variation === "struggle", escape = frame.outcome === "miss";
  const check = frame.variation === "check" ? Math.sin(phase * Math.PI) : 0;
  const effort = pulling && struggle ? (.5 + swing * .5) * Math.sin(phase * Math.PI) : 0;
  const recoil = pulling && escape ? Math.sin(smooth((phase - .25) / .75) * Math.PI) : 0;
  const crouch = packing ? Math.round(Math.sin(phase * Math.PI) * 4)
    : pulling ? Math.round(effort * 3 + recoil) : action === "fish" ? frame.variation === "nibble" ? 1 : 2 : 0;
  const landing = action === "catch" || packing;
  const grip = { x: x + side * size * (landing ? .3 : casting ? .42 - .08 * smooth(phase) : pulling ? .34 - .04 * smooth(phase) - effort * .022 : .34),
    y: y - size * (casting ? .25 - .05 * smooth(phase) : pulling ? .2 + .12 * smooth(phase) + effort * .035 - recoil * .025
      : landing ? .32 : action === "bite" ? .22 + Math.abs(swing) * .013 : .2 + check * .035) };
  const heldFish = { x: x - side * size * .31, y: y - size * (.3 + (action === "catch" && !still ? Math.sin(phase * Math.PI) * .025 : 0)) };
  const traveling = action === "walk" || action === "idle" && !frame.waterTarget;
  const basket = { x: x - side * size * (traveling ? .27 : .43), y: y - size * (traveling ? .15 : .04) };
  const handoff = smooth((phase - FISHING_REEL_HANDOFF) / (1 - FISHING_REEL_HANDOFF));
  const farShoulder = { x: x - side * size * (pulling ? .1 + .1 * handoff : .2), y: y - size * .255 };
  const nearShoulder = { x: x + side * size * .2, y: y - size * .255 };
  const placing = fishingPackCenter(heldFish, basket, size, phase);
  const actualFish = packing ? placing : heldFish;
  const catchFrame = fishingCatchFrame(frame, still, { grip, heldFish: actualFish, basket });
  const relaxed = { x: x - side * size * (.23 - check * .05), y: y - size * (.18 + check * .13) };
  const nearHand = action === "rest" ? { x: x + side * size * .24, y: y - size * .18 } : grip;
  const farHand = traveling && frame.carryingFish ? fishingBasketHandle(basket, size)
    : action === "catch" ? catchFrame.wrist : packing ? mix(catchFrame.wrist, relaxed, smooth((phase - FISHING_PACK_RELEASE) / (1 - FISHING_PACK_RELEASE)))
      : pulling ? mix(mix(relaxed, fishingReelHand(frame, still, { grip }), still ? 1 : smooth(phase / .12)),
        escape ? relaxed : catchFrame.wrist, escape ? smooth((phase - .65) / .35) : handoff)
        : relaxed;
  const pose: PixelPose = action === "walk" ? "fishing-walk" : escape && action === "rest" ? "blink"
    : action === "rest" || traveling ? "idle" : action === "bite" || pulling && escape && phase < .6 ? "wonder"
      : action === "catch" ? "present" : "fish";
  return { grip, heldFish: actualFish, basket, nearShoulder, farShoulder, nearHand, farHand,
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
  drawGroundedHero(ctx, { x, y, size, pose: rig.pose, direction, frame: still ? 0 : frame.frame, appearance, shadow,
    rig: { gardening: true, crouch: rig.crouch }, breathe: still ? 0 : Math.sin(phase * Math.PI * 2) * .004 });
  if (direction !== "back") { arm(farShoulder, farHand); arm(nearShoulder, nearHand); drawProps(); }
  if (action !== "rest") {
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
