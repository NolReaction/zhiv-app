import type { PleskResidentFrame } from "./plesk-resident";
import { drawFishingProps, fishingPropsBounds, fishingCatchFrame, fishingTackleFrame, fishingBasketHandle, fishingPackCenter } from "./fishing-props";
import { pleskSprite, pleskSpriteRig, PLESK_SPRITE_SIZE, type PleskSpriteRig } from "./plesk-sprite";
import type { WorldBounds, WorldPoint } from "./tiled/types";

/** Body-only bounds keep taps on a long fishing line from opening the trader. */
export function pleskHitBounds(frame: PleskResidentFrame): WorldBounds {
  return { x: frame.x - frame.size * .4, y: frame.y - frame.size * .84,
    width: frame.size * .8, height: frame.size * .88 };
}

export const pleskRenderBounds = fishingPropsBounds;

/** Props interpolate in world coordinates rather than the raster's phase
 * buckets. In particular, mirrored catches land at the basket painter's exact
 * asymmetric fish center without a one-pixel release jump. */
export function pleskFishingAnchors(frame: PleskResidentFrame, rig: PleskSpriteRig, still: boolean) {
  const scale = frame.size / PLESK_SPRITE_SIZE;
  const world = (point: WorldPoint): WorldPoint => ({ x: frame.x - frame.size / 2 + point.x * scale,
    y: frame.y - rig.contact.bottom * scale + point.y * scale });
  const basket = world(rig.basket), resting = world(rig.restingFish);
  const phase = still ? .5 : Math.max(0, Math.min(1, Number.isFinite(frame.phase) ? frame.phase : 0));
  let heldFish = world(rig.heldFish);
  if (frame.action === "pack") {
    heldFish = fishingPackCenter(resting, basket, frame.size, phase);
  } else if (frame.action === "catch") {
    heldFish = { x: resting.x, y: resting.y - Math.sin(phase * Math.PI) * 2 * scale };
  }
  return { grip: world(rig.grip), heldFish, basket,
    hideRod: frame.wildlife || frame.carryingFish && ["walk", "idle", "greet"].includes(frame.action) };
}

/** The insect lands on the same visible raised paw used by the pixel painter. */
export function pleskWildlifeHand(frame: PleskResidentFrame): WorldPoint {
  const sprite = pleskSprite(frame.carryingFish ? "rest" : "greet", frame.direction, 0, .5, false);
  const rig = pleskSpriteRig(sprite)!, hand = rig.palms.find(palm => palm.near)!.position;
  return { x: frame.x + (hand.x - 24) * frame.size / 48,
    y: frame.y + (hand.y - rig.contact.bottom) * frame.size / 48 };
}

/** The complete 48 px joint rig shares contact and hand anchors with the prop
 * painter. Only local limb geometry changes; feet do not bounce off the shore. */
export function drawPleskResident(ctx: CanvasRenderingContext2D, frame: PleskResidentFrame, still: boolean) {
  if (![frame.x, frame.y, frame.size].every(Number.isFinite) || frame.size <= 0) return;
  const carryingBasket = frame.carryingFish && ["walk", "idle", "greet"].includes(frame.action);
  const props = { ...frame, rodId: "willow_rod", carryingBasket };
  const sprite = pleskSprite(frame.action, frame.direction, frame.frame, frame.phase, still, props);
  const rig = pleskSpriteRig(sprite)!;
  const size = frame.size, scale = size / PLESK_SPRITE_SIZE;
  const origin = { x: frame.x - size / 2, y: frame.y - rig.contact.bottom * scale };
  ctx.save();
  ctx.fillStyle = "rgba(28,43,35,.08)"; ctx.beginPath();
  ctx.ellipse(frame.x, frame.y + size * .012, size * .28, size * .06, 0, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = "rgba(28,43,35,.2)"; ctx.beginPath();
  ctx.ellipse(frame.x, frame.y, size * .2, size * .035, 0, 0, Math.PI * 2); ctx.fill();
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(sprite, origin.x, origin.y, size, size);
  const anchors = pleskFishingAnchors(frame, rig, still);
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
  if (carryingBasket) {
    const handle = fishingBasketHandle(anchors.basket, size);
    ctx.fillStyle = "#9ab7bb";
    ctx.fillRect(handle.x - scale, handle.y - scale, scale, scale * 2);
    ctx.fillRect(handle.x + scale, handle.y - scale, scale, scale * 2);
  }
  const fish = fishingCatchFrame(props, still, anchors);
  if (fish.visible && (frame.action === "pack" || frame.phase >= .18)) {
    ctx.fillStyle = "#9ab7bb";
    ctx.fillRect(fish.wrist.x - scale, fish.wrist.y, scale, scale);
    ctx.fillRect(fish.wrist.x + scale, fish.wrist.y, scale, scale);
  }
  ctx.restore();
}
