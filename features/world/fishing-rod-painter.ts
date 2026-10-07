import { fishingRodAppearance, fishingRodShapes } from "./fishing-rod-art";
import type { WorldPoint } from "./tiled/types";

export type FishingRodFrame = {
  grip: WorldPoint; tip: WorldPoint; reel: WorldPoint; size: number;
  side: number; tension: number; crank: number; rodId?: string; detailScale?: number;
};

/** Render only the rod; the caller still owns hand anchors, line and float. */
export function drawFishingRod(ctx: CanvasRenderingContext2D, frame: FishingRodFrame) {
  const { grip, tip, reel, size } = frame;
  if (![grip.x, grip.y, tip.x, tip.y, reel.x, reel.y, size].every(Number.isFinite) || size <= 0) return;
  const dx = tip.x - grip.x, dy = tip.y - grip.y, length = Math.hypot(dx, dy);
  if (length < .001) return;
  const axisX = dx / length, axisY = dy / length;
  const localReel = { x: ((reel.x - grip.x) * axisX + (reel.y - grip.y) * axisY) / size,
    y: (-(reel.x - grip.x) * axisY + (reel.y - grip.y) * axisX) / size };
  const colors = fishingRodAppearance(frame.rodId);
  ctx.save(); ctx.translate(grip.x, grip.y); ctx.rotate(Math.atan2(dy, dx)); ctx.scale(size, size);
  ctx.lineCap = "round"; ctx.lineJoin = "round";
  for (const shape of fishingRodShapes(frame.rodId, { length: length / size, reel: localReel,
    tension: frame.tension, crank: frame.crank, side: frame.side, detailScale: frame.detailScale })) {
    ctx.beginPath();
    if (shape.kind === "ellipse") ctx.ellipse(shape.x, shape.y, shape.rx, shape.ry, 0, 0, Math.PI * 2);
    else for (const command of shape.commands) {
      if (command[0] === "M") ctx.moveTo(command[1], command[2]);
      else if (command[0] === "L") ctx.lineTo(command[1], command[2]);
      else if (command[0] === "Q") ctx.quadraticCurveTo(command[1], command[2], command[3], command[4]);
      else ctx.closePath();
    }
    if (shape.fill) { ctx.fillStyle = colors[shape.fill] ?? colors.handle; ctx.fill(); }
    if (shape.stroke) { ctx.strokeStyle = colors[shape.stroke] ?? colors.handle; ctx.lineWidth = shape.width ?? .012; ctx.stroke(); }
  }
  ctx.restore();
}
