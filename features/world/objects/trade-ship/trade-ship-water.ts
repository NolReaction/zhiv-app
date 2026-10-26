/** Native PNG lower hull edge, stern → bow. This is water contact, never the deck rail. */
export const TRADE_SHIP_WATERLINE = [
  [120, 587], [200, 673], [300, 705], [400, 728], [600, 764], [800, 792],
  [1000, 808], [1200, 813], [1400, 803], [1500, 771], [1600, 724], [1650, 660], [1700, 568],
] as const;

export type TradeShipWaterFrame = {
  time: number; night: number; velocityX: number; velocityY: number; still?: boolean;
};
const finite = (value: number) => Number.isFinite(value) ? value : 0;
const clamp = (value: number) => Math.max(0, Math.min(1, finite(value)));
const ratio = 660 / 1774;
const waterline = TRADE_SHIP_WATERLINE.map(([x, y]) => ({ x: 70 + x * ratio, y: 60 + y * ratio }));

/** Stateless, seeded geometry: the same motion/time always produces the same frame. Units are art pixels. */
export function tradeShipWaterGeometry(frame: TradeShipWaterFrame) {
  const vx = Math.max(-1e6, Math.min(1e6, finite(frame.velocityX)));
  const vy = Math.max(-1e6, Math.min(1e6, finite(frame.velocityY))), speed = Math.hypot(vx, vy);
  const strength = clamp(speed / 95), moving = speed > .05;
  const direction = moving ? { x: vx / speed, y: vy / speed } : { x: 0, y: 0 };
  const support = (sign: number) => waterline.reduce((best, point) =>
    sign * (point.x * direction.x + point.y * direction.y) > sign * (best.x * direction.x + best.y * direction.y) ? point : best);
  return { waterline, speed, strength, direction, bow: support(1), stern: support(-1),
    time: frame.still ? 0 : Math.max(0, finite(frame.time)) % 1e6, night: clamp(frame.night) };
}

function trace(ctx: CanvasRenderingContext2D, points: readonly { x: number; y: number }[], offset: number) {
  ctx.beginPath(); ctx.moveTo(points[0].x, points[0].y + offset);
  for (const point of points.slice(1)) ctx.lineTo(point.x, point.y + offset);
}

/** Paint under the PNG, before its bob. No canvas allocation, readback or retained frame history. */
export function drawTradeShipWater(ctx: CanvasRenderingContext2D, frame: TradeShipWaterFrame) {
  const geometry = tradeShipWaterGeometry(frame), { waterline: edge, time, night, strength, direction, bow, stern } = geometry;
  ctx.save();
  try {
    ctx.filter = "none"; ctx.globalCompositeOperation = "source-over"; ctx.globalAlpha = 1;
    ctx.lineCap = "round"; ctx.lineJoin = "round";
    // A narrow submerged contact band follows the actual hull instead of a large oval shadow.
    ctx.strokeStyle = "rgba(10,46,48,.13)"; ctx.lineWidth = 14;
    trace(ctx, edge, 3); ctx.stroke();
    ctx.strokeStyle = "rgba(12,48,48,.19)"; ctx.lineWidth = 5;
    trace(ctx, edge, 1.5); ctx.stroke();
    ctx.strokeStyle = night > .5 ? "#86b6b5" : "#d5e8d8";
    // Short independent ripples leave gaps; even a docked hull displaces a little water.
    for (let i = 1; i < edge.length - 1; i++) {
      const first = edge[i], last = edge[i + 1], seed = i * 2.399963;
      const pulse = .5 + .5 * Math.sin(time * .82 + seed);
      const amount = .22 + pulse * .2, offset = 3.3 + pulse * 3;
      ctx.globalAlpha = (.13 + strength * .12) * (.62 + pulse * .38);
      ctx.lineWidth = .8 + strength * .5;
      ctx.beginPath(); ctx.moveTo(first.x + (last.x - first.x) * .13, first.y + (last.y - first.y) * .13 + offset);
      ctx.quadraticCurveTo(first.x + (last.x - first.x) * .5, first.y + (last.y - first.y) * .5 + offset + 1.5,
        first.x + (last.x - first.x) * (.55 + amount), first.y + (last.y - first.y) * (.55 + amount) + offset);
      ctx.stroke();
    }
    if (!strength) return;
    const perpendicular = { x: -direction.y, y: direction.x };
    // Trailing wakes originate at the hull's support point opposite actual travel, including reverse motion.
    for (let i = 0; i < 11; i++) {
      const phase = ((time * (.22 + strength * .19) + i * .61803398875) % 1 + 1) % 1;
      const distance = 5 + phase * (35 + strength * 130), spread = 3 + phase * (8 + strength * 20);
      const x = stern.x - direction.x * distance, y = stern.y - direction.y * distance + 3;
      ctx.globalAlpha = strength * Math.pow(1 - phase, 1.7) * .30;
      ctx.lineWidth = .8 + (1 - phase) * 1.2;
      for (const side of [-1, 1]) {
        ctx.beginPath(); ctx.moveTo(x + perpendicular.x * spread * side, y + perpendicular.y * spread * side);
        ctx.quadraticCurveTo(x - direction.x * 5 + perpendicular.x * (spread + 4) * side,
          y - direction.y * 5 + perpendicular.y * (spread + 4) * side,
          x - direction.x * 10 + perpendicular.x * (spread + 1) * side,
          y - direction.y * 10 + perpendicular.y * (spread + 1) * side); ctx.stroke();
      }
    }
    // A compact broken pressure crest at the leading edge, rather than rails across the deck.
    for (let i = 0; i < 5; i++) {
      const side = i - 2, phase = Math.sin(time * 1.8 + i * 2.4);
      const x = bow.x + direction.x * (3 + phase), y = bow.y + direction.y * (3 + phase) + 2;
      ctx.globalAlpha = strength * (.25 + .05 * phase); ctx.lineWidth = 1.1 + strength * .7;
      ctx.beginPath(); ctx.moveTo(x + perpendicular.x * side * 3, y + perpendicular.y * side * 3);
      ctx.lineTo(x + perpendicular.x * (side + .65) * 3, y + perpendicular.y * (side + .65) * 3); ctx.stroke();
    }
  } finally { ctx.restore(); }
}
