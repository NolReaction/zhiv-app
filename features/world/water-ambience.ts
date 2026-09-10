import { FOREST_MAP, type MapPoint } from "./map-manifest";
import { pointInPolygon } from "./map-layout";

const TAU = Math.PI * 2;
const shoreline = FOREST_MAP.water.hitArea;

// Small patrols stay in open water, away from reeds and the wooded peninsulas.
// All coordinates are source-map pixels, so camera movement cannot detach them.
export const FISH_PATROLS = [
  { x: 1198, y: 806, radiusX: 22, radiusY: 27, period: 24, phase: .4, scale: .85 },
  { x: 1130, y: 914, radiusX: 28, radiusY: 20, period: 29, phase: 2.2, scale: 1 },
  { x: 1016, y: 1015, radiusX: 40, radiusY: 15, period: 34, phase: 3.4, scale: 1.05 },
  { x: 1050, y: 1095, radiusX: 27, radiusY: 25, period: 27, phase: 1.6, scale: .9 },
  { x: 1174, y: 1205, radiusX: 30, radiusY: 19, period: 31, phase: 4.8, scale: 1.1 },
  { x: 818, y: 1218, radiusX: 43, radiusY: 15, period: 36, phase: 2.8, scale: .9 },
] as const;
type FishPatrol = typeof FISH_PATROLS[number];

export function fishPose(patrol: FishPatrol, seconds: number) {
  const phase = seconds * TAU / patrol.period + patrol.phase;
  return {
    x: patrol.x + Math.cos(phase) * patrol.radiusX,
    y: patrol.y + Math.sin(phase) * patrol.radiusY,
    angle: Math.atan2(Math.cos(phase) * patrol.radiusY, -Math.sin(phase) * patrol.radiusX),
    tail: Math.sin(seconds * 8 + patrol.phase),
  };
}

function openWater(point: MapPoint, margin: number) {
  return [{ x: 0, y: 0 }, { x: margin, y: 0 }, { x: -margin, y: 0 }, { x: 0, y: margin }, { x: 0, y: -margin }]
    .every(offset => pointInPolygon({ x: point.x + offset.x, y: point.y + offset.y }, shoreline));
}

// Deterministic positions avoid flickering or reshuffling when the scene redraws.
const glints = Array.from({ length: 80 }, (_, i) => ({
  x: 710 + (i * 137 % 530), y: 748 + (i * 89 % 490),
  phase: i * 2.39996, period: 5 + i % 5, width: 5 + i % 9,
})).filter(point => openWater(point, 15));
export const WATER_RIPPLES = [
  { x: 1204, y: 851, phase: .2, period: 8 },
  { x: 1103, y: 966, phase: 2.9, period: 11 },
  { x: 1001, y: 1054, phase: 5.1, period: 10 },
  { x: 1090, y: 1140, phase: 1.8, period: 9 },
  { x: 903, y: 1202, phase: 6.2, period: 12 },
] as const;

function drawFish(ctx: CanvasRenderingContext2D, patrol: FishPatrol, seconds: number) {
  const pose = fishPose(patrol, seconds);
  ctx.save();
  ctx.translate(pose.x, pose.y); ctx.rotate(pose.angle); ctx.scale(patrol.scale, patrol.scale);
  // Submerged silhouettes, with restrained fins and a brighter dorsal glimmer.
  ctx.globalAlpha = .48;
  ctx.fillStyle = "#194d53";
  ctx.fillRect(-5, -2, 9, 4); ctx.fillRect(-3, -3, 5, 6); ctx.fillRect(4, -1, 2, 2);
  const tail = Math.round(pose.tail * 1.5);
  ctx.fillRect(-7, -1 + tail, 2, 2); ctx.fillRect(-9, -3 + tail, 2, 6);
  ctx.globalAlpha = .24; ctx.fillStyle = "#c4d2a1";
  ctx.fillRect(-3, -1, 6, 1);
  ctx.globalAlpha = .32; ctx.fillStyle = "#538f87";
  ctx.fillRect(-2, 3, 3, 1); ctx.fillRect(-2, -4, 3, 1);
  ctx.restore();
}

/** Paint over the unchanged map, before its existing night/rain lighting. */
export function drawWaterAmbience(ctx: CanvasRenderingContext2D, seconds: number, reducedMotion: boolean) {
  ctx.save(); ctx.beginPath();
  shoreline.forEach((point, i) => i ? ctx.lineTo(point.x, point.y) : ctx.moveTo(point.x, point.y));
  ctx.closePath(); ctx.clip();
  for (const patrol of FISH_PATROLS) drawFish(ctx, patrol, seconds);
  if (!reducedMotion) {
    ctx.fillStyle = "#b5d2b8";
    for (const glint of glints) {
      const phase = seconds * TAU / glint.period + glint.phase;
      ctx.globalAlpha = .035 + Math.pow((Math.sin(phase) + 1) / 2, 3) * .13;
      const x = Math.round(glint.x + Math.sin(phase * .45) * 2);
      const y = Math.round(glint.y + Math.cos(phase * .35));
      ctx.fillRect(x, y, glint.width, 1);
      ctx.fillRect(x + 3, y + 2, Math.max(2, glint.width - 5), 1);
    }
    ctx.strokeStyle = "#b5d2b8"; ctx.lineWidth = .8;
    for (const ripple of WATER_RIPPLES) {
      const progress = ((seconds + ripple.phase) % ripple.period) / ripple.period;
      // Quiet gaps between rings keep the river from looking like boiling water.
      if (progress > .62) continue;
      const life = progress / .62;
      ctx.globalAlpha = Math.sin(life * Math.PI) * .2;
      ctx.beginPath(); ctx.ellipse(ripple.x, ripple.y, 2 + life * 12, 1 + life * 4, 0, .12, Math.PI - .2); ctx.stroke();
      ctx.beginPath(); ctx.ellipse(ripple.x, ripple.y, 2 + life * 12, 1 + life * 4, 0, Math.PI + .3, TAU - .3); ctx.stroke();
    }
  }
  ctx.restore();
}
