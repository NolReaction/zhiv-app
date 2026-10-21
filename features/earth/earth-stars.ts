import type { Map as LibreMap } from "maplibre-gl";
import type { EarthLightingMode } from "./globe-lighting";
import styles from "./earth-stars.module.css";

type StarMap = Pick<LibreMap, "on" | "off" | "getCanvas" | "project" | "unproject">;
type ScreenPoint = { x: number; y: number };
type Star = ScreenPoint & { radius: number; opacity: number; warm: boolean };
export const EARTH_STAR_COUNT = 128;
export const EARTH_STAR_MAX_PIXELS = 2 * 1024 * 1024;
const HORIZON_CLEARANCE = 10;

/** A fixed original sky, not an astronomical catalogue or a random per-frame pattern. */
export function earthStarPoints(): readonly Star[] {
  let seed = 0x7a41d9;
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4_294_967_296; };
  return Array.from({ length: EARTH_STAR_COUNT }, (_, index) => ({
    x: random(), y: random(), radius: index % 19 === 0 ? 1.35 : 0.45 + random() * 0.45,
    opacity: 0.3 + random() * 0.6, warm: index % 11 === 0,
  }));
}

/** Globe unprojection snaps outer pixels to the horizon; the public round trip reveals space. */
export function isEarthStarInSpace(map: Pick<StarMap, "project" | "unproject">, point: ScreenPoint, radius = 0): boolean {
  try {
    const location = map.unproject([point.x, point.y]);
    // Mercator returns no intersection above its pitched horizon. Passing that
    // to project throws, after clearRect had already erased the whole starfield.
    if (!location) return true;
    const projected = map.project(location);
    return Number.isFinite(projected.x) && Number.isFinite(projected.y)
      && Math.hypot(projected.x - point.x, projected.y - point.y) > HORIZON_CLEARANCE + radius;
  } catch { return false; }
}

/**
 * Static canvas over the native sky, with each dot clipped using public globe
 * projection. No animation loop, new map source, WebGL context or network data.
 */
export function createEarthStars(map: StarMap, host: HTMLElement, initialMode: EarthLightingMode) {
  const owner = host.ownerDocument;
  const canvas = owner.createElement("canvas");
  canvas.className = styles.field;
  canvas.setAttribute("aria-hidden", "true");
  canvas.dataset.earthStars = "true";
  canvas.hidden = true;
  host.append(canvas);
  const context = canvas.getContext("2d");
  const stars = earthStarPoints();
  let visible = false;
  let disposed = false;
  let mode = initialMode;
  let dirty = false;

  function dimensions() {
    const nativeCanvas = map.getCanvas();
    return { width: nativeCanvas.clientWidth, height: nativeCanvas.clientHeight };
  }
  function draw() {
    if (disposed || !visible || !context) return;
    const { width, height } = dimensions();
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
      canvas.hidden = true;
      return;
    }
    const ratio = Math.min(1.5, Math.max(1, owner.defaultView?.devicePixelRatio ?? 1), Math.sqrt(EARTH_STAR_MAX_PIXELS / (width * height)));
    const pixelWidth = Math.max(1, Math.floor(width * ratio)); const pixelHeight = Math.max(1, Math.floor(height * ratio));
    if (canvas.width !== pixelWidth) canvas.width = pixelWidth;
    if (canvas.height !== pixelHeight) canvas.height = pixelHeight;
    context.setTransform(pixelWidth / width, 0, 0, pixelHeight / height, 0, 0);
    context.clearRect(0, 0, width, height);
    // The actual projected horizon clips the sky at every zoom. A zoom cutoff
    // would also remove stars from still-visible space during approach/pitch.
    const intensity = mode === "evening" ? 1 : mode === "day" ? 0.4 : 0.7;
    let painted = false;
    for (const star of stars) {
      const point = { x: star.x * width, y: star.y * height };
      if (!isEarthStarInSpace(map, point, star.radius)) continue;
      painted = true;
      context.globalAlpha = star.opacity * intensity;
      context.fillStyle = star.warm ? "#f9d8b4" : "#d9e8ff";
      context.beginPath(); context.arc(point.x, point.y, star.radius, 0, Math.PI * 2); context.fill();
      if (star.radius > 1) {
        context.globalAlpha = star.opacity * intensity * 0.16;
        context.beginPath(); context.arc(point.x, point.y, star.radius * 3, 0, Math.PI * 2); context.fill();
      }
    }
    context.globalAlpha = 1;
    canvas.hidden = !painted;
    dirty = false;
  }
  function onMove() {
    if (!disposed && visible) dirty = true;
  }
  // Projection interpolation is finalized by MapLibre during render, after its
  // camera move event. Clip against that completed frame, without a separate RAF.
  function onRender() { if (dirty) draw(); }
  map.on("move", onMove);
  map.on("moveend", onMove);
  map.on("resize", onMove);
  map.on("render", onRender);
  return {
    setVisible(next: boolean) {
      if (disposed || next === visible) return;
      visible = next;
      if (visible) draw(); else { canvas.hidden = true; dirty = false; }
    },
    setMode(next: EarthLightingMode) { if (!disposed && next !== mode) { mode = next; draw(); } },
    dispose() {
      if (disposed) return;
      disposed = true;
      map.off("move", onMove);
      map.off("moveend", onMove);
      map.off("resize", onMove);
      map.off("render", onRender);
      canvas.remove();
    },
  };
}
