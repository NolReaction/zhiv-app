import type { WorldPoint } from "@/features/world/tiled/types";

export type LopukhWoodpileFrame = { position: WorldPoint; deliveries: number; size?: number };

/** Last confirmed visual unload, capped at three logs. The work controller owns
 * this frame; painting cannot finish jobs or award wood to the player's stock. */
export function drawLopukhWoodpile(ctx: CanvasRenderingContext2D, frame: LopukhWoodpileFrame) {
  const size = frame.size ?? 44, { position, deliveries } = frame;
  if (![position.x, position.y, size, deliveries].every(Number.isFinite) || size <= 0 || deliveries < 1) return;
  const unit = size / 48, count = Math.min(3, Math.floor(deliveries));
  const logs = [{ x: -8, y: 0 }, { x: 1, y: 0 }, { x: -3.5, y: -4 }];
  ctx.save(); ctx.fillStyle = "rgba(30,39,24,.13)"; ctx.beginPath();
  ctx.ellipse(position.x, position.y + unit, unit * 12, unit * 3, 0, 0, Math.PI * 2); ctx.fill();
  for (let index = 0; index < count; index++) {
    const x = position.x + logs[index].x * unit, y = position.y + logs[index].y * unit;
    ctx.fillStyle = "#76503a"; ctx.fillRect(x, y - unit * 4, unit * 10, unit * 5);
    ctx.fillStyle = "#a8794c"; ctx.fillRect(x + unit, y - unit * 4, unit * 8, unit * 2);
    ctx.fillStyle = "#5f4634"; ctx.fillRect(x + unit, y, unit * 8, unit);
    ctx.fillStyle = "#d7b57c"; ctx.fillRect(x + unit * 7, y - unit * 3, unit * 3, unit * 3);
    ctx.fillStyle = "#b38957"; ctx.fillRect(x + unit * 8, y - unit * 2, unit, unit);
  }
  ctx.restore();
}
