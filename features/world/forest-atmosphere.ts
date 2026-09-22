import type { FixedWorldScene, WorldBounds, WorldPoint } from "./tiled/types";

const TAU = Math.PI * 2;
const WEATHER_PERIOD = 24 * 60;
const BIRD_PERIOD = 112;
const BIRD_DURATION = 18;

export const FOREST_ATMOSPHERE_LIMITS = { butterflies: 6, fireflies: 12, birds: 2, raindrops: 36 } as const;

export type ForestAtmosphereOptions = {
  /** Shared scene clock, in seconds; the renderer owns advancing and pausing it. */
  elapsed: number;
  /** Shared scene clock, in epoch milliseconds, for the slow weather schedule. */
  timestamp: number;
  dusk: boolean | number;
  reducedMotion: boolean;
};

export type ForestAtmosphereState = {
  elapsed: number;
  dusk: number;
  rain: number;
  cloudiness: number;
  weather: "clear" | "cloudy" | "drizzle";
};

type AirParticle = WorldPoint & { size: number; opacity: number; phase: number };
type Bird = AirParticle & { angle: number };
export type ForestAtmosphereFrame = ForestAtmosphereState & {
  butterflies: AirParticle[];
  fireflies: AirParticle[];
  birds: Bird[];
  raindrops: AirParticle[];
};

const clamp = (value: number, min = 0, max = 1) => Math.max(min, Math.min(max, value));
const finite = (value: number) => Number.isFinite(value) ? value : 0;
const modulo = (value: number, period: number) => ((value % period) + period) % period;
const smooth = (value: number) => { const t = clamp(value); return t * t * (3 - 2 * t); };

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
  return {
    elapsed: options.reducedMotion ? 0 : Math.max(0, finite(options.elapsed)),
    dusk: typeof options.dusk === "boolean" ? Number(options.dusk) : clamp(finite(options.dusk)),
    rain, cloudiness,
    weather: rain > .04 ? "drizzle" : cloudiness > .12 ? "cloudy" : "clear",
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
  const daylight = (1 - state.dusk) * (1 - state.rain * 1.8);

  if (daylight > .01) for (let i = 0; i < FOREST_ATMOSPHERE_LIMITS.butterflies; i++) {
    const particle = insect(i < 3 ? focus : world, seed, i + 1, seconds, scale);
    particle.opacity = .7 * daylight;
    frame.butterflies.push(particle);
  }
  if (state.dusk > .01) for (let i = 0; i < FOREST_ATMOSPHERE_LIMITS.fireflies; i++) {
    const particle = insect(i < 5 ? focus : world, seed, i + 20, seconds * .62, scale);
    const pulse = .5 + Math.sin(seconds * .65 + particle.phase) * .5;
    particle.opacity = state.dusk * (1 - state.rain) * (.25 + pulse * pulse * .5);
    frame.fireflies.push(particle);
  }

  if (!options.reducedMotion && daylight > .05) {
    const clock = seconds + noise(seed, 210) * BIRD_PERIOD;
    const phase = modulo(clock, BIRD_PERIOD), cycle = Math.floor(clock / BIRD_PERIOD);
    const direction = noise(seed, cycle + 211) > .5 ? 1 : -1;
    const count = noise(seed, cycle + 310) > .65 ? 2 : 1;
    for (let i = 0; i < count; i++) {
      const progress = (phase - i * .65) / BIRD_DURATION;
      if (progress < 0 || progress > 1) continue;
      const across = direction === 1 ? progress : 1 - progress;
      const rise = Math.sin(progress * Math.PI), bend = Math.cos(progress * Math.PI) * Math.PI;
      const y = focus.y + focus.height * (.26 + noise(seed, cycle + 410) * .25 + rise * .13) + i * scale * 7;
      frame.birds.push({ x: world.width * across, y: clamp(y, 0, world.height), size: scale,
        angle: Math.atan2(focus.height * .13 * bend, direction * world.width),
        opacity: smooth(progress / .12) * smooth((1 - progress) / .12) * daylight * .55,
        phase: seconds * 7 + i * 1.7,
      });
    }
  }

  if (!options.reducedMotion && state.rain > .001) for (let i = 0; i < FOREST_ATMOSPHERE_LIMITS.raindrops; i++) {
    const field = i < 12 ? focus : world;
    const phase = modulo(noise(seed, i + 510) + seconds * scale * 75 / field.height, 1);
    const fade = smooth(phase / .1) * smooth((1 - phase) / .1);
    frame.raindrops.push({
      x: field.x + field.width * (.05 + noise(seed, i + 610) * .9)
        - Math.sin(phase * Math.PI) * Math.min(scale * 3, field.width * .035),
      y: field.y + field.height * phase,
      size: scale * (.75 + noise(seed, i + 710) * .5),
      opacity: state.rain * fade * .38, phase,
    });
  }
  return frame;
}

