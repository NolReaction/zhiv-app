import { TRADE_SHIP_SPRITE, tradeShipSpritePose, type TradeShipSpriteFrame } from "./trade-ship-sprite";

type Point = { x: number; y: number };

/** Authored against the unchanged PNG and the current southern berth (width 310). */
export const TRADE_SHIP_GANGWAY_RIG = {
  source: { x: 1008, y: 353 }, deckSource: { x: 1008, y: 409 }, openingSource: { x: 1008, y: 303 },
  referenceWidth: 310, shoreOffset: { x: 145, y: 36 }, width: 14,
} as const;

export type TradeShipGangwayFrame = Pick<TradeShipSpriteFrame, "x" | "y" | "width" | "heading" | "time" | "still" | "night" | "facing"> & {
  gangway: number;
};

const mix = (a: Point, b: Point, t: number): Point => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
const offset = (p: Point, direction: Point, amount: number): Point => ({ x: p.x + direction.x * amount, y: p.y + direction.y * amount });

/** The shore stays fixed; the hinge and supported deck tongue share the PNG's transform and bob. */
export function tradeShipGangwayGeometry(frame: TradeShipGangwayFrame) {
  if (![frame.x, frame.y, frame.width, frame.gangway].every(Number.isFinite)
    || frame.width <= 0 || frame.gangway <= 0) return null;
  const pose = tradeShipSpritePose(frame); if (!pose) return null;
  const rig = TRADE_SHIP_GANGWAY_RIG, sprite = TRADE_SHIP_SPRITE;
  const { scale, heading, bob, facing } = pose, berthScale = frame.width / rig.referenceWidth;
  const c = Math.cos(heading), s = Math.sin(heading);
  function rasterPoint(source: Point): Point {
    // Same order as the raster painter: mirror, bob, rotate about the placement pivot.
    const imageX = sprite.image.x + source.x * sprite.image.width / sprite.sourceWidth;
    const x = (facing < 0 ? sprite.width - imageX : imageX) - sprite.pivot.x;
    const y = sprite.image.y + source.y * sprite.image.height / sprite.sourceHeight + bob - sprite.pivot.y;
    return { x: frame.x + (sprite.pivot.x + x * c - y * s) * scale,
      y: frame.y + (sprite.pivot.y + x * s + y * c) * scale };
  }
  const from = rasterPoint(rig.source), deckAnchor = rasterPoint(rig.deckSource), openingAnchor = rasterPoint(rig.openingSource);
  const to = { x: frame.x + rig.shoreOffset.x * berthScale, y: frame.y + rig.shoreOffset.y * berthScale };
  const progress = Math.min(1, frame.gangway), across = { x: c, y: s };
  const width = rig.width * berthScale, tip = mix(from, to, progress);
  const span = Math.hypot(from.x - to.x, from.y - to.y);
  if (span < .001 * berthScale) return null;
  const down = { x: (from.x - to.x) / span, y: (from.y - to.y) / span };
  const shoreAcross = { x: 1, y: 0 }, shoreWidth = width * .82;
  const farLeft = offset(to, shoreAcross, -shoreWidth / 2), farRight = offset(to, shoreAcross, shoreWidth / 2);
  const nearLeft = offset(from, across, -width / 2), nearRight = offset(from, across, width / 2);
  const deckProgress = Math.min(1, progress * 2);
  // Continue the same ramp edges across the threshold. A separately rotated
  // rectangle made the supported end look like a loose, crooked second board.
  const deckLength = Math.hypot(deckAnchor.x - from.x, deckAnchor.y - from.y);
  const deckEnd = offset(from, down, deckLength), deckTip = mix(from, deckEnd, deckProgress);
  const overlap = .6 * berthScale / span, extension = -deckLength * deckProgress / span;
  const deckStart = mix(from, to, overlap);
  const fullExtension = -deckLength / span;
  const opening = Math.hypot(openingAnchor.x - from.x, openingAnchor.y - from.y) / span;
  return { from, to, tip, width, scale: berthScale, progress, across, down,
    nearLeft, nearRight, tipLeft: mix(nearLeft, farLeft, progress), tipRight: mix(nearRight, farRight, progress),
    surface: { deckLeft: mix(nearLeft, farLeft, fullExtension), deckRight: mix(nearRight, farRight, fullExtension),
      shoreLeft: farLeft, shoreRight: farRight, length: span + deckLength },
    opening: { left: mix(nearLeft, farLeft, opening), right: mix(nearRight, farRight, opening) },
    deck: { from: deckStart, to: deckEnd, tip: deckTip, progress: deckProgress,
      nearLeft: mix(nearLeft, farLeft, overlap), nearRight: mix(nearRight, farRight, overlap),
      tipLeft: mix(nearLeft, farLeft, extension), tipRight: mix(nearRight, farRight, extension) } };
}

type Geometry = NonNullable<ReturnType<typeof tradeShipGangwayGeometry>>;
function traceOutline(ctx: CanvasRenderingContext2D, points: Point[]) {
  ctx.moveTo(points[0].x, points[0].y);
  for (const point of points.slice(1)) ctx.lineTo(point.x, point.y);
  ctx.closePath();
}
function outline(ctx: CanvasRenderingContext2D, points: Point[]) {
  ctx.beginPath(); traceOutline(ctx, points);
}
function polygon(ctx: CanvasRenderingContext2D, points: Point[], fill: string | CanvasGradient) {
  ctx.fillStyle = fill; outline(ctx, points); ctx.fill();
}

