import type { FeatureCollection, Point } from "geojson";
import { createEarthNightShadeLayer, EARTH_NIGHT_SHADE_LAYER } from "./night-shade-layer";
import { earthSeasonLightColor } from "./earth-seasons";
import type { ExpressionSpecification, GeoJSONSource, GeoJSONSourceSpecification, LayerSpecification, LightSpecification, Map, SkySpecification } from "maplibre-gl";

export type EarthLightingMode = "auto" | "day" | "evening";
export type EarthLightingCenter = { lng: number; lat: number };
type GlobePoint = [number, number];
type EarthLightingMap = Pick<Map, "getSource" | "setSky" | "setLight" | "getCenter" | "getLayer" | "addLayer" | "removeLayer" | "triggerRepaint"> & Partial<Pick<Map, "getZoom">>;

export const EARTH_LIGHTS_SOURCE = "earth-globe-city-lights";
const DEGREES = Math.PI / 180;
const MINUTE = 60_000;
const DEFAULT_CENTER: EarthLightingCenter = { lng: 35, lat: 27 };

// Hand-placed decorative pinpricks around inhabited regions, not a population,
// satellite or live electricity dataset. No location is obtained from a user.
const LIGHT_SEEDS: GlobePoint[] = [
  [-74, 41], [-80, 26], [-118, 34], [-122, 38], [-99, 19], [-74, 5], [-77, -12],
  [-46, -24], [-58, -35], [-0.1, 51.5], [2.3, 49], [-4, 40], [13, 52], [12, 42],
  [29, 41], [31, 30], [3, 6], [37, -1], [28, -26], [47, 25], [55, 25], [73, 19],
  [77, 29], [90, 24], [100, 14], [104, 1], [114, 22], [121, 31], [116, 40],
  [127, 37.5], [140, 36], [136, 35], [121, 15], [107, -6], [151, -34], [145, -38],
  [175, -37], [38, 56], [30, 60], [61, 57], [83, 55], [51, 36], [67, 25], [35, 32],
];

const normalizeLongitude = (longitude: number) => ((longitude + 180) % 360 + 360) % 360 - 180;
const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(high, value));

export function isEarthLightingMode(value: unknown): value is EarthLightingMode {
  return value === "auto" || value === "day" || value === "evening";
}

/** Approximate decorative solar position; deliberately no ephemeris or network request. */
export function earthSunPosition(now = Date.now()): GlobePoint {
  const date = new Date(now);
  if (!Number.isFinite(date.getTime())) throw new RangeError("Invalid Earth lighting time");
  const day = (now - Date.UTC(date.getUTCFullYear(), 0, 1)) / 86_400_000;
  const hours = date.getUTCHours() + date.getUTCMinutes() / 60 + date.getUTCSeconds() / 3600;
  const declination = 23.44 * Math.sin(2 * Math.PI * (day - 79) / 365.2422);
  return [normalizeLongitude(180 - hours * 15), declination];
}

function globeVector([longitude, latitude]: GlobePoint): [number, number, number] {
  const cosine = Math.cos(latitude * DEGREES);
  return [cosine * Math.cos(longitude * DEGREES), cosine * Math.sin(longitude * DEGREES), Math.sin(latitude * DEGREES)];
}

/** Compose a visible blue-hour night with a warm western rim, then keep the sun in world space. */
export function earthEveningSun(center: EarthLightingCenter = DEFAULT_CENTER): GlobePoint {
  const longitude = Number.isFinite(center.lng) ? normalizeLongitude(center.lng) : DEFAULT_CENTER.lng;
  const latitude = Number.isFinite(center.lat) ? clamp(center.lat, -90, 90) : DEFAULT_CENTER.lat;
  const normal = globeVector([longitude, latitude]);
  const west = [Math.sin(longitude * DEGREES), -Math.cos(longitude * DEGREES), 0];
  const angle = 112 * DEGREES;
  const sun = normal.map((component, index) => component * Math.cos(angle) + west[index] * Math.sin(angle));
  return [normalizeLongitude(Math.atan2(sun[1], sun[0]) / DEGREES), Math.asin(clamp(sun[2], -1, 1)) / DEGREES];
}

export function earthSolarFacing(point: GlobePoint, sun: GlobePoint): number {
  const normal = globeVector(point);
  const light = globeVector(sun);
  return normal.reduce((sum, component, index) => sum + component * light[index], 0);
}

export function createEarthLightingData(mode: EarthLightingMode = "auto", now = Date.now(), eveningCenter = DEFAULT_CENTER): {
  lights: FeatureCollection<Point>;
} {
  const lights: FeatureCollection<Point> = { type: "FeatureCollection", features: [] };
  if (mode === "day") return { lights };
  const sun = mode === "evening" ? earthEveningSun(eveningCenter) : earthSunPosition(now);
  for (const [index, point] of LIGHT_SEEDS.entries()) {
    const darkness = clamp((-earthSolarFacing(point, sun) + 0.06) / 0.4, 0, 1);
    if (darkness <= 0) continue;
    lights.features.push({ type: "Feature", properties: { strength: darkness * (0.7 + index % 4 * 0.1) },
      geometry: { type: "Point", coordinates: [...point] } });
  }
  return { lights };
}