/** Paint once after terrain, buildings and actor; both views use the same clock and scene. */
export function drawForestAtmosphere(ctx: CanvasRenderingContext2D, scene: FixedWorldScene, options: ForestAtmosphereOptions) {
  const frame = forestAtmosphereFrame(scene, options);
  ctx.save();
  ctx.beginPath(); ctx.rect(0, 0, scene.width, scene.height); ctx.clip();
  // One restrained flat tint leaves the baked grass and bushes crisp at every zoom.
  const shade = frame.dusk * .18 + frame.cloudiness * .035;
  if (shade > 0) {
    ctx.globalAlpha = shade; ctx.fillStyle = frame.dusk > .1 ? "#18324b" : "#526b72";
    ctx.fillRect(0, 0, scene.width, scene.height);
  }

  for (let i = 0; i < frame.butterflies.length; i++) {
    const particle = frame.butterflies[i], s = particle.size;
    const spread = s * (1.1 + Math.abs(Math.sin(frame.elapsed * 7 + particle.phase)) * 1.4);
    ctx.globalAlpha = particle.opacity; ctx.fillStyle = i % 2 ? "#e0c995" : "#d6dbc0";
    ctx.fillRect(particle.x - spread, particle.y - s, spread - s * .3, s * 2);
    ctx.fillRect(particle.x + s * .3, particle.y - s, spread - s * .3, s * 2);
    ctx.fillStyle = "#69775c"; ctx.fillRect(particle.x - s * .3, particle.y - s, s * .6, s * 2.3);
  }
  for (const particle of frame.fireflies) {
    const s = particle.size;
    ctx.fillStyle = "#d5e8a0"; ctx.globalAlpha = particle.opacity * .12;
    ctx.beginPath(); ctx.ellipse(particle.x, particle.y, s * 3.1, s * 3.1, 0, 0, TAU); ctx.fill();
    ctx.globalAlpha = particle.opacity; ctx.fillStyle = "#e5edb6";
    ctx.fillRect(particle.x - s * .55, particle.y - s * .55, s * 1.1, s * 1.1);
  }
  for (const bird of frame.birds) {
    const s = bird.size, spread = 2.5 + Math.abs(Math.sin(bird.phase)) * 2;
    ctx.save(); ctx.translate(bird.x, bird.y); ctx.rotate(bird.angle);
    ctx.globalAlpha = bird.opacity; ctx.strokeStyle = "#34453c"; ctx.lineWidth = s * .85;
    ctx.beginPath(); ctx.moveTo(-s * 2, -spread * s); ctx.lineTo(0, 0); ctx.lineTo(-s * 2, spread * s); ctx.stroke();
    ctx.fillStyle = "#34453c"; ctx.fillRect(-s * 1.8, -s * .55, s * 3.8, s * 1.1);
    ctx.restore();
  }
  ctx.strokeStyle = "#bed0cb"; ctx.lineWidth = .65;
  for (const drop of frame.raindrops) {
    ctx.globalAlpha = drop.opacity;
    ctx.beginPath(); ctx.moveTo(drop.x, drop.y); ctx.lineTo(drop.x - drop.size, drop.y + drop.size * 4); ctx.stroke();
  }
  ctx.restore();
}
