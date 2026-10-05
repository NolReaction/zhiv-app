import { drawFishingProps, fishingTackleFrame, fishingCatchFrame, FISHING_PACK_RELEASE } from "./fishing-props";
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
  function arm({ shoulder, elbow, hand }: { shoulder: WorldPoint; elbow: WorldPoint; hand: WorldPoint }) {
    ctx.lineCap = "round"; ctx.lineJoin = "round";
    ctx.strokeStyle = armShade; ctx.lineWidth = size * .082;
    ctx.beginPath(); ctx.moveTo(shoulder.x, shoulder.y); ctx.lineTo(elbow.x, elbow.y); ctx.lineTo(hand.x, hand.y); ctx.stroke();
    ctx.strokeStyle = armLight; ctx.lineWidth = size * .052;
    ctx.beginPath(); ctx.moveTo(shoulder.x, shoulder.y - size * .013); ctx.lineTo(elbow.x, elbow.y - size * .013);
    ctx.lineTo(hand.x, hand.y - size * .013); ctx.stroke();
  }
  ctx.save();
  const props = { ...frame, basketFilled: frame.basketFilled ?? (frame.carryingFish && action !== "catch" && (action !== "pack" || phase >= FISHING_PACK_RELEASE)) };
  const drawProps = () => drawFishingProps(ctx, props, still, { ...rig, drawBasket: Boolean(frame.waterTarget || frame.carryingFish || frame.carryingBasket) });
  if (direction === "back") { arm(farArm); arm(nearArm); drawProps(); }
  else arm(farArm);
  drawGroundedHero(ctx, { x, y, size, pose: rig.pose, direction: rig.bodyDirection, frame: still ? 0 : frame.frame, appearance, shadow,
    rig: { gardening: true, crouch: rig.crouch, lean: rig.lean, fishingStance: rig.fishingStance },
    breathe: still ? 0 : Math.sin(phase * Math.PI * 2) * .004 });
  if (direction !== "back") { arm(nearArm); drawProps(); }
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
