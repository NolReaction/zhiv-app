import { shipPoint } from "./trade-ship-art";

/** Water belongs to the scene, never the transparent ship asset. Velocities use the art camera's axes. */
export function drawTradeShipWater(ctx: CanvasRenderingContext2D, frame: {
  time: number; night: number; velocityX: number; velocityY: number;
}) {
  const centre = shipPoint(0, 20, -61);
  ctx.save();
  ctx.translate(centre.x, centre.y); ctx.rotate(-.2);
  const shadow = ctx.createRadialGradient(0, 0, 8, 0, 0, 325);
  shadow.addColorStop(0, "rgba(9, 34, 33, .35)");
  shadow.addColorStop(.8, "rgba(9, 34, 33, .22)");
  shadow.addColorStop(1, "rgba(9, 34, 33, 0)");
  ctx.scale(1, .16); ctx.fillStyle = shadow;
  ctx.beginPath(); ctx.arc(0, 0, 325, 0, Math.PI * 2); ctx.fill(); ctx.restore();

  const speed = Math.hypot(frame.velocityX, frame.velocityY);
  if (speed < .05) return;
  const strength = Math.min(1, speed / 40);
  const dx = frame.velocityX / speed, dy = frame.velocityY / speed;
  const tail = { x: centre.x - dx * 260, y: centre.y - dy * 260 };
  ctx.save();
  ctx.strokeStyle = frame.night > .5 ? "#6aaba8" : "#d0e6ce";
  // Separate expanding ribbons: their wake direction reverses with the propeller's travel.
  for (let i = 0; i < 8; i++) {
    const phase = ((frame.time * .43 + i / 8) % 1 + 1) % 1;
    const distance = phase * (70 + 135 * strength);
    const spread = 5 + phase * 37;
    const x = tail.x - dx * distance, y = tail.y - dy * distance;
    ctx.globalAlpha = strength * (1 - phase) * .32;
    ctx.lineWidth = 1.1 + (1 - phase) * 1.4;
    ctx.beginPath();
    ctx.moveTo(x - dy * spread, y + dx * spread);
    ctx.quadraticCurveTo(x - dx * 9, y - dy * 9, x + dy * spread, y - dx * spread);
    ctx.stroke();
  }
  ctx.globalAlpha = strength * .27; ctx.lineWidth = 1.5;
  for (const side of [-1, 1]) {
    const start = shipPoint(260, side * 31, -22);
    const middle = shipPoint(30, side * 94, -63);
    const end = shipPoint(-270, side * 53, -49);
    ctx.beginPath(); ctx.moveTo(start.x, start.y);
    ctx.quadraticCurveTo(middle.x, middle.y, end.x, end.y); ctx.stroke();
  }
  ctx.restore();
}
