import { TRADE_SHIP_ART, shipColors, shipFace, shipLine, shipPoint, type ShipArtOptions, type ShipPoint } from "./trade-ship-art";
import { drawTradeShipHull, drawTradeShipFrontRail } from "./trade-ship-hull";
import { drawTradeShipCabin } from "./trade-ship-cabin";
import { drawTradeShipProps, drawTradeShipFenders } from "./trade-ship-props";
import { drawTradeShipWater } from "./trade-ship-water";

export type TradeShipFrame = {
  /** Top-left of the 800 × 500 illustration box, in the caller's coordinates. */
  x: number; y: number; width: number;
  time?: number; night?: number; gate?: number; ramp?: number; cargo?: number; still?: boolean;
  /** Left is the harbour approach. Heading is a small screen-space course correction. */
  facing?: "left" | "right"; heading?: number;
  /** Optional scene-only contact shadow and speed-dependent wash; omitted from PNG exports. */
  water?: boolean; velocityX?: number; velocityY?: number;
};
const unit = (value: number | undefined) => Number.isFinite(value) ? Math.max(0, Math.min(1, value!)) : 0;

/** A real rigid leaf rotating about the far-left jamb, not a rotated bitmap. */
export function tradeShipGatePoint(opening: number, along: number, height = 0): ShipPoint {
  const angle = unit(opening) * Math.PI / 2;
  return shipPoint(20 + along * Math.cos(angle), -73 + along * Math.sin(angle), height);
}

function drawGate(ctx: CanvasRenderingContext2D, options: ShipArtOptions, opening: number) {
  const c = shipColors(options.night);
  const point = (along: number, height: number) => tradeShipGatePoint(opening, along, height);
  const face = (start: number, end: number, bottom: number, top: number, color: string) => {
    const points = [point(start, bottom), point(end, bottom), point(end, top), point(start, top)];
    ctx.beginPath(); ctx.moveTo(points[0].x, points[0].y);
    for (const p of points.slice(1)) ctx.lineTo(p.x, p.y);
    ctx.closePath(); ctx.fillStyle = color; ctx.fill(); ctx.strokeStyle = c.outline; ctx.lineWidth = 1.4; ctx.stroke();
  };
  face(2, 72, 3, 16, c.greenDark); face(2, 72, 16, 27, c.green);
  face(1, 74, 37, 43, c.woodLight);
  for (const along of [3, 71]) face(along - 2, along + 2, 3, 40, c.wood);
  for (const along of [25, 50]) face(along - 1.2, along + 1.2, 25, 38, c.iron);
  shipLine(ctx, [point(3, 42), point(72, 42)], c.deckLight, 1);
  const latch = point(66, 28); ctx.fillStyle = c.copperLight; ctx.beginPath(); ctx.arc(latch.x, latch.y, 1.7, 0, Math.PI * 2); ctx.fill();
}

function drawRamp(ctx: CanvasRenderingContext2D, night: number, extension: number) {
  if (extension <= 0) return;
  const c = shipColors(night), end = -73 - 85 * extension;
  shipFace(ctx, [[26, -73, 2], [89, -73, 2], [89, end, 7], [26, end, 7]], c.woodDark, c.outline, 2);
  shipFace(ctx, [[29, -73, 4], [86, -73, 4], [86, end, 9], [29, end, 9]], c.deck, c.outline, 1);
  for (let at = 8; at < 85 * extension; at += 9) {
    const height = 4 + at / 85 * 5;
    shipLine(ctx, [shipPoint(29, -73 - at, height), shipPoint(86, -73 - at, height)], c.woodDark, 1);
    shipLine(ctx, [shipPoint(29, -74 - at, height), shipPoint(86, -74 - at, height)], c.deckLight, .7);
  }
}

function drawSteam(ctx: CanvasRenderingContext2D, options: ShipArtOptions) {
  if (options.still) return;
  const outlet = shipPoint(-105, -10, 210);
  for (let i = 0; i < 5; i++) {
    const progress = ((options.time * .17 + i / 5) % 1 + 1) % 1;
    const radius = 5 + progress * 15, x = outlet.x - progress * 23 + Math.sin(progress * 4 + i) * 3;
    const y = outlet.y - 8 - progress * 49;
    const cloud = ctx.createRadialGradient(x, y, 0, x, y, radius);
    cloud.addColorStop(0, `rgba(219, 225, 215, ${.2 * (1 - progress)})`); cloud.addColorStop(1, "rgba(219, 225, 215, 0)");
    ctx.fillStyle = cloud; ctx.beginPath(); ctx.arc(x, y, radius, 0, Math.PI * 2); ctx.fill();
  }
}

/** Pure Canvas illustration; time and animation pose are owned by the caller. */
export function drawTradeShip(ctx: CanvasRenderingContext2D, frame: TradeShipFrame) {
  if (!Number.isFinite(frame.x) || !Number.isFinite(frame.y) || !Number.isFinite(frame.width) || frame.width <= 0) return;
  const options: ShipArtOptions = {
    time: Number.isFinite(frame.time) ? Math.max(0, frame.time!) : 0,
    night: unit(frame.night), still: frame.still ?? false,
    cargo: Number.isFinite(frame.cargo) ? Math.max(0, Math.min(3, Math.floor(frame.cargo!))) : 0,
  };
  ctx.save();
  try {
    ctx.translate(frame.x, frame.y); const scale = frame.width / TRADE_SHIP_ART.width; ctx.scale(scale, scale);
    const heading = Number.isFinite(frame.heading) ? Math.max(-.3, Math.min(.3, frame.heading!)) : 0;
    ctx.translate(400, 350); ctx.rotate(heading); ctx.translate(-400, -350);
    const facing = frame.facing === "right" ? 1 : -1;
    if (facing < 0) { ctx.translate(TRADE_SHIP_ART.width, 0); ctx.scale(-1, 1); }
    ctx.lineJoin = "round"; ctx.lineCap = "round";
    if (frame.water) {
      const vx = Number.isFinite(frame.velocityX) ? frame.velocityX! : 0;
      const vy = Number.isFinite(frame.velocityY) ? frame.velocityY! : 0;
      drawTradeShipWater(ctx, { time: options.time, night: options.night,
        velocityX: (vx * Math.cos(heading) + vy * Math.sin(heading)) * facing,
        velocityY: -vx * Math.sin(heading) + vy * Math.cos(heading) });
    }
    if (!options.still) ctx.translate(0, Math.sin(options.time * 1.7) * 1.1);
    drawRamp(ctx, options.night, unit(frame.ramp));
    drawTradeShipHull(ctx, options);
    drawGate(ctx, options, unit(frame.gate));
    drawTradeShipCabin(ctx, options);
    drawTradeShipProps(ctx, options);
    drawTradeShipFrontRail(ctx, options);
    drawTradeShipFenders(ctx, options);
    drawSteam(ctx, options);
  } finally { ctx.restore(); }
}
