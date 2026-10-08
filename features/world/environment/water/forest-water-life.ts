import type { WorldPoint } from "@/features/world/tiled/types";
import { drawFishSprite } from "@/features/world/activities/fishing/fish-sprite";
import type { FishSpeciesId } from "@/features/world/activities/fishing/fish-species";
import { forestWaterWind } from "./forest-water-surface";

type WaterLifeOptions = { elapsed: number; rain: number; dusk: number; reducedMotion: boolean;
  waterFish?: "auto" | "on" | "off"; waterBreeze?: boolean; wind?: number };
type SafeEllipse = (point: WorldPoint, radiusX: number, radiusY: number) => boolean;
type Habitat = WorldPoint & { key: number; scale: number; radiusX: number; radiusY: number; count: number };
type BreezeSeed = WorldPoint & { key: number; scale: number; width: number };
export type WaterLifeLayout = { habitats: Habitat[]; breeze: BreezeSeed[] };
export type WaterFishFrame = WorldPoint & { id: string; angle: number; tail: number; size: number;
  species: FishSpeciesId; opacity: number; jump: number };
export type WaterSplashFrame = WorldPoint & { id: string; phase: number; scale: number; opacity: number; variation: number };
export type WaterBreezeFrame = WorldPoint & { width: number; scale: number; phase: number; opacity: number;
  elapsed: number; key: number; wind: number; dusk: number };

const TAU = Math.PI * 2;
const WATER_SPECIES = ["fish_silverfin", "fish_reedperch", "fish_mooncarp"] as const;
const phase = (value: number) => value - Math.floor(value);
const noise = (index: number) => { const n = Math.sin(index * 127.1 + 311.7) * 43758.5453; return n - Math.floor(n); };
const smooth = (value: number) => { const t = Math.max(0, Math.min(1, value)); return t * t * (3 - 2 * t); };

/** Whole swimming loops and breeze strokes fit a prechecked ellipse. Even tiny
 * holes are rejected by the caller's exact edge test, not sparse path samples. */
export function createWaterLifeLayout(cells: Array<{ key: number; points: WorldPoint[] }>, scale: number,
  fits: SafeEllipse): WaterLifeLayout {
  const habitats: Habitat[] = [], breeze: BreezeSeed[] = [];
  for (const cell of cells) {
    if (breeze.length < 24) for (const point of cell.points.slice(0, 6)) {
      const width = (22 + noise(cell.key + 202) * 17) * scale;
      if (!fits(point, width * .77 + 6 * scale + 1, 12 * scale + 1)) continue;
      breeze.push({ ...point, key: cell.key, scale, width }); break;
    }
    if (habitats.length >= 12) continue;
    for (const point of cell.points.slice(0, 8)) {
      if (habitats.some(p => Math.hypot(p.x - point.x, p.y - point.y) < 62 * scale)) continue;
      const shape = [[42, 28], [29, 21], [20, 16]].find(([rx, ry]) => fits(point, rx * scale + 1, ry * scale + 1));
      if (!shape) continue;
      const [rx, ry] = shape;
      habitats.push({ ...point, key: cell.key, scale: scale * (ry < 20 ? .66 : 1),
        radiusX: rx * scale, radiusY: ry * scale, count: ry < 20 ? 1 : 2 }); break;
    }
  }
  return { habitats, breeze };
}

function fishPosition(habitat: Habitat, seconds: number, member: number) {
  const speed = .17 + noise(habitat.key + 720) * .065;
  const theta = seconds * speed + noise(habitat.key + 73) * TAU - member * 1.55;
  // A school follows a slow oval with gentle changes of pace; position and
  // heading stay continuous when an animation cycle or splash ends.
  const turn = theta + Math.sin(theta * 2) * .11;
  const rx = habitat.radiusX * .48, ry = habitat.radiusY * .43;
  return { x: habitat.x + Math.cos(turn) * rx, y: habitat.y + Math.sin(turn) * ry,
    angle: Math.atan2(Math.cos(turn) * ry, -Math.sin(turn) * rx), theta };
}

/** Analytic motion: both cameras, screenshots and hit tests share the same clock.
 * No account items, random draws, timers or persistent population are created. */
