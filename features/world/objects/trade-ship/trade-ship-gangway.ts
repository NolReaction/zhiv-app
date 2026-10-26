import { TRADE_SHIP_SPRITE, type TradeShipSpriteFrame } from "./trade-ship-sprite";

/** Authored against the unchanged PNG and the current southern berth (width 310). */
export const TRADE_SHIP_GANGWAY_RIG = {
  source: { x: 1008, y: 353 },
  referenceWidth: 310, shoreOffset: { x: 145, y: 36 }, width: 14,
} as const;

export type TradeShipGangwayFrame = Pick<TradeShipSpriteFrame, "x" | "y" | "width" | "heading" | "time" | "still" | "night"> & {
  gangway: number;
};

/** The shore end stays fixed while the hinge follows the PNG's subtle bob. */
export function tradeShipGangwayGeometry(frame: TradeShipGangwayFrame) {
  if (![frame.x, frame.y, frame.width, frame.gangway].every(Number.isFinite)
    || frame.width <= 0 || frame.gangway <= 0) return null;
  const rig = TRADE_SHIP_GANGWAY_RIG, sprite = TRADE_SHIP_SPRITE;
  const scale = frame.width / sprite.width, berthScale = frame.width / rig.referenceWidth;
  const heading = sprite.baseHeading + Math.max(-sprite.maxHeading, Math.min(sprite.maxHeading,
    Number.isFinite(frame.heading) ? frame.heading! : 0));
  const time = Number.isFinite(frame.time) ? Math.max(0, frame.time!) : 0;
  const bob = frame.still ? 0 : Math.sin(time * 1.45) * .8;
  // Same order as the raster painter: mirror, bob, rotate about the placement pivot.
  const x = sprite.width - sprite.image.x - rig.source.x * sprite.image.width / sprite.sourceWidth - sprite.pivot.x;
  const y = sprite.image.y + rig.source.y * sprite.image.height / sprite.sourceHeight + bob - sprite.pivot.y;
  const from = {
    x: frame.x + (sprite.pivot.x + x * Math.cos(heading) - y * Math.sin(heading)) * scale,
    y: frame.y + (sprite.pivot.y + x * Math.sin(heading) + y * Math.cos(heading)) * scale,
  };
  const to = { x: frame.x + rig.shoreOffset.x * berthScale, y: frame.y + rig.shoreOffset.y * berthScale };
  const progress = Math.min(1, frame.gangway);
  return { from, to, tip: { x: from.x + (to.x - from.x) * progress, y: from.y + (to.y - from.y) * progress },
    width: rig.width * berthScale, scale: berthScale, progress };
}

/** Separate wooden support, painted BEFORE the PNG so its threshold covers the joint. */
export function drawTradeShipGangway(ctx: CanvasRenderingContext2D, frame: TradeShipGangwayFrame) {
  const geometry = tradeShipGangwayGeometry(frame); if (!geometry) return;
  const { from, to, width, scale, progress } = geometry;
  const length = Math.hypot(to.x - from.x, to.y - from.y) * progress;
  if (length <= 0) return;
  const half = width / 2, night = Number.isFinite(frame.night) ? Math.max(0, Math.min(1, frame.night!)) : 0;
  ctx.save();
  try {
    ctx.translate(from.x, from.y); ctx.rotate(Math.atan2(to.y - from.y, to.x - from.x));
    ctx.filter = night ? `brightness(${1 - night * .52}) saturate(${1 - night * .12})` : "none";
    ctx.lineJoin = "round"; ctx.lineCap = "round";
    // The small offset below the deck reads as thickness rather than a floating strip.
    ctx.fillStyle = "rgba(30,43,28,.23)"; ctx.fillRect(2 * scale, -half + 2 * scale, length, width);
    ctx.fillStyle = "#493824"; ctx.fillRect(0, -half, length, width);
    const timber = ctx.createLinearGradient(0, -half, 0, half);
    timber.addColorStop(0, "#d0aa69"); timber.addColorStop(.35, "#b58b50"); timber.addColorStop(1, "#8d6339");
    ctx.fillStyle = timber; ctx.fillRect(0, -half + scale, length, width - 2 * scale);
    ctx.strokeStyle = "#76522e"; ctx.lineWidth = .7 * scale;
    for (let at = 4.5 * scale; at + .7 * scale < length; at += 4.5 * scale) {
      ctx.beginPath(); ctx.moveTo(at, -half + scale); ctx.lineTo(at, half - scale); ctx.stroke();
      ctx.strokeStyle = "rgba(238,205,139,.45)";
      ctx.beginPath(); ctx.moveTo(at + .7 * scale, -half + scale); ctx.lineTo(at + .7 * scale, half - scale); ctx.stroke();
      ctx.strokeStyle = "#76522e";
    }
    // Low side lips stay beneath the existing gap's posts and leave a clear walkway.
    ctx.fillStyle = "#73502d";
    ctx.fillRect(0, -half, length, 1.4 * scale); ctx.fillRect(0, half - 1.4 * scale, length, 1.4 * scale);
    ctx.fillStyle = "#dfb87a"; ctx.fillRect(0, -half, length, .6 * scale);
    ctx.fillStyle = "#e0b677"; ctx.fillRect(Math.max(0, length - 1.3 * scale), -half, Math.min(length, 1.3 * scale), width);
  } finally { ctx.restore(); }
}
