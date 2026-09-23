import type { FixedWorldScene, WorldBounds } from "./tiled/types";
import { drawForestBird, drawForestButterfly, drawForestFirefly, type ForestAirParticle, type ForestBird } from "./forest-wildlife";

import { forestBirdFrame, FOREST_BIRD_LIMIT } from "./forest-birds";
import { sampleForestRain, drawForestRain, type ForestRaindrop } from "./forest-rain";

const TAU = Math.PI * 2;
const WEATHER_PERIOD = 24 * 60;
export { FOREST_BIRD_FLIGHT_DURATION } from "./forest-birds";

export const FOREST_ATMOSPHERE_LIMITS = { butterflies: 6, fireflies: 12, birds: FOREST_BIRD_LIMIT, raindrops: 180 } as const;
export type ForestWeatherMode = "auto" | "clear" | "cloudy" | "drizzle" | "rain" | "downpour";
export type ForestWildlifeMode = "auto" | "on" | "off";

const WEATHER_PRESETS = {
  clear: { rain: 0, cloudiness: 0 },
  cloudy: { rain: 0, cloudiness: .8 },
  drizzle: { rain: .35, cloudiness: .65 },
  rain: { rain: .68, cloudiness: .85 },
  downpour: { rain: 1, cloudiness: 1 },
} as const;

export type ForestAtmosphereOptions = {
  /** Shared scene clock, in seconds; the renderer owns advancing and pausing it. */
  elapsed: number;
  /** Shared scene clock, in epoch milliseconds, for the slow weather schedule. */
  timestamp: number;
  dusk: boolean | number;
  reducedMotion: boolean;
  weather?: ForestWeatherMode;
  butterflies?: ForestWildlifeMode | boolean;
  fireflies?: ForestWildlifeMode | boolean;
  birds?: ForestWildlifeMode | boolean;
  /** Seconds since a manual flight trigger; overrides the schedule until removed. */
  birdElapsed?: number;
  birdSeed?: number;
};

export type ForestAtmosphereState = {
  elapsed: number;
  dusk: number;
  rain: number;
  cloudiness: number;
  weather: Exclude<ForestWeatherMode, "auto">;
};

type AirParticle = ForestAirParticle;
type Bird = ForestBird;
type Raindrop = ForestRaindrop;
export type ForestAtmosphereFrame = ForestAtmosphereState & {
  butterflies: AirParticle[];
  fireflies: AirParticle[];
  birds: Bird[];
  raindrops: Raindrop[];
};

const clamp = (value: number, min = 0, max = 1) => Math.max(min, Math.min(max, value));
const finite = (value: number) => Number.isFinite(value) ? value : 0;
const modulo = (value: number, period: number) => ((value % period) + period) % period;
const smooth = (value: number) => { const t = clamp(value); return t * t * (3 - 2 * t); };
const forcedOn = (mode: ForestWildlifeMode | boolean | undefined) => mode === "on" || mode === true;
const wildlifeVisibility = (mode: ForestWildlifeMode | boolean | undefined, automatic: number) =>
  mode === "off" || mode === false ? 0 : forcedOn(mode) ? 1 : clamp(automatic);

function sceneSeed(id: string) {
  let seed = 2166136261;
  for (let i = 0; i < id.length; i++) seed = Math.imul(seed ^ id.charCodeAt(i), 16777619);
  return seed >>> 0;
}

/** Stateless noise keeps both cameras in agreement, regardless of draw order. */
function noise(seed: number, index: number) {
  let value = (seed + Math.imul(index + 1, 0x9e3779b9)) | 0;
  value = Math.imul(value ^ value >>> 16, 0x21f0aaad);
  value = Math.imul(value ^ value >>> 15, 0x735a2d97);
  return ((value ^ value >>> 15) >>> 0) / 4294967296;
}

/** Clear intervals, slowly gathering cloud, gentle drizzle, then clearing again. */
export function forestAtmosphereState(scene: FixedWorldScene, options: ForestAtmosphereOptions): ForestAtmosphereState {
  const timestamp = options.reducedMotion ? 0 : finite(options.timestamp) / 1000;
  const phase = modulo(timestamp + noise(sceneSeed(scene.id), 0) * WEATHER_PERIOD, WEATHER_PERIOD);
  const cloudiness = smooth((phase - 420) / 150) * (1 - smooth((phase - 990) / 180));
  const rain = .42 * smooth((phase - 630) / 100) * (1 - smooth((phase - 870) / 120));
  const weather = options.weather && options.weather !== "auto" ? options.weather : undefined;
  return {
    elapsed: options.reducedMotion ? 0 : Math.max(0, finite(options.elapsed)),
    dusk: typeof options.dusk === "boolean" ? Number(options.dusk) : clamp(finite(options.dusk)),
    ...(weather ? WEATHER_PRESETS[weather] : { rain, cloudiness }),
    weather: weather ?? (rain > .04 ? "drizzle" : cloudiness > .12 ? "cloudy" : "clear"),
  };
}

