import type { PleskResidentFrame } from "./plesk-resident";
import { drawFishingProps, fishingPropsBounds, fishingCatchFrame, fishingTackleFrame, fishingBasketHandle, fishingPackCenter, fishingReelHand } from "./fishing-props";
import { fishingDirection } from "./forest-fishing";
import { fishingShoreRig, type FishingShoreRig } from "./fishing-shore-rig";
import { pleskSprite, pleskSpriteRig, PLESK_SPRITE_SIZE, type PleskSpriteRig } from "./plesk-sprite";
import type { WorldBounds, WorldPoint } from "./tiled/types";

/** Body-only bounds keep taps on a long fishing line from opening the trader. */
export function pleskHitBounds(frame: PleskResidentFrame): WorldBounds {
  return { x: frame.x - frame.size * .4, y: frame.y - frame.size * .84,
    width: frame.size * .8, height: frame.size * .88 };
}

export const pleskRenderBounds = fishingPropsBounds;
const usesShoreRig = (frame: PleskResidentFrame) => !frame.wildlife && (["cast", "fish", "bite", "reel", "catch", "pack"].includes(frame.action)
  || Boolean(frame.waterTarget && [frame.waterTarget.x, frame.waterTarget.y].every(Number.isFinite)
    && ["idle", "rest"].includes(frame.action)));
const shoreFrame = (frame: PleskResidentFrame) => ({ ...frame, rodId: "willow_rod", direction: frame.waterTarget
  && [frame.waterTarget.x, frame.waterTarget.y].every(Number.isFinite) ? fishingDirection(frame, frame.waterTarget) : frame.direction });
const usesCarryRig = (frame: PleskResidentFrame) => Boolean(!frame.wildlife && frame.carryingFish
  && ["walk", "idle", "greet", "trade"].includes(frame.action) && !usesShoreRig(frame));

/** Props interpolate in world coordinates rather than the raster's phase
 * buckets. In particular, mirrored catches land at the basket painter's exact
 * asymmetric fish center without a one-pixel release jump. */