export function earthLightingSources(now = Date.now(), mode: EarthLightingMode = "auto", eveningCenter = DEFAULT_CENTER): Record<string, GeoJSONSourceSpecification> {
  const data = createEarthLightingData(mode, now, eveningCenter);
  return {
    [EARTH_LIGHTS_SOURCE]: { type: "geojson", data: data.lights, maxzoom: 0, tolerance: 0, buffer: 0 },
  };
}

function opacityFade(property: string, end: number, strength = 1): ExpressionSpecification {
  const opacity: ExpressionSpecification = ["*", ["get", property], strength];
  return ["interpolate", ["linear"], ["zoom"], 0, opacity, 3, opacity, end, 0];
}

/** Insert after physical geometry/3D objects and before labels/position indicators. */
export function earthLightingLayers(): LayerSpecification[] {
  return [
    { id: "earth-city-lights-glow", type: "circle", source: EARTH_LIGHTS_SOURCE, maxzoom: 4.5,
      paint: { "circle-color": "#ffb967", "circle-radius": 6.5, "circle-blur": 0.85,
        "circle-opacity": opacityFade("strength", 4.5, 0.85), "circle-pitch-alignment": "map", "circle-pitch-scale": "viewport" } },
    { id: "earth-city-lights-core", type: "circle", source: EARTH_LIGHTS_SOURCE, maxzoom: 4.5,
      paint: { "circle-color": "#fff2bd", "circle-radius": 1.5, "circle-blur": 0.12,
        "circle-opacity": opacityFade("strength", 4.5), "circle-pitch-alignment": "map", "circle-pitch-scale": "viewport" } },
  ];
}

export function earthLightingSky(mode: EarthLightingMode): SkySpecification {
  const evening = mode === "evening";
  return {
    "sky-color": evening ? "#0c142e" : "#123b42",
    "horizon-color": evening ? "#d89982" : "#9bd4cf",
    "fog-color": evening ? "#a89cae" : "#abd5cc",
    "sky-horizon-blend": evening ? 0.32 : 0.18,
    "horizon-fog-blend": 0.35, "fog-ground-blend": 0.45,
    "atmosphere-blend": ["interpolate", ["linear"], ["zoom"], 0, 0.38, 5, 0.22, 8, 0],
  };
}

export function earthLightingLight(mode: EarthLightingMode, now = Date.now(), latitude = DEFAULT_CENTER.lat): LightSpecification {
  return { anchor: "viewport", color: earthSeasonLightColor(mode === "evening" ? "#ffd5a1" : "#fff7e9", latitude, now),
    intensity: mode === "evening" ? 0.42 : 0.35, position: [1.5, 210, 35] };
}

/** No timer: the ready/visible scene clock supplies time, at most one source update per UTC minute. */
export function createEarthLightingController(map: EarthLightingMap, options: {
  mode?: EarthLightingMode; center?: EarthLightingCenter; now?: number;
} = {}) {
  let mode = options.mode ?? "auto";
  let center = options.center ?? DEFAULT_CENTER;
  let lastKey = "";
  let lastLightKey = "";
  let disposed = false;
  const night = createEarthNightShadeLayer(map);
  map.addLayer(night.layer, map.getLayer("earth-city-lights-glow") ? "earth-city-lights-glow" : undefined);
  const update = (now = Date.now()) => {
    if (disposed || !Number.isFinite(now)) return;
    // Use the viewed hemisphere, not the visitor's location. A coarse latitude
    // sample avoids changing light while dragging within the same region.
    const latitude = Math.round((mode === "evening" ? center.lat : map.getCenter().lat) / 10) * 10;
    const lightKey = `${mode}:${Math.floor(now / 86_400_000)}:${latitude}`;
    if (lightKey !== lastLightKey) {
      map.setLight(earthLightingLight(mode, now, latitude));
      lastLightKey = lightKey;
    }
    const key = mode === "auto" ? `${mode}:${Math.floor(now / MINUTE)}` : `${mode}:${center.lng}:${center.lat}`;
    if (key === lastKey) return;
    const lightsSource = map.getSource(EARTH_LIGHTS_SOURCE) as GeoJSONSource | undefined;
    if (!lightsSource?.setData) return;
    const data = createEarthLightingData(mode, Math.floor(now / MINUTE) * MINUTE, center);
    const sun = mode === "evening" ? earthEveningSun(center) : earthSunPosition(Math.floor(now / MINUTE) * MINUTE);
    night.setLighting(globeVector(sun), { night: mode !== "day" });
    lightsSource.setData(data.lights);
    if (!lastKey || !lastKey.startsWith(`${mode}:`)) {
      map.setSky(earthLightingSky(mode));
    }
    lastKey = key;
  };
  update(options.now);
  return {
    update,
    setMode(next: EarthLightingMode, nextCenter?: EarthLightingCenter, now = Date.now()) {
      if (disposed) return;
      mode = next;
      if (nextCenter) center = { ...nextCenter };
      update(now);
    },
    setVisible(value: boolean) { night.setVisible(value); },
    dispose() {
      if (disposed) return;
      disposed = true;
      if (map.getLayer(EARTH_NIGHT_SHADE_LAYER)) map.removeLayer(EARTH_NIGHT_SHADE_LAYER);
      night.dispose();
    },
  };
}
