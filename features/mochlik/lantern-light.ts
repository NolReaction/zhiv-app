import { HOUSE_ANCHORS } from "./home-layout";

/** Keep the painted glass and metal frame; only light is composited on top. */
export function drawLanternLight(ctx: CanvasRenderingContext2D, intensity: number, dusk: number) {
  if (intensity <= .01) return;
  const lamp = HOUSE_ANCHORS.lamp;
  const x = lamp.x + lamp.width / 2, y = lamp.y + lamp.height / 2;
  const radius = lamp.height * 1.8;
  ctx.save();
  ctx.globalCompositeOperation = "screen";
  ctx.globalAlpha = intensity;
  const glow = ctx.createRadialGradient(x, y, 0, x, y, radius);
  glow.addColorStop(0, `rgba(255,214,135,${.16 + dusk * .25})`);
  glow.addColorStop(.25, `rgba(255,191,85,${.07 + dusk * .1})`);
  glow.addColorStop(1, "rgba(255,181,65,0)");
  ctx.fillStyle = glow;
  ctx.fillRect(x - radius, y - radius, radius * 2, radius * 2);
  ctx.restore();
}