export function waterLifeFrame(layout: WaterLifeLayout, options: WaterLifeOptions) {
  const { elapsed, rain, dusk, reducedMotion } = options;
  const wind = forestWaterWind(options);
  const fish: WaterFishFrame[] = [], splashes: WaterSplashFrame[] = [];
  if (options.waterFish !== "off") for (const habitat of layout.habitats) {
    const period = (options.waterFish === "on" ? 13 : 34) + noise(habitat.key + 824) * 14;
    const clock = elapsed + noise(habitat.key + 826) * period, cycle = Math.floor(clock / period);
    const age = phase(clock / period) * period;
    const lifetime = 2.1 + noise(habitat.key + cycle * 19 + 843) * .7;
    const active = !reducedMotion && rain < .65 && dusk < .8 && age < .75 + lifetime;
    // Keep a splash anchored at the point of landing, while the same fish
    // continues its swim. Rain/night leave quieter submerged silhouettes.
    if (active && age >= .75) {
      const anchor = fishPosition(habitat, elapsed - age + .75, 0);
      splashes.push({ x: anchor.x, y: anchor.y, id: `${habitat.key}:${cycle}`,
        phase: (age - .75) / lifetime, scale: habitat.scale,
        variation: noise(habitat.key + cycle * 83 + 845),
        opacity: (1 - dusk * .5) * (1 - rain * .65) });
    }
    for (let member = 0; member < habitat.count; member++) {
      const point = fishPosition(habitat, elapsed, member);
      const jumping = active && member === 0 && age < .75;
      const jump = jumping ? Math.sin(age / .75 * Math.PI) : 0;
      fish.push({ x: point.x, y: point.y, angle: point.angle,
        id: `${habitat.key}:${member}`, species: WATER_SPECIES[Math.floor(noise(habitat.key + 10) * 3)],
        tail: reducedMotion ? 0 : Math.sin(elapsed * 7.2 + point.theta * 3 + member),
        size: habitat.scale * (member ? .8 : 1), jump,
        opacity: (.25 + .13 * Math.sin(point.theta * .7) ** 2 + jump * .38)
          * (1 - rain * .5) * (1 - dusk * .48) });
    }
  }
  const breeze: WaterBreezeFrame[] = options.waterBreeze === false ? [] : layout.breeze.map(seed => {
    const age = phase(elapsed / (7 + noise(seed.key + 937) * 5) + noise(seed.key + 973));
    const gust = .64 + .36 * Math.sin(elapsed * .19 + seed.key) ** 2;
    return { x: seed.x + (age - .5) * seed.scale * (2 + wind * 4),
      y: seed.y + (age - .5) * seed.scale * (1.2 + wind * 1.8),
      width: seed.width, scale: seed.scale, phase: age,
      elapsed, key: seed.key, wind, dusk,
      opacity: Math.sin(age * Math.PI) ** 2 * (.16 + wind * .17) * gust * (1 - dusk * .52) * (1 - rain * .15) };
  });
  return { fish, splashes, breeze };
}

/** The same species art appears below water, on the hook and at the fish stall.
 * Size 6.8 keeps its full rotating silhouette within the checked radius of 6. */
export function drawWaterFish(ctx: CanvasRenderingContext2D, fish: WaterFishFrame) {
  ctx.save(); ctx.globalAlpha = fish.opacity;
  drawFishSprite(ctx, { x: fish.x, y: fish.y - fish.jump * 5 * fish.size,
    size: 6.8 * fish.size, species: fish.species, angle: fish.angle,
    tailSwing: fish.tail, underwater: fish.jump <= 0 });
  ctx.restore();
}

/** Each crest has its own slow swell and bend. The group's envelope hides its
 * drift reset; independent rows avoid a rigid three-line stamp moving together. */
export function drawWaterBreeze(ctx: CanvasRenderingContext2D, wave: WaterBreezeFrame) {
  ctx.save(); ctx.strokeStyle = wave.dusk > .55 ? "#9dc5da" : "#b8e6df"; ctx.lineCap = "round";
  for (let row = 0; row < 3; row++) {
    const swell = Math.sin(wave.elapsed * (.35 + row * .071) + noise(wave.key + row * 11) * TAU);
    const width = wave.width * (1 - row * .19) * (.86 + swell * .1), x = wave.x + row * wave.scale * 1.6;
    const y = wave.y + (row - 1) * wave.scale * 2.1 + swell * wave.scale * .65;
    const bend = (Math.sin(wave.elapsed * .43 + row * 2.3 + wave.key) * .7 + .7) * (.65 + wave.wind * .55);
    ctx.globalAlpha = wave.opacity * (1 - row * .23) * (.68 + swell * .25);
    ctx.lineWidth = wave.scale * (row ? .4 : .54 + wave.wind * .24);
    ctx.beginPath(); ctx.moveTo(x - width / 2, y);
    ctx.bezierCurveTo(x - width * .22, y - wave.scale * bend,
      x + width * .05, y + wave.scale * bend, x + width * .24, y);
    ctx.stroke();
    ctx.beginPath(); ctx.moveTo(x + width * .32, y - wave.scale * .15);
    ctx.quadraticCurveTo(x + width * .42, y - wave.scale * .4, x + width / 2, y - wave.scale * .15); ctx.stroke();
  }
  ctx.restore();
}

export function drawWaterSplash(ctx: CanvasRenderingContext2D, splash: WaterSplashFrame) {
  const { phase: age, scale } = splash;
  ctx.save(); ctx.strokeStyle = "#c7e9df"; ctx.lineWidth = .7 * scale;
  ctx.globalAlpha = splash.opacity * (1 - smooth(age)) * .66;
  const radius = (1.4 + Math.sqrt(age) * 7.1) * scale;
  ctx.beginPath(); ctx.ellipse(splash.x, splash.y, radius, radius * .34, 0, .12, Math.PI * 1.85); ctx.stroke();
  if (age > .16) {
    const echo = (age - .16) / .84;
    ctx.globalAlpha *= .5 * (1 - smooth(echo)); ctx.beginPath();
    ctx.ellipse(splash.x, splash.y + .15 * scale, (1.1 + Math.sqrt(echo) * 5.7) * scale,
      (.45 + Math.sqrt(echo) * 1.8) * scale, 0, Math.PI * .6, Math.PI * 2.25); ctx.stroke();
  }
  if (age < .3) {
    ctx.globalAlpha = splash.opacity * (1 - age / .3) * .75;
    ctx.fillStyle = "#d5ece2";
    for (const [index, side] of [-1, .25, 1].entries()) {
      const flight = Math.min(1, age / (.22 + index * .035));
      const lift = 4 * flight * (1 - flight) * (3.6 + splash.variation * 1.2 - index * .25) * scale;
      ctx.beginPath(); ctx.ellipse(splash.x + side * flight * (2 + splash.variation) * scale,
        splash.y - lift, (.42 + index * .06) * scale, .7 * scale, side * .4, 0, TAU); ctx.fill();
    }
  }
  ctx.restore();
}
