import { HOUSE_ANCHORS } from "./home-layout";

export const NIGHT_SHADE = .30;
const bounded = (value: number) => Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;

/** The same readable moonlit exposure is used for both the home and the region. */
export function drawSceneShade(ctx: CanvasRenderingContext2D, night: number, rain: number, width: number, height = width) {
  ctx.save();
  ctx.fillStyle = `rgba(15,27,48,${bounded(night) * NIGHT_SHADE})`; ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = `rgba(69,105,125,${bounded(rain) * .07})`; ctx.fillRect(0, 0, width, height);
  ctx.restore();
}

/** Dim only the painted glass with a feathered multiply mask. Metal, reflections
 * and texture remain visible; there is no opaque replacement rectangle. */
export function drawLanternGlass(ctx: CanvasRenderingContext2D, intensity: number) {
  const off = 1 - bounded(intensity);
  if (off <= .01) return;
  const lamp = HOUSE_ANCHORS.lamp;
  ctx.save(); ctx.globalCompositeOperation = "multiply";
  ctx.translate(lamp.x + lamp.width * .38, lamp.y + lamp.height * .53);
  ctx.scale(lamp.width * .68, lamp.height * .48);
  const shade = ctx.createRadialGradient(0, 0, 0, 0, 0, 1);
  shade.addColorStop(0, `rgba(85,83,66,${off * .92})`);
  shade.addColorStop(.62, `rgba(104,98,73,${off * .78})`);
  shade.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = shade; ctx.fillRect(-1, -1, 2, 2); ctx.restore();
}

/** Warm, low-contrast falloff starts at the actual lantern. The broad pool reaches
 * the clearing and is also painted outside the home crop on the region canvas. */
export function drawLanternLight(ctx: CanvasRenderingContext2D, intensity: number, dusk: number) {
  const strength = bounded(intensity) * bounded(dusk);
  if (strength <= .01) return;
  const lamp = HOUSE_ANCHORS.lamp;
  const x = lamp.x + lamp.width / 2, y = lamp.y + lamp.height / 2;
  ctx.save(); ctx.globalCompositeOperation = "screen"; ctx.globalAlpha = strength;
  const pool = ctx.createRadialGradient(x, y, 0, x, y, 100);
  pool.addColorStop(0, "rgba(229,169,86,.16)");
  pool.addColorStop(.25, "rgba(219,162,81,.105)");
  pool.addColorStop(.62, "rgba(206,155,83,.045)");
  pool.addColorStop(1, "rgba(206,155,83,0)");
  ctx.fillStyle = pool; ctx.fillRect(x - 100, y - 100, 200, 200);
  const glow = ctx.createRadialGradient(x, y, 0, x, y, 13);
  glow.addColorStop(0, "rgba(255,211,121,.23)");
  glow.addColorStop(.25, "rgba(248,183,85,.10)");
  glow.addColorStop(1, "rgba(255,181,65,0)");
  ctx.fillStyle = glow; ctx.fillRect(x - 13, y - 13, 26, 26); ctx.restore();
}
