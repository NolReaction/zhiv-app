import type { PixelDirection } from "@/features/mochlik/pixel-sprite";
import type { WorldBounds, WorldPoint } from "./tiled/types";

export type FishingAction = "walk" | "idle" | "cast" | "fish" | "bite" | "reel" | "catch" | "pack" | "trade" | "rest" | "greet";
/** Shared tackle follows the hands of either resident rig, without an image or AI dependency. */
export type FishingPropFrame = WorldPoint & {
  size: number; direction: PixelDirection; action: FishingAction; phase: number; frame: number;
  carryingFish: boolean; basketFilled?: boolean; waterTarget?: WorldPoint;
};
export type FishingPropAnchors = { grip?: WorldPoint; heldFish?: WorldPoint; basket?: WorldPoint; drawBasket?: boolean };
const tau = Math.PI * 2;
const boundedPhase = (frame: FishingPropFrame) => Math.max(0, Math.min(1, Number.isFinite(frame.phase) ? frame.phase : 0));
const waterAction = (frame: FishingPropFrame) => ["cast", "fish", "bite", "reel"].includes(frame.action)
  && frame.waterTarget && Number.isFinite(frame.waterTarget.x) && Number.isFinite(frame.waterTarget.y);
const between = (a: WorldPoint, b: WorldPoint, part: number): WorldPoint => ({ x: a.x + (b.x - a.x) * part, y: a.y + (b.y - a.y) * part });

/** Contains both a 48 px body and the complete cast/float arc, including rods
 * held overhead. The occluder painter needs this even when feet are offscreen. */
export function fishingPropsBounds(frame: FishingPropFrame): WorldBounds {
  const size = frame.size;
  let left = frame.x - size * 1.3, right = frame.x + size * 1.3;
  let top = frame.y - size * 2.5, bottom = frame.y + size * .3;
  if (waterAction(frame)) {
    left = Math.min(left, frame.waterTarget!.x - size * .3);
    right = Math.max(right, frame.waterTarget!.x + size * .3);
    top = Math.min(top, frame.waterTarget!.y - size * 1.1);
    bottom = Math.max(bottom, frame.waterTarget!.y + size * .3);
  }
  return { x: left, y: top, width: right - left, height: bottom - top };
}

function drawFish(ctx: CanvasRenderingContext2D, x: number, y: number, size: number, angle = 0) {
  ctx.save(); ctx.translate(x, y); ctx.rotate(angle);
  ctx.fillStyle = "#557d85"; ctx.strokeStyle = "#344f56"; ctx.lineWidth = size * .075;
  ctx.beginPath(); ctx.moveTo(-size * .32, 0); ctx.lineTo(-size * .75, -size * .28);
  ctx.lineTo(-size * .67, size * .3); ctx.closePath(); ctx.fill(); ctx.stroke();
  ctx.fillStyle = "#a9c3bf";
  ctx.beginPath(); ctx.ellipse(0, 0, size * .5, size * .24, 0, 0, tau); ctx.fill(); ctx.stroke();
  ctx.strokeStyle = "#d6e4cf"; ctx.lineWidth = size * .09;
  ctx.beginPath(); ctx.moveTo(-size * .22, -size * .05); ctx.lineTo(size * .2, -size * .08); ctx.stroke();
  ctx.fillStyle = "#223839"; ctx.beginPath(); ctx.arc(size * .28, -size * .04, size * .047, 0, tau); ctx.fill();
  ctx.restore();
}

function drawBasket(ctx: CanvasRenderingContext2D, x: number, y: number, size: number, filled: boolean) {
  ctx.save(); ctx.translate(x, y);
  ctx.strokeStyle = "#715035"; ctx.lineWidth = size * .09; ctx.lineCap = "round";
  ctx.beginPath(); ctx.ellipse(0, -size * .38, size * .3, size * .34, 0, Math.PI, tau); ctx.stroke();
  ctx.fillStyle = "#705239"; ctx.beginPath(); ctx.ellipse(0, -size * .33, size * .5, size * .18, 0, 0, tau); ctx.fill();
  if (filled) drawFish(ctx, size * .05, -size * .38, size * .9, -.2);
  ctx.fillStyle = "#bd925c";
  ctx.beginPath(); ctx.moveTo(-size * .48, -size * .3); ctx.lineTo(size * .48, -size * .3);
  ctx.lineTo(size * .36, size * .29); ctx.quadraticCurveTo(0, size * .43, -size * .36, size * .29);
  ctx.closePath(); ctx.fill(); ctx.stroke();
  ctx.strokeStyle = "#86633c"; ctx.lineWidth = size * .055;
  for (const offset of [-.2, .04, .23]) {
    ctx.beginPath(); ctx.moveTo(-size * .39, size * offset); ctx.lineTo(size * .39, size * offset); ctx.stroke();
  }
  ctx.strokeStyle = "#dec088";
  for (const offset of [-.22, 0, .22]) {
    ctx.beginPath(); ctx.moveTo(size * offset, -size * .24); ctx.lineTo(size * offset * .8, size * .27); ctx.stroke();
  }
  ctx.restore();
}

