import type { ExpressionSpecification, Map as MapLibreMap } from "maplibre-gl";

export const EARTH_BIOME_LAYER = "earth-illustrated-biomes";
export const EARTH_VEGETATION_LAYER = "earth-illustrated-vegetation";
export const EARTH_BIOME_PALETTE = {
  rainforest: "#589b76", boreal: "#6f9c89", tundra: "#c3c5a0",
  desert: "#dfc28c", savanna: "#c4ca88", steppe: "#a9c18b",
} as const;

const DAY = 86_400_000;
const YEAR = 365.2422 * DAY;
// A continuous decorative annual cycle, with a little seasonal lag after the
// solstice. It has no month/year switch and does not describe actual weather.
const NORTHERN_WINTER = Date.UTC(2000, 0, 15, 12);
const LATITUDE_STOPS = [-75, -60, -45, -30, 30, 45, 60, 75];
const clamp = (value: number) => Math.max(0, Math.min(1, value));
const smooth = (value: number) => { const t = clamp(value); return t * t * (3 - 2 * t); };

/** Artistic accents only; tropical greenery is intentionally unchanged. */
export function earthSeasonAt(latitude: number, now = Date.now()) {
  if (!Number.isFinite(latitude) || !Number.isFinite(now)) return { autumn: 0, winter: 0, spring: 0 };
  const angle = 2 * Math.PI * (now - NORTHERN_WINTER) / YEAR + (latitude < 0 ? Math.PI : 0);
  const temperate = smooth((Math.abs(latitude) - 30) / 25);
  const cold = smooth((Math.abs(latitude) - 40) / 28);
  return {
    autumn: Math.max(0, -Math.sin(angle)) ** 4 * temperate,
    winter: Math.max(0, (Math.cos(angle) - 0.3) / 0.7) ** 1.4 * cold,
    spring: Math.max(0, Math.sin(angle)) ** 4 * temperate,
  };
}

function mixColor(base: string, accent: string, amount: number): string {
  const weight = clamp(amount);
  const channel = (color: string, offset: number) => Number.parseInt(color.slice(offset, offset + 2), 16);
  return `#${[1, 3, 5].map(offset => Math.round(channel(base, offset) * (1 - weight)
    + channel(accent, offset) * weight).toString(16).padStart(2, "0")).join("")}`;
}

/** A UTC day's shared sample keeps the initial style and controller identical. */
function seasonDay(now: number): number {
  return Number.isFinite(now) ? Math.floor(now / DAY) * DAY + DAY / 2 : NaN;
}

function latitudeColors(now: number, base: string, accents: {
  autumn: string; autumnStrength: number; snow: string; snowStrength: number;
}): ExpressionSpecification {
  const stops = LATITUDE_STOPS.flatMap(latitude => {
    const season = earthSeasonAt(latitude, now);
    const autumn = mixColor(base, accents.autumn, season.autumn * accents.autumnStrength);
    const spring = mixColor(autumn, "#86ad82", season.spring * 0.055);
    return [latitude, mixColor(spring, accents.snow, season.winter * accents.snowStrength)];
  });
  return ["interpolate", ["linear"], ["to-number", ["get", "seasonLatitude"], 0], ...stops] as ExpressionSpecification;
}

/** Only existing, land-clipped boreal/tundra/steppe artwork changes colour. */
export function earthSeasonBiomeColor(now = Date.now()): ExpressionSpecification {
  const time = seasonDay(now), p = EARTH_BIOME_PALETTE;
  return ["match", ["get", "biome"], "rainforest", ["to-color", p.rainforest],
    "boreal", latitudeColors(time, p.boreal, { autumn: "#b5a36c", autumnStrength: 0.3, snow: "#dbe1d6", snowStrength: 0.54 }),
    "tundra", latitudeColors(time, p.tundra, { autumn: "#b6a27d", autumnStrength: 0.2, snow: "#edf0e5", snowStrength: 0.8 }),
    "desert", p.desert, "savanna", p.savanna,
    "steppe", latitudeColors(time, p.steppe, { autumn: "#c4b379", autumnStrength: 0.23, snow: "#d6dece", snowStrength: 0.3 }),
    "#b5d39b"];
}

/** Evergreen silhouettes retain their green body, with softly frosted facets. */
export function earthSeasonVegetationColor(now = Date.now()): ExpressionSpecification {
  const time = seasonDay(now);
  return ["case", ["==", ["get", "tone"], "shadow"], ["to-color", "rgba(49, 86, 66, 0.2)"],
    ["==", ["get", "tone"], "trunk"], "rgba(102, 103, 68, 0.7)",
    ["==", ["get", "family"], "boreal"],
    ["case", ["==", ["get", "tone"], "light"],
      latitudeColors(time, "#83af92", { autumn: "#b1b67d", autumnStrength: 0.2, snow: "#e1e7d8", snowStrength: 0.68 }),
      latitudeColors(time, "#437c6b", { autumn: "#8c9966", autumnStrength: 0.2, snow: "#acc4b1", snowStrength: 0.25 })],
    ["==", ["get", "family"], "rainforest"],
    ["case", ["==", ["get", "tone"], "light"], "#80b58b", "#3d8065"],
    ["case", ["==", ["get", "tone"], "light"], "#c1ce89", "#8b9e5c"]];
}

/** Very slight cool/warm light tint, based on the viewed hemisphere. */
export function earthSeasonLightColor(base: string, latitude: number, now = Date.now()): string {
  const season = earthSeasonAt(latitude, seasonDay(now));
  return mixColor(mixColor(base, "#ffdcad", season.autumn * 0.07), "#e6f2ff", season.winter * 0.1);
}

type EarthSeasonsMap = Pick<MapLibreMap, "getLayer" | "setPaintProperty">;

/**
 * No clock, sources, geometry, or frame work. The existing scene supplies time.
 * Retry absent/replaced layers, and otherwise update their paint once per day.
 */
export function createEarthSeasonsController(map: EarthSeasonsMap, options: { now?: number } = {}) {
  const applied = new Map<string, { day: number; layer: unknown }>();
  let disposed = false;
  const update = (now = Date.now()) => {
    if (disposed || !Number.isFinite(now)) return;
    const day = Math.floor(now / DAY);
    for (const [id, color] of [
      [EARTH_BIOME_LAYER, earthSeasonBiomeColor], [EARTH_VEGETATION_LAYER, earthSeasonVegetationColor],
    ] as const) {
      const layer = map.getLayer(id), previous = applied.get(id);
      if (!layer) { applied.delete(id); continue; }
      if (previous?.day === day && previous.layer === layer) continue;
      map.setPaintProperty(id, "fill-color", color(now));
      applied.set(id, { day, layer });
    }
  };
  update(options.now);
  return { update, dispose() { disposed = true; applied.clear(); } };
}