function geometry(scene: FixedWorldScene) {
  const width = Math.max(1, finite(scene.width)), height = Math.max(1, finite(scene.height));
  const x = clamp(finite(scene.focus.x), 0, width - 1), y = clamp(finite(scene.focus.y), 0, height - 1);
  const focus = { x, y, width: clamp(finite(scene.focus.width), 1, width - x),
    height: clamp(finite(scene.focus.height), 1, height - y) };
  return { world: { x: 0, y: 0, width, height }, focus,
    scale: clamp(Math.min(focus.width, focus.height) / 256, .35, 2) };
}

function insect(field: WorldBounds, seed: number, index: number, seconds: number, scale: number): AirParticle {
  const phase = noise(seed, index * 5) * TAU;
  // The central band and small orbit keep airborne particles away from map edges.
  return {
    x: field.x + field.width * (.15 + noise(seed, index * 5 + 1) * .7 + Math.sin(seconds * .28 + phase) * .055),
    y: field.y + field.height * (.15 + noise(seed, index * 5 + 2) * .7 + Math.sin(seconds * .21 + phase * 2) * .04),
    size: scale * (.8 + noise(seed, index * 5 + 3) * .3), opacity: 1, phase,
  };
}

/** Pure world-coordinate samples; no camera size, asset, DOM, or mutable particle state. */
export function forestAtmosphereFrame(scene: FixedWorldScene, options: ForestAtmosphereOptions): ForestAtmosphereFrame {
  const state = forestAtmosphereState(scene, options), { world, focus, scale } = geometry(scene);
  const seed = sceneSeed(scene.id), seconds = state.elapsed;
  const frame: ForestAtmosphereFrame = { ...state, butterflies: [], fireflies: [], birds: [], raindrops: [] };
  const daylight = clamp((1 - state.dusk) * (1 - state.rain * 1.8));
  const butterflies = wildlifeVisibility(options.butterflies, daylight);
  const fireflies = wildlifeVisibility(options.fireflies, state.dusk * (1 - state.rain));

  if (butterflies > .01) for (let i = 0; i < FOREST_ATMOSPHERE_LIMITS.butterflies; i++) {
    const particle = insect(i < 3 ? focus : world, seed, i + 1, seconds, scale);
    particle.size *= 1.35;
    particle.opacity = .85 * butterflies;
    frame.butterflies.push(particle);
  }
  if (fireflies > .01) for (let i = 0; i < FOREST_ATMOSPHERE_LIMITS.fireflies; i++) {
    const particle = insect(i < 5 ? focus : world, seed, i + 20, seconds * .62, scale);
    const pulse = .5 + Math.sin(seconds * .65 + particle.phase) * .5;
    particle.size *= 1.5;
    particle.opacity = fireflies * (.4 + pulse * pulse * .5);
    frame.fireflies.push(particle);
  }

  frame.birds = forestBirdFrame(scene, { ...options, elapsed: state.elapsed, dusk: state.dusk, rain: state.rain });
  frame.raindrops = sampleForestRain(scene, { elapsed: state.elapsed, rain: state.rain,
    reducedMotion: options.reducedMotion, automatic: !options.weather || options.weather === "auto" });
  return frame;
}

/** Paint once after terrain, buildings and actor; both views use the same clock and scene. */
export function drawForestAtmosphere(ctx: CanvasRenderingContext2D, scene: FixedWorldScene, options: ForestAtmosphereOptions) {
  const frame = forestAtmosphereFrame(scene, options);
  ctx.save();
  ctx.beginPath(); ctx.rect(0, 0, scene.width, scene.height); ctx.clip();
  // One restrained flat tint leaves the baked grass and bushes crisp at every zoom.
  const shade = frame.dusk * .18 + frame.cloudiness * .045 + frame.rain * .04;
  if (shade > 0) {
    ctx.globalAlpha = shade; ctx.fillStyle = frame.dusk > .1 ? "#18324b" : "#526b72";
    ctx.fillRect(0, 0, scene.width, scene.height);
  }

  for (const particle of frame.butterflies) drawForestButterfly(ctx, particle, frame.elapsed);
  for (const particle of frame.fireflies) drawForestFirefly(ctx, particle, frame.elapsed);
  for (const bird of frame.birds) drawForestBird(ctx, bird);
  drawForestRain(ctx, scene, frame.raindrops);
  ctx.restore();
}
