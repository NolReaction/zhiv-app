import type { PixelPose } from "@/features/mochlik/pixel-sprite";
import { drawFishingProps } from "./fishing-props";
import type { ForestFishingFrame } from "./forest-fishing";
import { drawGroundedHero } from "./grounding";
import type { WorldPoint } from "./tiled/types";

type Appearance = { palette: string; head: string | null; neck: string | null };
const clamp = (value: number) => Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
const mix = (a: WorldPoint, b: WorldPoint, t: number) => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });

/** Continuous hands replace the body's baked arms, just as in gardening.
 * Both the rod and displayed fish use these exact anchors; no detached prop
 * pretends to animate a static portrait. Clothing still belongs to pixelSprite. */
export function drawForestFishingHero(ctx: CanvasRenderingContext2D, frame: ForestFishingFrame,
  appearance: Appearance | undefined, still: boolean, shadow = true) {
  if (![frame.x, frame.y, frame.size].every(Number.isFinite) || frame.size <= 0) return;
  const { x, size, action, direction } = frame, phase = clamp(frame.phase);
  const walking = action === "walk" && !still;
  const y = frame.y - (walking && frame.frame % 2 ? size / 24 : 0);
  const side = direction === "left" ? -1 : 1;
  const swing = still ? 0 : Math.sin(phase * Math.PI * 6);
  const casting = action === "cast", pulling = action === "reel", packing = action === "pack";
  const crouch = packing ? Math.round(Math.sin(phase * Math.PI) * 4) : action === "fish" ? 2 : action === "bite" ? 1 : 0;
  const grip = { x: x + side * size * (casting ? .2 + .06 * phase : pulling ? .25 - .07 * phase : .25),
    y: y - size * (casting ? .48 - .2 * phase : pulling ? .28 + .14 * phase : action === "bite" ? .32 + swing * .008 : .28) };
  const heldFish = { x: x + side * size * .24, y: y - size * .4 };
  const traveling = action === "walk" || action === "idle" && !frame.waterTarget;
  const basket = { x: x + side * size * (traveling ? -.25 : .44), y: y - size * (traveling ? .17 : .045) };
  const farShoulder = { x: x - side * size * .18, y: y - size * .27 };
  const nearShoulder = { x: x + side * size * .18, y: y - size * .27 };
  const placing = mix(heldFish, { x: basket.x, y: basket.y - size * .14 }, Math.min(1, phase / .7));
  const nearHand = packing ? placing : action === "rest" ? { x: x + side * size * .2, y: y - size * .2 } : grip;
  const farHand = traveling && frame.carryingFish ? { x: basket.x, y: basket.y - size * .16 }
    : action === "catch" ? heldFish : packing ? { x: x - side * size * .15, y: y - size * .2 }
    : action === "rest" ? { x: x - side * size * .2, y: y - size * .2 }
      : { x: grip.x - side * size * (pulling ? .035 + swing * .017 : .07), y: grip.y + size * .035 };
  const pose: PixelPose = action === "walk" ? "fishing-walk" : action === "rest" || traveling ? "idle" : action === "bite" ? "wonder" : action === "catch" ? "present" : "fish";
  const armShade = direction === "back" ? appearance?.palette === "fern" ? "#345649" : appearance?.palette === "autumn" ? "#7a5637" : "#58683b" : "#d8bf83";
  const armLight = direction === "back" ? appearance?.palette === "fern" ? "#49816b" : appearance?.palette === "autumn" ? "#b27b42" : "#7c8845" : "#f4e4ae";
  function arm(shoulder: WorldPoint, hand: WorldPoint) {
    const elbow = { x: shoulder.x + (hand.x - shoulder.x) * .48, y: Math.max(shoulder.y, hand.y) + size * .035 };
    ctx.lineCap = "round"; ctx.lineJoin = "round";
    ctx.strokeStyle = armShade; ctx.lineWidth = size * .115;
    ctx.beginPath(); ctx.moveTo(shoulder.x, shoulder.y); ctx.lineTo(elbow.x, elbow.y); ctx.lineTo(hand.x, hand.y); ctx.stroke();
    ctx.strokeStyle = armLight; ctx.lineWidth = size * .073;
    ctx.beginPath(); ctx.moveTo(shoulder.x, shoulder.y - size * .016); ctx.lineTo(elbow.x, elbow.y - size * .016);
    ctx.lineTo(hand.x, hand.y - size * .016); ctx.stroke();
  }
  ctx.save();
  // Rear-facing paws sit behind the rump/head; front-facing hands remain visible.
  if (direction === "back") { arm(farShoulder, farHand); arm(nearShoulder, nearHand); }
  drawGroundedHero(ctx, { x, y: frame.y, size, pose, direction, frame: still ? 0 : frame.frame, appearance, shadow,
    rig: { gardening: true, crouch }, breathe: still ? 0 : Math.sin(phase * Math.PI * 2) * .004 });
  if (direction !== "back") { arm(farShoulder, farHand); arm(nearShoulder, nearHand); }
  drawFishingProps(ctx, { ...frame, basketFilled: frame.basketFilled ?? (frame.carryingFish && action !== "catch" && (action !== "pack" || phase > .65)) }, still,
    { grip, heldFish: packing ? placing : heldFish, basket, drawBasket: Boolean(frame.waterTarget || frame.carryingFish) });
  if (action !== "rest") {
    // A small opaque palm in front of the handle makes the physical grip clear.
    ctx.fillStyle = armLight;
    for (const hand of [nearHand, farHand]) {
      ctx.beginPath(); ctx.ellipse(hand.x, hand.y - size * .005, size * .036, size * .038, 0, 0, Math.PI * 2); ctx.fill();
    }
  }
  ctx.restore();
}
