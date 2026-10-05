import { drawFishingProps, fishingTackleFrame, fishingCatchFrame, fishingReelHand, FISHING_PACK_RELEASE } from "./fishing-props";
import { fishingShoreRig } from "./fishing-shore-rig";
import type { ForestFishingFrame } from "./forest-fishing";
import { drawGroundedHero } from "./grounding";
import type { WorldPoint } from "./tiled/types";

type Appearance = { palette: string; head: string | null; neck: string | null };

/** Shared ground aim, bounded two-bone arms and continuous prop anchors. */
export const forestFishingHeroRig = (frame: ForestFishingFrame, still: boolean) => fishingShoreRig(frame, still);

/** Continuous compact arms replace cached arms; the palm is repainted over the
 * actual handle after the shared rod, never below a floating fishing prop. */
export function drawForestFishingHero(ctx: CanvasRenderingContext2D, frame: ForestFishingFrame,
  appearance: Appearance | undefined, still: boolean, shadow = true) {
  if (![frame.x, frame.y, frame.size].every(Number.isFinite) || frame.size <= 0) return;
  const { x, y, size, action, direction } = frame, rig = forestFishingHeroRig(frame, still);
  const { phase, nearArm, farArm } = rig;
  const armShade = direction === "back" ? appearance?.palette === "fern" ? "#345649" : appearance?.palette === "autumn" ? "#7a5637" : "#58683b" : "#d8bf83";
  const armLight = direction === "back" ? appearance?.palette === "fern" ? "#49816b" : appearance?.palette === "autumn" ? "#b27b42" : "#7c8845" : "#f4e4ae";
  const scale = size / 48, origin = { x: x - size / 2, y: y - size * 45 / 48 };
  function segment(start: WorldPoint, end: WorldPoint, width: number, color: string) {
    const a = { x: Math.round((start.x - origin.x) / scale), y: Math.round((start.y - origin.y) / scale) };
    const b = { x: Math.round((end.x - origin.x) / scale), y: Math.round((end.y - origin.y) / scale) };
    const steps = Math.max(Math.abs(b.x - a.x), Math.abs(b.y - a.y), 1);
    ctx.fillStyle = color;
    for (let step = 0; step <= steps; step++) {
      ctx.fillRect(origin.x + (Math.round(a.x + (b.x - a.x) * step / steps) - 1) * scale,
        origin.y + (Math.round(a.y + (b.y - a.y) * step / steps) - 1) * scale, width * scale, width * scale);
    }
  }
  function arm({ shoulder, elbow, hand }: { shoulder: WorldPoint; elbow: WorldPoint; hand: WorldPoint }, forearmOnly = false) {
    if (!forearmOnly) segment(shoulder, elbow, 3, armShade);
    segment(elbow, hand, 3, armShade);
    if (!forearmOnly) segment(shoulder, elbow, 2, armLight);
    segment(elbow, hand, 2, armLight);
  }
  function paw(part: typeof nearArm) {
    const dx = part.elbow.x - part.hand.x, dy = part.elbow.y - part.hand.y, length = Math.max(.001, Math.hypot(dx, dy));
    const cuff = { x: part.hand.x + dx / length * Math.min(length, scale * 2), y: part.hand.y + dy / length * Math.min(length, scale * 2) };
    segment(cuff, part.hand, 2, armShade); segment(cuff, part.hand, 1, armLight);
    const px = Math.round((part.hand.x - origin.x) / scale), py = Math.round((part.hand.y - origin.y) / scale);
    ctx.fillStyle = armLight; ctx.fillRect(origin.x + (px - 1) * scale, origin.y + (py - 1) * scale, scale * 2, scale * 2);
  }
  ctx.save();
  const props = { ...frame, basketFilled: frame.basketFilled ?? (frame.carryingFish && action !== "catch" && (action !== "pack" || phase >= FISHING_PACK_RELEASE)) };
  const drawProps = () => drawFishingProps(ctx, props, still, rig);
  if (direction === "back") { arm(farArm); arm(nearArm); drawProps(); }
  else { arm(farArm); arm(nearArm); }
  drawGroundedHero(ctx, { x, y, size, pose: rig.pose, direction: rig.bodyDirection, frame: still ? 0 : frame.frame, appearance, shadow,
    rig: { gardening: true, crouch: rig.crouch, lean: rig.lean, fishingStance: rig.fishingStance },
    breathe: still ? 0 : Math.sin(phase * Math.PI * 2) * .004 });
  // The shoulder stays behind the torso, but the supporting forearm emerges
  // in front to wind, unhook and lower the fish. The body cannot erase it.
  if (direction !== "back") {
    if (["catch", "pack"].includes(action)) arm(farArm, true);
    paw(farArm); paw(nearArm); drawProps();
    if (action === "pack") paw(farArm);
  }
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
      const winding = fishingReelHand(props, still || action !== "reel", rig);
      if (Math.hypot(winding.x - rig.farHand.x, winding.y - rig.farHand.y) <= scale) {
        ctx.fillStyle = armShade;
        ctx.fillRect(rig.farHand.x - scale * .55, rig.farHand.y - scale * .5, scale * 1.1, scale);
        ctx.fillStyle = armLight;
        ctx.fillRect(rig.farHand.x - scale * .45, rig.farHand.y - scale * .35, scale * .9, scale * .7);
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
