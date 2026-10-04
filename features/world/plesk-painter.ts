import type { PleskResidentFrame } from "./plesk-resident";
import { drawFishingProps, fishingPropsBounds, fishingCatchFrame, fishingTackleFrame } from "./fishing-props";
import { pleskSprite, pleskSpriteRig, PLESK_SPRITE_SIZE } from "./plesk-sprite";
import type { WorldBounds, WorldPoint } from "./tiled/types";

/** Body-only bounds keep taps on a long fishing line from opening the trader. */
export function pleskHitBounds(frame: PleskResidentFrame): WorldBounds {
  return { x: frame.x - frame.size * .4, y: frame.y - frame.size * .84,
    width: frame.size * .8, height: frame.size * .88 };
}

export const pleskRenderBounds = fishingPropsBounds;

/** The complete 48 px joint rig shares contact and hand anchors with the prop
 * painter. Only local limb geometry changes; feet do not bounce off the shore. */
export function drawPleskResident(ctx: CanvasRenderingContext2D, frame: PleskResidentFrame, still: boolean) {
  if (![frame.x, frame.y, frame.size].every(Number.isFinite) || frame.size <= 0) return;
  const sprite = pleskSprite(frame.action, frame.direction, frame.frame, frame.phase, still, frame);
  const rig = pleskSpriteRig(sprite)!;
  const size = frame.size, scale = size / PLESK_SPRITE_SIZE;
  const origin = { x: frame.x - size / 2, y: frame.y - rig.contact.bottom * scale };
  const world = (point: WorldPoint): WorldPoint => ({ x: origin.x + point.x * scale, y: origin.y + point.y * scale });
  ctx.save();
  ctx.fillStyle = "rgba(28,43,35,.08)"; ctx.beginPath();
  ctx.ellipse(frame.x, frame.y + size * .012, size * .28, size * .06, 0, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = "rgba(28,43,35,.2)"; ctx.beginPath();
  ctx.ellipse(frame.x, frame.y, size * .2, size * .035, 0, 0, Math.PI * 2); ctx.fill();
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(sprite, origin.x, origin.y, size, size);
  const props = { ...frame, rodId: "willow_rod" };
  const anchors = { grip: world(rig.grip), heldFish: world(rig.heldFish), basket: world(rig.basket) };
  drawFishingProps(ctx, props, still, anchors);
  // Full paws belong behind props. Only two small fingers overlap the handle
  // or lower fish outline, leaving the fish's head and body readable.
  const tackle = fishingTackleFrame(props, still, anchors);
  if (tackle.visible) {
    const at = anchors.grip;
    ctx.fillStyle = "#b8cecd";
    ctx.fillRect(at.x - scale, at.y - scale, scale * 3, scale);
    ctx.fillRect(at.x - scale, at.y + scale, scale * 3, scale);
  }
  const fish = fishingCatchFrame(props, still, anchors);
  if (fish.visible && (frame.action === "pack" || frame.phase >= .18)) {
    ctx.fillStyle = "#9ab7bb";
    ctx.fillRect(fish.wrist.x - scale, fish.wrist.y, scale, scale);
    ctx.fillRect(fish.wrist.x + scale, fish.wrist.y, scale, scale);
  }
  ctx.restore();
}
