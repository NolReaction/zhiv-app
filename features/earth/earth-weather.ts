import type { Map as LibreMap, Marker } from "maplibre-gl";
import { earthWeatherArea, EARTH_WEATHER_MIN_ZOOM, type EarthWeatherSnapshot } from "./weather";
import { EARTH_CLOUD_TILE_SIZE, earthCloudSeed, earthCloudTilePixels, type EarthCloudMaterial } from "./cloud-art";
import { earthWeatherCanvasSize, earthWeatherFootprint, earthWeatherFrame, type EarthWeatherFootprint } from "./weather-field";
import styles from "./earth-weather.module.css";

const FRAME_MS = 125;
const MAX_TEXTURES = 4;
const MAX_RAIN = 56;
const MAX_SNOW = 42;
type Texture = { canvas: HTMLCanvasElement; x: number; y: number; span: number };
const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(high, value));
const random = (index: number, seed: number) => {
  let value = Math.imul(index + 1, 374761393) ^ seed;
  value = Math.imul(value ^ value >>> 13, 1274126177);
  return ((value ^ value >>> 16) >>> 0) / 4294967295;
};
function precipitating(condition: string) { return ["rain", "snow", "sleet", "thunderstorm"].includes(condition); }

/** Forecast only: one continuous transparent material, no repeated map icons. */
export function createEarthWeather(map: LibreMap, _MarkerConstructor?: typeof Marker) {
  // Retain the scene factory signature while weather uses one native canvas.
  void _MarkerConstructor;
  const host = map.getCanvasContainer(), owner = host.ownerDocument;
  let snapshot: EarthWeatherSnapshot | null = null;
  let visible = false, disposed = false, motionEnabled = true, drawing = false;
  let elapsedMs = 0, lastFrame = -1;
  let precipitationScale = 1;
  let canvas: HTMLCanvasElement | null = null, context: CanvasRenderingContext2D | null = null;
  let footprint: EarthWeatherFootprint | null = null;
  let frame: ReturnType<typeof earthWeatherFrame> = null;
  let materialKey = "";
  const textures = new Map<string, Texture>();

  function releaseTextures() {
    for (const texture of textures.values()) { texture.canvas.width = 1; texture.canvas.height = 1; }
    textures.clear();
  }
  function ensureCanvas() {
    if (canvas) return;
    canvas = owner.createElement("canvas"); canvas.className = styles.field;
    canvas.dataset.earthWeather = "true"; canvas.setAttribute("aria-hidden", "true");
    canvas.style.pointerEvents = "none"; canvas.hidden = true;
    context = canvas.getContext("2d"); host.append(canvas);
  }
  function material(): EarthCloudMaterial {
    const condition = snapshot!.condition;
    const fallback = condition === "partly-cloudy" ? 40 : condition === "fog" ? 65 : 90;
    return { coverage: clamp((snapshot!.cloudCoverPercent ?? fallback) / 100, 0, 1), night: snapshot!.isDay === false,
      storm: condition === "thunderstorm" || condition === "rain" || condition === "sleet" };
  }
  function texture(x: number, y: number, span: number, value: EarthCloudMaterial) {
    const key = `${frame!.worldSize}:${span}:${x}:${y}`;
    const cached = textures.get(key);
    if (cached) { textures.delete(key); textures.set(key, cached); return cached; }
    const source = owner.createElement("canvas"); source.width = EARTH_CLOUD_TILE_SIZE; source.height = EARTH_CLOUD_TILE_SIZE;
    const target = source.getContext("2d");
    if (target) {
      const image = target.createImageData(source.width, source.height);
      image.data.set(earthCloudTilePixels(x, y, frame!.worldSize, earthCloudSeed(snapshot!.area.key), value,
        EARTH_CLOUD_TILE_SIZE, span, frame!.clip));
      target.putImageData(image, 0, 0);
    }
    const result = { canvas: source, x, y, span }; textures.set(key, result);
    while (textures.size > MAX_TEXTURES) {
      const oldest = textures.keys().next().value!;
      const old = textures.get(oldest)!; old.canvas.width = 1; old.canvas.height = 1; textures.delete(oldest);
    }
    return result;
  }
  function cloudTiles(value: EarthCloudMaterial) {
    if (!frame || !value.coverage) return [];
    const padding = 128, bounds = frame.bounds;
    const span = 2 ** Math.ceil(Math.log2(Math.max(2048, bounds.right - bounds.left + padding * 2,
      bounds.bottom - bounds.top + padding * 2)));
    const left = Math.floor((bounds.left - padding) / span), right = Math.floor((bounds.right + padding - 1e-6) / span);
    const top = Math.floor((bounds.top - padding) / span), bottom = Math.floor((bounds.bottom + padding - 1e-6) / span);
    const result: Texture[] = [];
    for (let row = top; row <= bottom && result.length < MAX_TEXTURES; row++)
      for (let column = left; column <= right && result.length < MAX_TEXTURES; column++) result.push(texture(column * span, row * span, span, value));
    return result;
  }
  function draw() {
    if (disposed || !drawing || !snapshot || !canvas || !context || !footprint || !frame) return;
    const index = motionEnabled ? Math.floor(elapsedMs / FRAME_MS) : 0;
    if (index === lastFrame) return;
    lastFrame = index;
    const container = map.getContainer(), width = container.clientWidth, height = container.clientHeight;
    const size = earthWeatherCanvasSize(width, height, owner.defaultView?.devicePixelRatio ?? 1);
    if (!size) return;
    if (canvas.width !== size.width) canvas.width = size.width;
    if (canvas.height !== size.height) canvas.height = size.height;
    context.setTransform(size.ratio, 0, 0, size.ratio, 0, 0); context.clearRect(0, 0, width, height);
    context.save(); context.beginPath();
    for (const [pointIndex, point] of footprint.points.entries()) {
      if (pointIndex === 0) context.moveTo(point.x, point.y); else context.lineTo(point.x, point.y);
    }
    context.closePath(); context.clip();
    const time = index * FRAME_MS / 1000, value = material();
    const wind = clamp(snapshot.windSpeedMps ?? 3, 0, 30);
    const driftX = motionEnabled ? Math.sin(time / 35) * (4 + wind * .3) : 0;
    const driftY = motionEnabled ? Math.sin(time / 48) * 3 : 0;
    const tiles = cloudTiles(value);
    context.save(); context.translate(frame.base.x, frame.base.y);
    context.transform(frame.basis.a, frame.basis.b, frame.basis.c, frame.basis.d, 0, 0);
    for (const tile of tiles) context.drawImage(tile.canvas, tile.x - frame.origin.x + driftX,
      tile.y - frame.origin.y + driftY, tile.span, tile.span);
    context.restore();
    if (snapshot.condition === "fog") {
      const haze = context.createLinearGradient(0, 0, width, height);
      haze.addColorStop(0, "rgba(205,221,218,.04)"); haze.addColorStop(.5, "rgba(205,221,218,.13)"); haze.addColorStop(1, "rgba(205,221,218,.025)");
      context.fillStyle = haze; context.fillRect(0, 0, width, height);
    }
    const snow = snapshot.condition === "snow", precipitation = precipitating(snapshot.condition);
    const maximum = snow ? MAX_SNOW : MAX_RAIN;
    const count = precipitation ? Math.floor(Math.min(maximum, Math.floor(footprint.surface / (snow ? 16000 : 12000))) * precipitationScale) : 0;
    const seed = earthCloudSeed(snapshot.area.key), { left, right, top, bottom } = footprint.bounds;
    const rainWidth = right - left, rainHeight = bottom - top;
    context.lineWidth = 1; context.lineCap = "round";
    for (let particle = 0; particle < count; particle++) {
      const flake = snow || snapshot.condition === "sleet" && particle % 3 === 0;
      const progress = (random(particle, seed) + time / (flake ? 11 : 3.6)) % 1;
      const x = left + ((random(particle + 91, seed) * rainWidth + (flake ? Math.sin(time / 3 + particle) * 6 : -time * 13)) % rainWidth + rainWidth) % rainWidth;
      const y = top + progress * rainHeight;
      context.globalAlpha = .2 + Math.sin(progress * Math.PI) * (flake ? .55 : .32);
      if (flake) {
        context.fillStyle = "#f3f5ef"; context.beginPath(); context.arc(x, y, 1 + random(particle + 143, seed) * 1.25, 0, Math.PI * 2); context.fill();
      } else {
        context.strokeStyle = value.night ? "#b7d6df" : "#668e9e";
        context.beginPath(); context.moveTo(x, y); context.lineTo(x - 2.5, y + 6 + random(particle + 23, seed) * 8); context.stroke();
      }
    }
    context.globalAlpha = 1; context.restore();
    canvas.dataset.weatherCondition = snapshot.condition; canvas.dataset.weatherCell = snapshot.area.key;
    canvas.dataset.weatherTextures = String(textures.size); canvas.dataset.weatherParticles = String(count);
  }
  function reconcile() {
    if (disposed || !visible || !snapshot || ["unknown", "clear"].includes(snapshot.condition)) {
      drawing = false; footprint = null; frame = null; if (canvas) canvas.hidden = true; return;
    }
    const center = map.getCenter(), container = map.getContainer();
    drawing = map.getZoom() >= EARTH_WEATHER_MIN_ZOOM && earthWeatherArea(center.lng, center.lat)?.key === snapshot.area.key;
    footprint = drawing ? earthWeatherFootprint(map, snapshot.area, container.clientWidth, container.clientHeight) : null;
    frame = footprint ? earthWeatherFrame(map, snapshot.area, map.getZoom(), footprint) : null;
    drawing = drawing && !!footprint && !!frame;
    if (!drawing) { if (canvas) canvas.hidden = true; return; }
    ensureCanvas();
    if (canvas) canvas.hidden = !context;
    lastFrame = -1; draw();
  }
  map.on("move", reconcile); map.on("resize", reconcile);
  return {
    hasMotion() { return !disposed && motionEnabled && drawing && !!context && (footprint?.surface ?? 0) > 256; },
    setMotionEnabled(value: boolean) {
      if (disposed || motionEnabled === value) return;
      motionEnabled = value; lastFrame = -1; draw();
    },
    setPrecipitationScale(value: number) {
      if (disposed || !Number.isFinite(value)) return;
      const next = clamp(value, .5, 1);
      if (precipitationScale === next) return;
      precipitationScale = next; lastFrame = -1; draw();
    },
    setWeather(value: EarthWeatherSnapshot | null) {
      if (disposed || snapshot === value) return;
      snapshot = value;
      const key = value ? `${value.area.key}:${value.condition}:${value.isDay}:${Math.round((value.cloudCoverPercent ?? -1) / 5)}` : "";
      if (key !== materialKey) { materialKey = key; releaseTextures(); }
      reconcile();
    },
    setVisible(value: boolean) {
      if (disposed || visible === value) return;
      visible = value; reconcile();
    },
    update(value: number) {
      if (disposed || !motionEnabled || !Number.isFinite(value) || value < 0) return;
      elapsedMs = value; draw();
    },
    dispose() {
      if (disposed) return;
      disposed = true; drawing = false; map.off("move", reconcile); map.off("resize", reconcile);
      releaseTextures(); if (canvas) { canvas.width = 1; canvas.height = 1; canvas.remove(); }
      canvas = null; context = null; snapshot = null; footprint = null; frame = null;
    },
  };
}
