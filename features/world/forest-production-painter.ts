import type { ForestProductionFrame } from "./economy-production-state";

/** Two local work flecks and grounded shavings/stone chips; never a particle queue. */
export function drawForestProductionStation(ctx: CanvasRenderingContext2D, frame: ForestProductionFrame, still: boolean) {
  if (frame.stationId === "dryer" || ![frame.x, frame.y, frame.size, frame.elapsed].every(Number.isFinite) || frame.size <= 0) return;
  const stone = frame.stationId === "quarry", { x, y, size } = frame;
  const alpha = ctx.globalAlpha;
  ctx.save(); ctx.lineCap = "round";
  ctx.fillStyle = "rgba(35,32,22,.12)"; ctx.beginPath(); ctx.ellipse(x, y + size * .035, size * .23, size * .065, 0, 0, Math.PI * 2); ctx.fill();
  for (let index = 0; index < 3; index++) {
    ctx.fillStyle = stone ? ["#878c80", "#abb0a0", "#656c62"][index] : ["#a38355", "#c7a777", "#8f6f46"][index];
    ctx.beginPath();
    const dx = (index - 1) * size * .12, dy = index % 2 * size * .02;
    ctx.ellipse(x + dx, y + dy, size * .055, size * (stone ? .035 : .018), stone ? -.4 : -.17 + index * .2, 0, Math.PI * 2); ctx.fill();
  }
  if (frame.phase === "working" && !still) for (let index = 0; index < 2; index++) {
    const phase = ((frame.elapsed * .55 + index * .47) % 1 + 1) % 1;
    ctx.globalAlpha = alpha * .6 * Math.sin(phase * Math.PI);
    ctx.strokeStyle = stone ? "#c2c7b7" : "#d5bc87"; ctx.lineWidth = size * .022;
    const px = x + (index ? 1 : -1) * size * (.06 + phase * .16), py = y - size * (.08 + Math.sin(phase * Math.PI) * .18);
    ctx.beginPath(); ctx.moveTo(px, py); ctx.lineTo(px + size * .025, py - size * .02); ctx.stroke();
    ctx.globalAlpha = alpha;
  }
  ctx.restore();
}
