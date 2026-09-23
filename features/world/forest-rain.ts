import type { FixedWorldScene, WorldPoint } from "./tiled/types";

const TAU = Math.PI * 2;
const clamp = (value: number, min = 0, max = 1) => Math.max(min, Math.min(max, value));
const finite = (value: number) => Number.isFinite(value) ? value : 0;
const modulo = (value: number, period: number) => ((value % period) + period) % period;
const smooth = (value: number) => { const t = clamp(value); return t * t * (3 - 2 * t); };

export const FOREST_RAIN_LIMIT = 180;
export type ForestRainOptions = {
  elapsed: number;
  rain: number;
  reducedMotion?: boolean;
  automatic?: boolean;
};
export type ForestRaindrop = WorldPoint & {
  size: number;
  phase: number;
  length: number;
  opacity: number;
  /** Horizontal displacement of the short falling trail in world units. */
  drift: number;
  depth: number;
};

function sceneSeed(id: string) {
  let seed = 2166136261;
  for (let i = 0; i < id.length; i++) seed = Math.imul(seed ^ id.charCodeAt(i), 16777619);
  return seed >>> 0;
}

function noise(seed: number, index: number) {
  let value = (seed + Math.imul(index + 1, 0x9e3779b9)) | 0;
  value = Math.imul(value ^ value >>> 16, 0x21f0aaad);
  value = Math.imul(value ^ value >>> 15, 0x735a2d97);
  return ((value ^ value >>> 15) >>> 0) / 4294967296;
}

/** Three quiet depth layers, sampled in world coordinates from the shared active clock. */
export function sampleForestRain(scene: FixedWorldScene, options: ForestRainOptions): ForestRaindrop[] {
  const rain = clamp(finite(options.rain));
  if (options.reducedMotion || rain <= .001) return [];
  const width = Math.max(1, finite(scene.width)), height = Math.max(1, finite(scene.height));
  const x = clamp(finite(scene.focus.x), 0, width - 1), y = clamp(finite(scene.focus.y), 0, height - 1);
  const focus = { x, y, width: clamp(finite(scene.focus.width), 1, width - x),
    height: clamp(finite(scene.focus.height), 1, height - y) };
  const scale = clamp(Math.min(focus.width, focus.height) / 256, .35, 2);
  const visibility = options.automatic ? clamp(rain / .42) : 1;
  const count = options.automatic ? Math.ceil(54 * visibility) : Math.ceil(FOREST_RAIN_LIMIT * rain);
  const elapsed = Math.max(0, finite(options.elapsed)), seed = sceneSeed(scene.id);
  // One slow gust bends all layers together. Individual speed/depth keeps the field irregular.
  const wind = -.13 + Math.sin(elapsed * .31 + noise(seed, 141) * TAU) * .095
    + Math.sin(elapsed * .12) * .055;
  const drops: ForestRaindrop[] = [];
  for (let i = 0; i < count; i++) {
    // Interleaving leaves a reliable local sample without making rain follow the camera.
    const field = i % 5 < 2 ? focus : { x: 0, y: 0, width, height };
    const layer = noise(seed, i * 9 + 501);
    const depth = layer < .52 ? .24 : layer < .88 ? .58 : .94;
    const speed = scale * (58 + depth * 100 + noise(seed, i * 9 + 502) * 32) * (.83 + rain * .28);
    const cycle = noise(seed, i * 9 + 503) + elapsed * speed / field.height;
    const phase = modulo(cycle, 1);
    const length = Math.min(field.height * .09,
      scale * (.75 + depth * 3.9 + noise(seed, i * 9 + 504) * 1.35) * (.75 + rain * .4));
    const drift = length * (wind + (noise(seed, i * 9 + 505) - .5) * .14);
    const lane = noise(seed, i * 9 + 506) * field.width;
    const travel = elapsed * speed * -.1 + Math.sin(elapsed * .31 + i * .9) * scale * (2 + depth * 3);
    const fade = smooth(phase / .05) * smooth((1 - phase) / .055);
    drops.push({
      x: field.x + modulo(lane + travel, field.width), y: field.y + phase * field.height,
      size: scale * (.3 + depth * .4 + noise(seed, i * 9 + 507) * .1),
      phase, depth, drift, length,
      opacity: visibility * fade * (.19 + depth * .19 + rain * .1) * (.77 + noise(seed, i * 9 + 508) * .23),
    });
  }
  return drops;
}