/** A single plank plane. Both depth passes share its outline, grain and board spacing. */
function timber(ctx: CanvasRenderingContext2D, geometry: Geometry) {
  const { scale, surface, deck } = geometry;
  const left = surface.deckLeft, right = surface.deckRight, endLeft = surface.shoreLeft, endRight = surface.shoreRight;
  const { length } = surface;
  const points = [deck.tipLeft, geometry.tipLeft, geometry.tipRight, deck.tipRight];
  const shadow = { x: .35 * scale, y: .65 * scale };
  polygon(ctx, points.map(point => ({ x: point.x + shadow.x, y: point.y + shadow.y })), "rgba(32,34,20,.25)");
  ctx.save();
  try {
    outline(ctx, points); ctx.clip();
    const wood = ctx.createLinearGradient(left.x, left.y, right.x, right.y);
    wood.addColorStop(0, "#d9a45d"); wood.addColorStop(.3, "#bd8745"); wood.addColorStop(1, "#a36d34");
    polygon(ctx, [left, endLeft, endRight, right], wood);
    ctx.strokeStyle = "#624122"; ctx.lineWidth = .45 * scale; ctx.stroke();
    ctx.lineWidth = .28 * scale;
    for (let at = 4.2 * scale; at < length - .5 * scale; at += 4.2 * scale) {
      const t = at / length, a = mix(left, endLeft, t), b = mix(right, endRight, t);
      ctx.strokeStyle = "#7b542f"; ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
      const highlight = .5 * scale / length;
      const ah = mix(left, endLeft, Math.min(1, t + highlight)), bh = mix(right, endRight, Math.min(1, t + highlight));
      ctx.strokeStyle = "#d6aa6c"; ctx.beginPath(); ctx.moveTo(ah.x, ah.y); ctx.lineTo(bh.x, bh.y); ctx.stroke();
    }
    let board = 0;
    for (let at = 1.4 * scale; at < length - .6 * scale; at += 4.2 * scale) {
      const t = at / length, a = mix(left, endLeft, t), b = mix(right, endRight, t);
      const start = mix(a, b, .12 + board % 3 * .06), end = mix(a, b, .81 - board % 2 * .08);
      const bend = mix(start, end, .5); bend.y += (board % 2 ? .2 : -.2) * scale;
      ctx.strokeStyle = "#b37e40"; ctx.lineWidth = .24 * scale;
      ctx.beginPath(); ctx.moveTo(start.x, start.y); ctx.quadraticCurveTo(bend.x, bend.y, end.x, end.y); ctx.stroke();
      board++;
    }
    // Raised edges stay inside the existing posts, leaving the middle clear.
    const lip = Math.min(.06, .55 * scale / Math.hypot(right.x - left.x, right.y - left.y));
    polygon(ctx, [left, endLeft, mix(endLeft, endRight, lip), mix(left, right, lip)], "#b38950");
    polygon(ctx, [right, endRight, mix(endLeft, endRight, 1 - lip), mix(left, right, 1 - lip)], "#78522d");
    ctx.strokeStyle = "#dfb578"; ctx.lineWidth = .45 * scale;
    ctx.beginPath(); ctx.moveTo(left.x, left.y); ctx.lineTo(endLeft.x, endLeft.y); ctx.stroke();
  } finally { ctx.restore(); }
}

function beginWood(ctx: CanvasRenderingContext2D, frame: TradeShipGangwayFrame, geometry: Geometry) {
  const night = Number.isFinite(frame.night) ? Math.max(0, Math.min(1, frame.night!)) : 0;
  ctx.filter = night ? `brightness(${1 - night * .52}) saturate(${1 - night * .12})` : "none";
  ctx.globalAlpha *= Math.min(1, geometry.progress * 6);
  ctx.lineJoin = "round"; ctx.lineCap = "round";
}

/** Shore support goes BEFORE the PNG; the threshold and posts retain their original silhouette. */
export function drawTradeShipGangway(ctx: CanvasRenderingContext2D, frame: TradeShipGangwayFrame) {
  const geometry = tradeShipGangwayGeometry(frame); if (!geometry) return;
  const { surface, opening, scale } = geometry;
  const lane = [surface.deckLeft, opening.left, opening.right, surface.deckRight];
  const points = [surface.deckLeft, surface.deckRight, surface.shoreLeft, surface.shoreRight];
  const minX = Math.min(...points.map(point => point.x)) - 2 * scale;
  const minY = Math.min(...points.map(point => point.y)) - 2 * scale;
  const maxX = Math.max(...points.map(point => point.x)) + 2 * scale;
  const maxY = Math.max(...points.map(point => point.y)) + 2 * scale;
  ctx.save();
  try {
    beginWood(ctx, frame, geometry);
    // The fore lane is painted once, after the PNG. Excluding it here also
    // prevents a transparent doorway from doubling the bridge's fade opacity.
    ctx.beginPath(); ctx.rect(minX, minY, maxX - minX, maxY - minY);
    traceOutline(ctx, lane); ctx.clip("evenodd");
    timber(ctx, geometry);
  } finally { ctx.restore(); }
}

/** Reveal the same surface across the PNG threshold, without a second plate or hinge straps. */
export function drawTradeShipGangwayDeck(ctx: CanvasRenderingContext2D, frame: TradeShipGangwayFrame) {
  const geometry = tradeShipGangwayGeometry(frame); if (!geometry) return;
  const { surface, opening } = geometry;
  ctx.save();
  try {
    beginWood(ctx, frame, geometry);
    // Only the clear lane between the original posts is in front of the PNG.
    // Paint the complete surface through this mask so no contour or grain restarts at the threshold.
    outline(ctx, [surface.deckLeft, opening.left, opening.right, surface.deckRight]); ctx.clip();
    timber(ctx, geometry);
  } finally { ctx.restore(); }
}