export function pleskFishingAnchors(frame: PleskResidentFrame, rig: PleskSpriteRig, still: boolean) {
  if (usesShoreRig(frame)) return fishingShoreRig(shoreFrame(frame), still, "plesk");
  if (usesCarryRig(frame)) return { ...fishingShoreRig({ ...frame, rodId: "willow_rod", waterTarget: undefined,
    carryingBasket: true }, still, "plesk"), hideRod: true };
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
  return { grip: world(rig.grip), heldFish, basket, basketScale: .8,
    hideRod: frame.wildlife || ["walk", "greet"].includes(frame.action) || frame.action === "idle" && !frame.waterTarget
      || frame.carryingFish && ["walk", "idle", "greet"].includes(frame.action) };
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
  const shore = usesShoreRig(frame), carrying = usesCarryRig(frame), directed = shore ? shoreFrame(frame) : frame;
  const carryingBasket = !shore && frame.carryingFish && ["walk", "idle", "greet"].includes(frame.action);
  const props = { ...directed, rodId: "willow_rod", carryingBasket };
  const shoreRig = shore || carrying ? fishingShoreRig({ ...props, ...(carrying ? { waterTarget: undefined, carryingBasket: true } : {}) }, still, "plesk") : undefined;
  const sprite = pleskSprite(frame.action, directed.direction, frame.frame, frame.phase, still, props,
    shoreRig ? { externalArms: true, lean: shoreRig.lean, crouch: shoreRig.crouch, basketScale: .8 } : { basketScale: .8 });
  const rig = pleskSpriteRig(sprite)!;
  const size = frame.size, scale = size / PLESK_SPRITE_SIZE;
  const origin = { x: frame.x - size / 2, y: frame.y - rig.contact.bottom * scale };
  ctx.save();
  ctx.fillStyle = "rgba(28,43,35,.08)"; ctx.beginPath();
  ctx.ellipse(frame.x, frame.y + size * .012, size * .28, size * .06, 0, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = "rgba(28,43,35,.2)"; ctx.beginPath();
  ctx.ellipse(frame.x, frame.y, size * .2, size * .035, 0, 0, Math.PI * 2); ctx.fill();
  ctx.imageSmoothingEnabled = false;
  const anchors = shoreRig ? { ...shoreRig, ...(carrying ? { hideRod: true } : {}) } : pleskFishingAnchors(frame, rig, still);
  const back = directed.direction === "back";
  const arm = (part: FishingShoreRig["nearArm"], near: boolean, forearmOnly = false) => {
    // Match the body's 48 px grid: short stepped fur segments, not a smooth
    // thick tube whose bend can read as another leg at large zoom.
    const pixel = (point: WorldPoint) => ({ x: Math.round((point.x - origin.x) / scale),
      y: Math.round((point.y - origin.y) / scale) });
    const shoulder = pixel(part.shoulder), elbow = pixel(part.elbow), hand = pixel(part.hand);
    const stamp = (a: WorldPoint, b: WorldPoint, width: number, color: string) => {
      ctx.fillStyle = color;
      const steps = Math.max(Math.abs(b.x - a.x), Math.abs(b.y - a.y), 1);
      for (let step = 0; step <= steps; step++) {
        const x = Math.round(a.x + (b.x - a.x) * step / steps);
        const y = Math.round(a.y + (b.y - a.y) * step / steps);
        ctx.fillRect(origin.x + (x - 1) * scale, origin.y + (y - 1) * scale, width * scale, width * scale);
      }
    };
    if (!forearmOnly) stamp(shoulder, elbow, 3, "#3c5258"); stamp(elbow, hand, 3, "#3c5258");
    if (!forearmOnly) stamp(shoulder, elbow, 2, near && !back ? "#9ab7bb" : "#74949c");
    stamp(elbow, hand, 2, near && !back ? "#9ab7bb" : "#74949c");
    ctx.fillStyle = near && !back ? "#b8cecd" : "#74949c";
    ctx.fillRect(origin.x + (hand.x - 1) * scale, origin.y + (hand.y - 1) * scale, 2 * scale, 2 * scale);
  };
  const paw = (part: FishingShoreRig["nearArm"], near: boolean) => {
    const dx = part.elbow.x - part.hand.x, dy = part.elbow.y - part.hand.y, length = Math.max(.001, Math.hypot(dx, dy));
    const cuff = { x: part.hand.x + dx / length * Math.min(length, scale * 2), y: part.hand.y + dy / length * Math.min(length, scale * 2) };
    const cuffOnly = { ...part, shoulder: cuff, elbow: cuff };
    arm(cuffOnly, near, true);
  };
  if (shoreRig) {
    arm(shoreRig.farArm, false);
    arm(shoreRig.nearArm, true);
    if (back) drawFishingProps(ctx, props, still, anchors);
  }
  ctx.drawImage(sprite, origin.x, origin.y, size, size);
  if (shoreRig && !back) {
    if (["catch", "pack"].includes(frame.action) || carrying) arm(shoreRig.farArm, false, true);
    paw(shoreRig.farArm, false); paw(shoreRig.nearArm, true);
  }
  if (!shoreRig || !back) drawFishingProps(ctx, props, still, anchors);
  // Full paws belong behind props. Only two small fingers overlap the handle
  // or lower fish outline, leaving the fish's head and body readable.
  const tackle = fishingTackleFrame(props, still, anchors);
  if (tackle.visible) {
    const at = anchors.grip;
    ctx.fillStyle = "#b8cecd";
    ctx.fillRect(at.x - scale, at.y - scale, scale * 3, scale);
    ctx.fillRect(at.x - scale, at.y + scale, scale * 3, scale);
    if (shoreRig && ["idle", "cast", "fish", "bite", "reel"].includes(frame.action)) {
      const reel = fishingReelHand(props, still || frame.action !== "reel", anchors);
      if (Math.hypot(reel.x - shoreRig.farHand.x, reel.y - shoreRig.farHand.y) <= scale) {
        ctx.fillStyle = "#9ab7bb";
        ctx.fillRect(shoreRig.farHand.x - scale * .55, shoreRig.farHand.y - scale * .35, scale * 1.1, scale * .7);
      }
    }
  }
  if (carryingBasket) {
    const handle = fishingBasketHandle(anchors.basket, size, .8);
    ctx.fillStyle = "#9ab7bb";
    ctx.fillRect(handle.x - scale, handle.y - scale, scale, scale * 2);
    ctx.fillRect(handle.x + scale, handle.y - scale, scale, scale * 2);
  }
  const fish = fishingCatchFrame(props, still, anchors);
  if (fish.visible && (frame.action === "pack" || frame.phase >= .18)) {
    const wrist = shoreRig ? shoreRig.farHand : fish.wrist;
    ctx.fillStyle = "#9ab7bb";
    ctx.fillRect(wrist.x - scale, wrist.y, scale, scale);
    ctx.fillRect(wrist.x + scale, wrist.y, scale, scale);
  }
  ctx.restore();
}
