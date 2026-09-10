import { HOUSE_ANCHORS } from "./home-layout";
import type { MapPoint } from "@/features/world/map-manifest";

export const NIGHT_SHADE = .56;
const bounded = (value: number) => Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
const moonPools = [
  { x: 340, y: 280, radius: 290, light: .17 },
  { x: 623, y: 655, radius: 220, light: .025 },
  { x: 960, y: 670, radius: 270, light: .15 },
  { x: 1060, y: 1080, radius: 360, light: .23 },
];

/** Moonlight belongs to the map, so a home crop samples exactly the same light.
 * Canopies remain dark while open paths, the clearing and water catch cool light. */
export function drawSceneShade(ctx: CanvasRenderingContext2D, night: number, rain: number, width: number, height = width, origin: MapPoint = { x: 0, y: 0 }) {
  const dusk = bounded(night), cloud = bounded(rain);
  ctx.save();
  ctx.fillStyle = `rgba(8,17,37,${dusk * NIGHT_SHADE})`; ctx.fillRect(0, 0, width, height);
  if (dusk > .01) {
    ctx.beginPath(); ctx.rect(0, 0, width, height); ctx.clip();
    ctx.globalCompositeOperation = "screen";
    ctx.globalAlpha = dusk * (1 - cloud * .35);
    for (const pool of moonPools) {
      const x = pool.x - origin.x, y = pool.y - origin.y, radius = pool.radius;
      const glow = ctx.createRadialGradient(x, y, 0, x, y, radius);
      glow.addColorStop(0, `rgba(137,176,216,${pool.light})`);
      glow.addColorStop(.42, `rgba(112,154,203,${pool.light * .68})`);
      glow.addColorStop(1, "rgba(94,137,195,0)");
      ctx.fillStyle = glow; ctx.fillRect(x - radius, y - radius, radius * 2, radius * 2);
    }
  }
  ctx.globalCompositeOperation = "source-over"; ctx.globalAlpha = 1;
  ctx.fillStyle = `rgba(69,105,125,${cloud * .07})`; ctx.fillRect(0, 0, width, height);
  ctx.restore();
}

/** Warm, low-contrast falloff starts at the actual lantern. The broad pool reaches
 * the clearing and is also painted outside the home crop on the region canvas. */
export function drawLanternLight(ctx: CanvasRenderingContext2D, intensity: number, dusk: number) {
  const strength = bounded(intensity) * bounded(dusk);
  if (strength <= .01) return;
  const lamp = HOUSE_ANCHORS.lamp;
  const x = lamp.x + lamp.width / 2, y = lamp.y + lamp.height / 2;
  ctx.save(); ctx.globalCompositeOperation = "screen"; ctx.globalAlpha = strength;
  const radius = 145;
  const pool = ctx.createRadialGradient(x, y, 0, x, y, radius);
  pool.addColorStop(0, "rgba(246,174,78,.38)");
  pool.addColorStop(.25, "rgba(235,164,72,.25)");
  pool.addColorStop(.62, "rgba(218,151,66,.095)");
  pool.addColorStop(1, "rgba(206,155,83,0)");
  ctx.fillStyle = pool; ctx.fillRect(x - radius, y - radius, radius * 2, radius * 2);
  const glow = ctx.createRadialGradient(x, y, 0, x, y, 13);
  glow.addColorStop(0, "rgba(255,211,121,.40)");
  glow.addColorStop(.25, "rgba(248,183,85,.17)");
  glow.addColorStop(1, "rgba(255,181,65,0)");
  ctx.fillStyle = glow; ctx.fillRect(x - 13, y - 13, 26, 26); ctx.restore();
}
