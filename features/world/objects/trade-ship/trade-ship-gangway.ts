import { TRADE_SHIP_SPRITE, tradeShipSpritePose, type TradeShipSpriteFrame } from "./trade-ship-sprite";

type Point = { x: number; y: number };

/** Authored against the unchanged PNG and the current southern berth (width 310). */
export const TRADE_SHIP_GANGWAY_RIG = {
  source: { x: 1008, y: 353 }, deckSource: { x: 1008, y: 409 },
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
  const from = rasterPoint(rig.source), deckAnchor = rasterPoint(rig.deckSource);
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
  return { from, to, tip, width, scale: berthScale, progress, across, down,
    nearLeft, nearRight, tipLeft: mix(nearLeft, farLeft, progress), tipRight: mix(nearRight, farRight, progress),
    deck: { from: deckStart, to: deckEnd, tip: deckTip, progress: deckProgress,
      nearLeft: mix(nearLeft, farLeft, overlap), nearRight: mix(nearRight, farRight, overlap),
      tipLeft: mix(nearLeft, farLeft, extension), tipRight: mix(nearRight, farRight, extension) } };
}

type Geometry = NonNullable<ReturnType<typeof tradeShipGangwayGeometry>>;
function polygon(ctx: CanvasRenderingContext2D, points: Point[], fill: string | CanvasGradient) {
  ctx.fillStyle = fill; ctx.beginPath(); ctx.moveTo(points[0].x, points[0].y);
  for (const point of points.slice(1)) ctx.lineTo(point.x, point.y);
  ctx.closePath(); ctx.fill();
}

/** A shallow plank plane, with thickness and narrow side lips rather than ladder rungs. */
function timber(ctx: CanvasRenderingContext2D, left: Point, right: Point, endLeft: Point, endRight: Point, scale: number, supported = false) {
  const center = mix(left, right, .5), end = mix(endLeft, endRight, .5);
  const length = Math.hypot(end.x - center.x, end.y - center.y);
  if (length < .00001) return;
  const shadow = { x: (supported ? .35 : 1.1) * scale, y: (supported ? .55 : 1.6) * scale };
  const drop = { x: 0, y: (supported ? .55 : 1.1) * scale };
  const points = [left, endLeft, endRight, right];
  polygon(ctx, points.map(point => ({ x: point.x + shadow.x, y: point.y + shadow.y })), "rgba(32,34,20,.25)");
  polygon(ctx, [right, endRight, { x: endRight.x + drop.x, y: endRight.y + drop.y },
    { x: right.x + drop.x, y: right.y + drop.y }], "#57402a");
  if (supported) polygon(ctx, [endLeft, endRight, { x: endRight.x, y: endRight.y + drop.y },
    { x: endLeft.x, y: endLeft.y + drop.y }], "#78502b");
  const wood = ctx.createLinearGradient(left.x, left.y, right.x, right.y);
  wood.addColorStop(0, "#d9a45d"); wood.addColorStop(.3, "#bd8745"); wood.addColorStop(1, "#a36d34");
  polygon(ctx, points, wood);
  ctx.strokeStyle = "#624122"; ctx.lineWidth = .45 * scale; ctx.stroke();
  ctx.lineWidth = .28 * scale;
  for (let at = 4.2 * scale; at < length - .5 * scale; at += 4.2 * scale) {
    const t = at / length, a = mix(left, endLeft, t), b = mix(right, endRight, t);
    ctx.strokeStyle = "#7b542f"; ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
    const highlight = .5 * scale / length;
    const ah = mix(left, endLeft, Math.min(1, t + highlight)), bh = mix(right, endRight, Math.min(1, t + highlight));
    ctx.strokeStyle = "rgba(241,203,139,.45)"; ctx.beginPath(); ctx.moveTo(ah.x, ah.y); ctx.lineTo(bh.x, bh.y); ctx.stroke();
  }
  let board = 0;
  for (let at = 1.4 * scale; at < length - .6 * scale; at += 4.2 * scale) {
    const t = at / length, a = mix(left, endLeft, t), b = mix(right, endRight, t);
    const start = mix(a, b, .12 + board % 3 * .06), end = mix(a, b, .81 - board % 2 * .08);
    const bend = mix(start, end, .5); bend.y += (board % 2 ? .2 : -.2) * scale;
    ctx.strokeStyle = "rgba(99,57,24,.2)"; ctx.lineWidth = .24 * scale;
    ctx.beginPath(); ctx.moveTo(start.x, start.y); ctx.quadraticCurveTo(bend.x, bend.y, end.x, end.y); ctx.stroke();
    board++;
  }
  // Raised edges stay inside the existing posts, leaving the middle clear.
  const lip = Math.min(.09, .9 * scale / Math.hypot(right.x - left.x, right.y - left.y));
  polygon(ctx, [left, endLeft, mix(endLeft, endRight, lip), mix(left, right, lip)], "#b38950");
  polygon(ctx, [right, endRight, mix(endLeft, endRight, 1 - lip), mix(left, right, 1 - lip)], "#78522d");
  ctx.strokeStyle = "#dfb578"; ctx.lineWidth = .45 * scale;
  ctx.beginPath(); ctx.moveTo(left.x, left.y); ctx.lineTo(endLeft.x, endLeft.y); ctx.stroke();
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
  ctx.save();
  try {
    beginWood(ctx, frame, geometry);
    timber(ctx, geometry.nearLeft, geometry.nearRight, geometry.tipLeft, geometry.tipRight, geometry.scale);
  } finally { ctx.restore(); }
}

/** Short supported tongue goes AFTER the PNG, visibly joining the ramp to the open deck. */
export function drawTradeShipGangwayDeck(ctx: CanvasRenderingContext2D, frame: TradeShipGangwayFrame) {
  const geometry = tradeShipGangwayGeometry(frame); if (!geometry) return;
  const { deck, across, down, from, width, scale } = geometry;
  ctx.save();
  try {
    beginWood(ctx, frame, geometry);
    timber(ctx, deck.nearLeft, deck.nearRight, deck.tipLeft, deck.tipRight, scale, true);
    // Two small straps sit on the supported end, not on the railing posts.
    for (const side of [-1, 1]) {
      const seat = offset(offset(from, across, side * width * .3), down, 1.1 * scale * deck.progress);
      const a = offset(seat, across, -.7 * scale), b = offset(seat, across, .7 * scale);
      polygon(ctx, [a, b, offset(b, down, 2.5 * scale * deck.progress), offset(a, down, 2.5 * scale * deck.progress)], "#66583d");
      ctx.fillStyle = "#c6af77"; ctx.beginPath();
      const bolt = offset(seat, down, 1.2 * scale * deck.progress);
      ctx.arc(bolt.x, bolt.y, .32 * scale * deck.progress, 0, Math.PI * 2); ctx.fill();
    }
  } finally { ctx.restore(); }
}