function drawRod(ctx: CanvasRenderingContext2D, grip: WorldPoint, tip: WorldPoint, size: number, tension: number) {
  const middle = between(grip, tip, .62);
  ctx.lineCap = "round"; ctx.strokeStyle = "#62472d"; ctx.lineWidth = size * .045;
  ctx.beginPath(); ctx.moveTo(grip.x, grip.y); ctx.lineTo(middle.x, middle.y); ctx.stroke();
  ctx.strokeStyle = "#d1b27c"; ctx.lineWidth = size * .028;
  ctx.beginPath(); ctx.moveTo(grip.x, grip.y); ctx.lineTo(middle.x, middle.y);
  ctx.quadraticCurveTo(tip.x, tip.y - size * .09 * tension, tip.x, tip.y + size * .04 * tension); ctx.stroke();
  ctx.strokeStyle = "#765639"; ctx.lineWidth = size * .08;
  const handle = between(grip, tip, .12);
  ctx.beginPath(); ctx.moveTo(grip.x, grip.y + size * .025); ctx.lineTo(handle.x, handle.y); ctx.stroke();
  ctx.fillStyle = "#586861"; ctx.beginPath(); ctx.arc(grip.x, grip.y + size * .04, size * .045, 0, tau); ctx.fill();
  ctx.strokeStyle = "#d4bf8c"; ctx.lineWidth = size * .015; ctx.stroke();
}

