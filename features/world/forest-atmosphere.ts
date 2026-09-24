import type { FixedWorldScene, WorldBounds } from "./tiled/types";
import { drawForestBird, drawForestButterfly, drawForestFirefly, type ForestAirParticle, type ForestBird, type ForestFirefly } from "./forest-wildlife";

import { forestBirdFrame, FOREST_BIRD_LIMIT } from "./forest-birds";
import { sampleForestRain, drawForestRain, type ForestRaindrop } from "./forest-rain";
import { isFaunaActiveAtTime } from "./forest-fauna";

const TAU = Math.PI * 2;
const WEATHER_PERIOD = 24 * 60;
export { FOREST_BIRD_FLIGHT_DURATION } from "./forest-birds";

export const FOREST_ATMOSPHERE_LIMITS = { butterflies: 6, fireflies: 12, birds: FOREST_BIRD_LIMIT, raindrops: 180 } as const;
export type ForestWeatherMode = "auto" | "clear" | "drizzle" | "rain" | "downpour";
export type ForestWildlifeMode = "auto" | "on" | "off";

const WEATHER_PRESETS = {
  clear: { rain: 0 },
  drizzle: { rain: .35 },
  rain: { rain: .68 },
  downpour: { rain: 1 },
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
  /** Session-owned fauna replace analytic ambient insects, including their scene partner. */
  fauna?: { elapsed: number; butterflies: ForestAirParticle[]; fireflies: ForestFirefly[] };
  birdFrame?: ForestBird[];
};

export type ForestAtmosphereState = {
  elapsed: number;
  dusk: number;
  rain: number;
  weather: Exclude<ForestWeatherMode, "auto">;
};

type AirParticle = ForestAirParticle;
type Bird = ForestBird;
type Raindrop = ForestRaindrop;
export type ForestAtmosphereFrame = ForestAtmosphereState & {
  butterflies: AirParticle[];
  fireflies: ForestFirefly[];
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

/** Long dry intervals with a gradual arrival and departure of gentle drizzle. */
export function forestAtmosphereState(scene: FixedWorldScene, options: ForestAtmosphereOptions): ForestAtmosphereState {
  const timestamp = options.reducedMotion ? 0 : finite(options.timestamp) / 1000;
  const phase = modulo(timestamp + noise(sceneSeed(scene.id), 0) * WEATHER_PERIOD, WEATHER_PERIOD);
  const rain = .42 * smooth((phase - 630) / 100) * (1 - smooth((phase - 870) / 120));
  const weather = options.weather && options.weather !== "auto" ? options.weather : undefined;
  return {
    elapsed: options.reducedMotion ? 0 : Math.max(0, finite(options.elapsed)),
    dusk: typeof options.dusk === "boolean" ? Number(options.dusk) : clamp(finite(options.dusk)),
    ...(weather ? WEATHER_PRESETS[weather] : { rain }),
    weather: weather ?? (rain > .04 ? "drizzle" : "clear"),
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

/** Small, unhurried drifting loops have the same speed in the clearing and across the map. */
function firefly(field: WorldBounds, seed: number, index: number, seconds: number, scale: number): ForestFirefly {
  const phase = noise(seed, index * 7) * TAU;
  const radiusX = Math.min(field.width * .065, scale * (11 + noise(seed, index * 7 + 1) * 8));
  const radiusY = Math.min(field.height * .05, scale * (7 + noise(seed, index * 7 + 2) * 5));
  const speed = .16 + noise(seed, index * 7 + 3) * .06;
  const horizontal = seconds * speed + phase, vertical = seconds * speed * .81 + phase * 1.7;
  const dx = Math.cos(horizontal) * radiusX * speed;
  const dy = Math.cos(vertical) * radiusY * speed * .81;
  return {
    x: field.x + field.width * (.15 + noise(seed, index * 7 + 4) * .7) + Math.sin(horizontal) * radiusX,
    y: field.y + field.height * (.15 + noise(seed, index * 7 + 5) * .7) + Math.sin(vertical) * radiusY,
    size: scale * (1.35 + noise(seed, index * 7 + 6) * .25),
    opacity: 1, phase, angle: Math.atan2(dy, dx) + Math.PI / 2,
  };
}

/** Pure world-coordinate samples; no camera size, asset, DOM, or mutable particle state. */
export function forestAtmosphereFrame(scene: FixedWorldScene, options: ForestAtmosphereOptions): ForestAtmosphereFrame {
  const state = forestAtmosphereState(scene, options), { world, focus, scale } = geometry(scene);
  const seed = sceneSeed(scene.id), seconds = state.elapsed;
  const frame: ForestAtmosphereFrame = { ...state, butterflies: [], fireflies: [], birds: [], raindrops: [] };
  const daylight = clamp((1 - state.dusk) * (1 - state.rain * 1.8));
  const butterflies = isFaunaActiveAtTime("butterfly", state.dusk) ? wildlifeVisibility(options.butterflies, daylight) : 0;
  const fireflies = isFaunaActiveAtTime("firefly", state.dusk) ? wildlifeVisibility(options.fireflies, state.dusk * (1 - state.rain)) : 0;

  if (!options.fauna && butterflies > .01) for (let i = 0; i < FOREST_ATMOSPHERE_LIMITS.butterflies; i++) {
    const particle = insect(i < 3 ? focus : world, seed, i + 1, seconds, scale);
    particle.size *= 1.35;
    particle.opacity = .85 * butterflies;
    frame.butterflies.push(particle);
  }
  if (!options.fauna && fireflies > .01) for (let i = 0; i < FOREST_ATMOSPHERE_LIMITS.fireflies; i++) {
    const particle = firefly(i < 5 ? focus : world, seed, i + 20, seconds, scale);
    particle.opacity = fireflies * .9;
    frame.fireflies.push(particle);
  }

  if (options.fauna) {
    frame.butterflies = options.fauna.butterflies;
    frame.fireflies = options.fauna.fireflies;
  }
  frame.birds = options.birdFrame ?? forestBirdFrame(scene, { ...options, elapsed: state.elapsed, dusk: state.dusk, rain: state.rain });
  frame.raindrops = sampleForestRain(scene, { elapsed: state.elapsed, rain: state.rain,
    reducedMotion: options.reducedMotion, automatic: !options.weather || options.weather === "auto" });
  return frame;
}

/** Shared wildlife and rain pass; scene illumination belongs to the lighting compositor. */
export function drawForestAtmosphere(ctx: CanvasRenderingContext2D, scene: FixedWorldScene,
  options: ForestAtmosphereOptions, paintLighting?: () => void) {
  const frame = forestAtmosphereFrame(scene, options);
  ctx.save();
  ctx.beginPath(); ctx.rect(0, 0, scene.width, scene.height); ctx.clip();
  for (const particle of frame.butterflies) drawForestButterfly(ctx, particle, options.fauna?.elapsed ?? frame.elapsed);
  for (const bird of frame.birds) drawForestBird(ctx, bird);
  // Bodies receive the same light as the scene; luminous insects remain above it.
  paintLighting?.();
  for (const particle of frame.fireflies) drawForestFirefly(ctx, particle, options.fauna?.elapsed ?? frame.elapsed);
  drawForestRain(ctx, scene, frame.raindrops);
  ctx.restore();
}