/** Tapered translucent droplets avoid long, equally bright white rain bars. */
export function drawForestRain(ctx: CanvasRenderingContext2D, scene: FixedWorldScene, drops: readonly ForestRaindrop[]) {
  if (!drops.length) return;
  ctx.save();
  ctx.beginPath(); ctx.rect(0, 0, scene.width, scene.height); ctx.clip();
  for (const drop of drops) {
    if (drop.opacity < .008) continue;
    const tipX = drop.x + drop.drift, tipY = drop.y + drop.length;
    ctx.globalAlpha = drop.opacity;
    ctx.fillStyle = drop.depth > .8 ? "#d2e3e4" : "#b7cbd0";
    ctx.beginPath();
    ctx.moveTo(drop.x, drop.y);
    ctx.lineTo(tipX + drop.size * .5, tipY - drop.size);
    ctx.bezierCurveTo(tipX + drop.size * .65, tipY, tipX - drop.size * .65, tipY,
      tipX - drop.size * .5, tipY - drop.size);
    ctx.closePath(); ctx.fill();
  }
  ctx.restore();
}

export type ForestWaterImpact = WorldPoint & {
  radiusX: number;
  radiusY: number;
  phase: number;
  opacity: number;
  dusk?: number;
};

/** The footprint is bounded by radiusX/radiusY; the receiving surface supplies its clip. */
export function drawForestWaterImpact(ctx: CanvasRenderingContext2D, impact: ForestWaterImpact) {
  const phase = clamp(finite(impact.phase)), opacity = clamp(finite(impact.opacity));
  const rx = Math.max(0, finite(impact.radiusX)), ry = Math.max(0, finite(impact.radiusY));
  if (!rx || !ry || !opacity || phase >= 1) return;
  ctx.save();
  const dusk = clamp(finite(impact.dusk ?? 0));
  const light = dusk > .5 ? "#afcace" : "#d0e1d8";
  const radius = .12 + Math.pow(phase, .64) * .84;
  const fade = Math.pow(1 - phase, 1.65);
  ctx.lineWidth = clamp(rx * .065, .18, .55);
  // A dark outer edge gives displaced water depth without an opaque white target ring.
  ctx.strokeStyle = "#355e62"; ctx.globalAlpha = opacity * fade * .3;
  ctx.beginPath(); ctx.ellipse(impact.x, impact.y + ry * .04, rx * radius, ry * radius, 0, 0, TAU); ctx.stroke();
  ctx.strokeStyle = light; ctx.globalAlpha = opacity * fade * .8;
  ctx.beginPath(); ctx.ellipse(impact.x, impact.y, rx * radius, ry * radius, 0, .12, Math.PI * 1.12); ctx.stroke();
  ctx.globalAlpha *= .6;
  ctx.beginPath(); ctx.ellipse(impact.x, impact.y, rx * radius, ry * radius, 0, Math.PI * 1.3, TAU - .2); ctx.stroke();
  if (phase > .18) {
    const inner = .08 + Math.pow((phase - .18) / .82, .72) * .58;
    ctx.globalAlpha = opacity * fade * .35;
    ctx.beginPath(); ctx.ellipse(impact.x, impact.y, rx * inner, ry * inner, 0, 0, TAU); ctx.stroke();
  }
  if (phase < .24) {
    const crown = Math.sin(phase / .24 * Math.PI);
    ctx.globalAlpha = opacity * crown * .72;
    ctx.beginPath();
    ctx.moveTo(impact.x - rx * .26, impact.y - ry * .24 * crown);
    ctx.bezierCurveTo(impact.x - rx * .16, impact.y + ry * .14, impact.x + rx * .16,
      impact.y + ry * .14, impact.x + rx * .26, impact.y - ry * .24 * crown);
    ctx.stroke();
    ctx.fillStyle = light;
    for (const side of [-1, 1]) {
      ctx.beginPath(); ctx.ellipse(impact.x + side * rx * (.14 + phase * .45),
        impact.y - ry * .4 * crown, rx * .025, ry * .045, 0, 0, TAU); ctx.fill();
    }
  }
  if (phase > .06 && phase < .39) {
    const rebound = Math.sin((phase - .06) / .33 * Math.PI);
    ctx.globalAlpha = opacity * rebound * .7; ctx.fillStyle = light;
    ctx.beginPath(); ctx.ellipse(impact.x, impact.y - ry * .69 * rebound,
      rx * .04, ry * .105, 0, 0, TAU); ctx.fill();
  }
  ctx.restore();
}