function drawTackle(ctx: CanvasRenderingContext2D, frame: FishingPropFrame, phase: number, still: boolean, anchors: FishingPropAnchors) {
  const size = frame.size;
  const side = frame.direction === "left" || frame.direction === "front" && anchors.grip && anchors.grip.x < frame.x ? -1 : 1;
  const grip = anchors.grip ?? { x: frame.x + side * size * .22, y: frame.y - size * .39 };
  const active = waterAction(frame);
  if (!active) {
    if (frame.action === "rest" || frame.action === "trade" || frame.action === "pack") return;
    const tip = { x: grip.x + side * size * .22, y: grip.y - size * 1.02 };
    drawRod(ctx, grip, tip, size, 0);
    ctx.strokeStyle = "#d4d4bda0"; ctx.lineWidth = size * .016;
    ctx.beginPath(); ctx.moveTo(tip.x, tip.y); ctx.lineTo(tip.x - side * size * .035, tip.y + size * .25); ctx.stroke();
    ctx.fillStyle = "#d87349"; ctx.beginPath(); ctx.ellipse(tip.x - side * size * .035, tip.y + size * .25,
      size * .025, size * .04, 0, 0, tau); ctx.fill();
    return;
  }
  const water = frame.waterTarget!, distance = Math.max(1, Math.hypot(water.x - grip.x, water.y - grip.y));
  const reach = Math.min(distance * .7, size * 1.03);
  const ready = { x: grip.x + (water.x - grip.x) / distance * reach,
    y: grip.y + (water.y - grip.y) / distance * reach - size * .48 };
  const cast = frame.action === "cast" ? phase : 1;
  const end = { x: ready.x - grip.x, y: ready.y - grip.y };
  const startAngle = Math.atan2(-size * 1.15, -end.x * .65), endAngle = Math.atan2(end.y, end.x);
  let angleDelta = endAngle - startAngle;
  // Interpolate an angle, not two tip positions: the latter shrinks the rod
  // through the hand when casting towards the bottom of the screen. A slightly
  // wider half-turn preserves the outside arc of a front-facing cast.
  while (angleDelta > Math.PI * 1.12) angleDelta -= tau;
  while (angleDelta < -Math.PI * 1.12) angleDelta += tau;
  const angle = startAngle + angleDelta * cast;
  const length = size * 1.15 + (Math.max(size * .65, Math.hypot(end.x, end.y)) - size * 1.15) * cast;
  const tip = { x: grip.x + Math.cos(angle) * length, y: grip.y + Math.sin(angle) * length };
  const tension = frame.action === "bite" ? 1 : frame.action === "reel" ? 1 - phase * .5 : 0;
  if (frame.action === "reel") tip.y -= phase * size * .24;
  drawRod(ctx, grip, tip, size, tension);
  let bobber = between(grip, water, cast);
  bobber.y -= Math.sin(cast * Math.PI) * size * .8;
  if (!still && frame.action === "fish") bobber.y += Math.sin(phase * tau * 6) * size * .009;
  if (!still && frame.action === "bite") bobber.y += (1 - Math.cos(phase * tau * 3)) * size * .035;
  if (frame.action === "reel") bobber = between(water, { x: grip.x + side * size * .36, y: grip.y - size * .25 }, phase);
  ctx.strokeStyle = "#e4e3c4c0"; ctx.lineWidth = size * .02;
  ctx.beginPath(); ctx.moveTo(tip.x, tip.y);
  ctx.quadraticCurveTo((tip.x + bobber.x) / 2, Math.max(tip.y, bobber.y) + size * .07 * (1 - tension), bobber.x, bobber.y); ctx.stroke();
  if (cast >= .99 && frame.action !== "reel") {
    const ring = still ? .35 : phase * (frame.action === "bite" ? 4 : 7) % 1;
    ctx.strokeStyle = `rgba(218,238,212,${(1 - ring) * .6})`; ctx.lineWidth = size * .022;
    ctx.beginPath(); ctx.ellipse(water.x, water.y + size * .025, size * (.055 + ring * .17),
      size * (.025 + ring * .065), 0, 0, tau); ctx.stroke();
  }
  ctx.fillStyle = "#f7e6b9"; ctx.beginPath(); ctx.ellipse(bobber.x, bobber.y, size * .035, size * .05, 0, 0, tau); ctx.fill();
  ctx.fillStyle = "#d76c42"; ctx.beginPath(); ctx.ellipse(bobber.x, bobber.y - size * .035, size * .032, size * .028, 0, 0, tau); ctx.fill();
  if (frame.action === "reel" && phase > .08) drawFish(ctx, bobber.x, bobber.y + size * .13, size * .22,
    -Math.PI / 2 + (still ? 0 : Math.sin(phase * tau * 3) * .22));
}

/** Reusable rod, line, float, catch and basket; all anchors are in world coordinates. */
export function drawFishingProps(ctx: CanvasRenderingContext2D, frame: FishingPropFrame, still: boolean,
  anchors: FishingPropAnchors = {}) {
  if (![frame.x, frame.y, frame.size].every(Number.isFinite) || frame.size <= 0) return;
  const phase = still ? .5 : boundedPhase(frame), size = frame.size, side = frame.direction === "left" ? -1 : 1;
  ctx.save();
  drawTackle(ctx, frame, phase, still, anchors);
  const basketOnGround = frame.action === "trade" || frame.action === "pack" || frame.action === "rest"
    || frame.action === "catch" || !!waterAction(frame);
  const basket = anchors.basket ?? { x: frame.x + side * size * (basketOnGround ? .4 : .23), y: frame.y - size * (basketOnGround ? .08 : .3) };
  if (anchors.drawBasket !== false && (frame.carryingFish || basketOnGround)) drawBasket(ctx, basket.x, basket.y, size * .27,
    frame.basketFilled ?? (frame.carryingFish && (frame.action !== "pack" || phase > .65)));
  if (frame.action === "catch" || frame.action === "pack" && frame.carryingFish && phase < .7) {
    const held = anchors.heldFish ?? { x: frame.x + side * size * .24, y: frame.y - size * .45 };
    const at = anchors.heldFish || frame.action !== "pack" ? held
      : between(held, { x: basket.x, y: basket.y - size * .14 }, Math.min(1, phase / .7));
    drawFish(ctx, at.x, at.y, size * .28, side * (still ? -.15 : -.15 + Math.sin(phase * tau * 2) * .14));
  }
  ctx.restore();
}
