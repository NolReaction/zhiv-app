import { FOREST_MAP, type MapPoint } from "./map-manifest";
import { pointInPolygon } from "./map-layout";

const TAU = Math.PI * 2;
const shoreline = FOREST_MAP.water.hitArea;
const SURFACE_CYCLE = 104;
const SURFACE_DURATION = 3.2;
const AIR_TIME = 1.05;

// Patrols and surface events stay in open water, away from the wooded peninsulas.
// Coordinates are source-map pixels, so camera movement cannot detach them.
export const FISH_PATROLS = [
  { x: 1198, y: 806, radiusX: 22, radiusY: 27, period: 24, phase: .4, scale: .85, surfaceAt: 9 },
  { x: 1130, y: 914, radiusX: 28, radiusY: 20, period: 29, phase: 2.2, scale: 1, surfaceAt: 45 },
  { x: 1016, y: 1015, radiusX: 40, radiusY: 15, period: 34, phase: 3.4, scale: 1.05, surfaceAt: 26 },
  { x: 1050, y: 1095, radiusX: 27, radiusY: 25, period: 27, phase: 1.6, scale: .9, surfaceAt: 77 },
  { x: 1174, y: 1205, radiusX: 30, radiusY: 19, period: 31, phase: 4.8, scale: 1.1, surfaceAt: 94 },
  { x: 818, y: 1218, radiusX: 43, radiusY: 15, period: 36, phase: 2.8, scale: .9, surfaceAt: 60 },
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

/** One brief jump per fish, staggered across a long cycle with quiet gaps. */
export function fishSurfaceEvent(patrol: FishPatrol, seconds: number) {
  if (seconds < patrol.surfaceAt) return null;
  const elapsed = (seconds - patrol.surfaceAt) % SURFACE_CYCLE;
  if (elapsed >= SURFACE_DURATION) return null;
  const start = seconds - elapsed;
  return {
    elapsed,
    lift: elapsed < AIR_TIME ? Math.sin(elapsed / AIR_TIME * Math.PI) * 9 : 0,
    takeoff: fishPose(patrol, start),
    landing: fishPose(patrol, start + AIR_TIME),
  };
}

function openWater(point: MapPoint, margin: number) {
  return pointInPolygon(point, shoreline) && Array.from({ length: 16 }, (_, i) => {
    const angle = i * TAU / 16;
    return pointInPolygon({ x: point.x + Math.cos(angle) * margin, y: point.y + Math.sin(angle) * margin }, shoreline);
  }).every(Boolean);
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

const WIND_PERIOD = 16;
// Each footprint includes the full drift and the wavelet width, keeping it off land.
export const WIND_RIPPLES = Array.from({ length: 120 }, (_, i) => ({
  x: 708 + (i * 137 % 528), y: 746 + (i * 211 % 486),
  delay: (i % 7) * .46, width: 18 + i % 9,
})).filter(point => openWater(point, 39));
type WindRipple = typeof WIND_RIPPLES[number];

export function windRipplePose(ripple: WindRipple, seconds: number) {
  const phase = seconds % WIND_PERIOD;
  const age = phase - 3 - ripple.delay;
  if (age <= 0 || age >= 7.5) return null;
  const life = age / 7.5;
  return {
    x: ripple.x - 18 + life * 36,
    y: ripple.y - 4 + life * 8,
    opacity: Math.sin(life * Math.PI) ** 2,
  };
}

export const RAIN_IMPACTS = Array.from({ length: 256 }, (_, i) => ({
  x: 699 + (i * 97 % 548), y: 733 + (i * 173 % 512),
  delay: (i * .618034) % 2, period: 1.2 + (i % 9) * .18,
})).filter(point => openWater(point, 12));

function drawRing(ctx: CanvasRenderingContext2D, point: MapPoint, life: number, radius: number, opacity: number) {
  if (life <= 0 || life >= 1) return;
  ctx.globalAlpha = Math.sin(life * Math.PI) * opacity;
  const rx = 1 + life * radius, ry = .6 + life * radius * .32;
  ctx.beginPath(); ctx.ellipse(point.x, point.y, rx, ry, 0, .12, Math.PI - .2); ctx.stroke();
  ctx.beginPath(); ctx.ellipse(point.x, point.y, rx, ry, 0, Math.PI + .3, TAU - .3); ctx.stroke();
}

function drawFish(ctx: CanvasRenderingContext2D, patrol: FishPatrol, seconds: number, reducedMotion: boolean) {
  const pose = fishPose(patrol, seconds);
  const event = reducedMotion ? null : fishSurfaceEvent(patrol, seconds);
  const lift = event?.lift ?? 0;
  const surfaced = lift / 9;
  ctx.save();
  if (lift > 0) {
    ctx.globalAlpha = .16; ctx.fillStyle = "#194d53";
    ctx.beginPath(); ctx.ellipse(pose.x, pose.y + 1, 7 * patrol.scale, 2, pose.angle, 0, TAU); ctx.fill();
  }
  ctx.translate(pose.x, pose.y - lift); ctx.rotate(pose.angle); ctx.scale(patrol.scale, patrol.scale);
  // A small silver back breaks the surface; no separate sprite jumps into view.
  ctx.globalAlpha = .48 + surfaced * .33;
  ctx.fillStyle = `rgb(${Math.round(25 + surfaced * 67)}, ${Math.round(77 + surfaced * 54)}, ${Math.round(83 + surfaced * 34)})`;
  ctx.fillRect(-5, -2, 9, 4); ctx.fillRect(-3, -3, 5, 6); ctx.fillRect(4, -1, 2, 2);
  const tail = Math.round(Math.sin(seconds * 8 + patrol.phase + surfaced * 2.4) * (1.5 + surfaced * .5));
  ctx.fillRect(-7, -1 + tail, 2, 2); ctx.fillRect(-9, -3 + tail, 2, 6);
  ctx.globalAlpha = .24 + surfaced * .5; ctx.fillStyle = "#d5dcb7";
  ctx.fillRect(-3, -1, 6, 1);
  ctx.globalAlpha = .32; ctx.fillStyle = "#538f87";
  ctx.fillRect(-2, 3, 3, 1); ctx.fillRect(-2, -4, 3, 1);
  ctx.restore();
  if (!event) return;
  ctx.save(); ctx.strokeStyle = "#c1ddc9"; ctx.lineWidth = .85;
  drawRing(ctx, event.takeoff, event.elapsed / .95, 9, .36);
  const afterLanding = event.elapsed - AIR_TIME;
  drawRing(ctx, event.landing, afterLanding / 2.15, 16, .44);
  drawRing(ctx, event.landing, (afterLanding - .23) / 1.8, 11, .26);
  if (afterLanding > 0 && afterLanding < .62) {
    const life = afterLanding / .62;
    ctx.globalAlpha = Math.sin(life * Math.PI) * .7; ctx.fillStyle = "#d2e5cd";
    for (let i = 0; i < 5; i++) {
      const spread = (i - 2) * 4.2;
      const x = event.landing.x + spread * life;
      const y = event.landing.y - Math.sin(life * Math.PI) * (5 + i % 2 * 3) + Math.abs(spread) * .12;
      ctx.fillRect(Math.round(x), Math.round(y), 1.3, 1.8);
    }
  }
  ctx.restore();
}

/** Paint over the unchanged map, before its existing night/rain lighting. */
export function drawWaterAmbience(ctx: CanvasRenderingContext2D, seconds: number, reducedMotion: boolean, rain = 0) {
  const time = reducedMotion ? 0 : seconds;
  const rainfall = Math.max(0, Math.min(1, rain));
  ctx.save(); ctx.beginPath();
  shoreline.forEach((point, i) => i ? ctx.lineTo(point.x, point.y) : ctx.moveTo(point.x, point.y));
  ctx.closePath(); ctx.clip();
  for (const patrol of FISH_PATROLS) drawFish(ctx, patrol, time, reducedMotion);
  if (!reducedMotion) {
    ctx.lineWidth = 1.35;
    for (const ripple of WIND_RIPPLES) {
      const pose = windRipplePose(ripple, time);
      if (!pose) continue;
      // A dark trough followed by a pale crest reads as moving water even when
      // the full map is zoomed out. Both follow the same small, fading packet.
      ctx.strokeStyle = "#235d65";
      ctx.globalAlpha = pose.opacity * .24 * (1 - rainfall * .4);
      ctx.beginPath(); ctx.moveTo(pose.x - ripple.width / 2, pose.y + 1.5);
      ctx.quadraticCurveTo(pose.x, pose.y + 4, pose.x + ripple.width / 2, pose.y + .5); ctx.stroke();
      ctx.strokeStyle = "#d0e6d0";
      ctx.globalAlpha = pose.opacity * .40 * (1 - rainfall * .4);
      ctx.beginPath(); ctx.moveTo(pose.x - ripple.width / 2, pose.y);
      ctx.quadraticCurveTo(pose.x, pose.y + 2.5, pose.x + ripple.width / 2, pose.y - 1); ctx.stroke();
      ctx.globalAlpha *= .55;
      ctx.beginPath(); ctx.moveTo(pose.x - ripple.width / 2 - 3, pose.y + 4);
      ctx.quadraticCurveTo(pose.x - 3, pose.y + 6, pose.x + ripple.width / 2 - 5, pose.y + 3); ctx.stroke();
    }
    ctx.fillStyle = "#b5d2b8";
    for (const glint of glints) {
      const phase = time * TAU / glint.period + glint.phase;
      ctx.globalAlpha = (.035 + Math.pow((Math.sin(phase) + 1) / 2, 3) * .13) * (1 - rainfall * .6);
      const x = Math.round(glint.x + Math.sin(phase * .45) * 2);
      const y = Math.round(glint.y + Math.cos(phase * .35));
      ctx.fillRect(x, y, glint.width, 1);
      ctx.fillRect(x + 3, y + 2, Math.max(2, glint.width - 5), 1);
    }
    ctx.strokeStyle = "#b5d2b8"; ctx.lineWidth = .8;
    for (const ripple of WATER_RIPPLES) {
      const progress = ((time + ripple.phase) % ripple.period) / ripple.period;
      // Quiet gaps between rings keep the river from looking like boiling water.
      drawRing(ctx, ripple, progress / .62, 12, .2);
    }
    if (rainfall > .01) {
      ctx.strokeStyle = "#c6ddcb"; ctx.lineWidth = .75;
      for (const drop of RAIN_IMPACTS) {
        const age = (time + drop.delay) % drop.period;
        // More impacts, with shorter, slightly smaller rings so the rain stays soft.
        drawRing(ctx, drop, age / .68, 6.3, rainfall * .32);
        if (age < .13) {
          ctx.globalAlpha = (1 - age / .13) * rainfall * .55;
          ctx.fillStyle = "#cee0ce";
          ctx.fillRect(drop.x, drop.y - (1 - age / .13) * 2, 1, 2);
        }
      }
    }
  }
  ctx.restore();
}
