import type { Map as LibreMap } from "maplibre-gl";
import type { EarthLightingMode } from "./globe-lighting";
import styles from "./earth-stars.module.css";

type StarMap = Pick<LibreMap, "on" | "off" | "getCanvas" | "getZoom" | "project" | "unproject">;
type ScreenPoint = { x: number; y: number };
type Star = ScreenPoint & { radius: number; opacity: number; warm: boolean };
export const EARTH_STAR_COUNT = 128;
const DRAW_INTERVAL = 100;
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
  const projected = map.project(map.unproject([point.x, point.y]));
  return Number.isFinite(projected.x) && Number.isFinite(projected.y)
    && Math.hypot(projected.x - point.x, projected.y - point.y) > HORIZON_CLEARANCE + radius;
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
  let lastDraw = -Infinity;
  let lastOutline: number[] = [];
  let outlineChangedDuringMove = false;
  const now = () => owner.defaultView?.performance.now() ?? performance.now();

  function dimensions() {
    const nativeCanvas = map.getCanvas();
    return { width: nativeCanvas.clientWidth, height: nativeCanvas.clientHeight };
  }
  function outline(width: number, height: number) {
    return [[0, 0], [width, 0], [width, height], [0, height]].flatMap(point => {
      const projected = map.project(map.unproject(point as [number, number]));
      return [projected.x, projected.y];
    });
  }
  function draw() {
    if (disposed || !visible || !context) return;
    const { width, height } = dimensions();
    const zoom = map.getZoom();
    const fade = Math.max(0, Math.min(1, (2.5 - zoom) / 1));
    if (!Number.isFinite(width) || !Number.isFinite(height) || !Number.isFinite(zoom) || width <= 0 || height <= 0 || fade <= 0) {
      canvas.hidden = true;
      return;
    }
    const ratio = Math.min(1.5, Math.max(1, owner.defaultView?.devicePixelRatio ?? 1));
    const pixelWidth = Math.round(width * ratio); const pixelHeight = Math.round(height * ratio);
    if (canvas.width !== pixelWidth) canvas.width = pixelWidth;
    if (canvas.height !== pixelHeight) canvas.height = pixelHeight;
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.clearRect(0, 0, width, height);
    const intensity = fade * (mode === "evening" ? 1 : mode === "day" ? 0.4 : 0.7);
    for (const star of stars) {
      const point = { x: star.x * width, y: star.y * height };
      if (!isEarthStarInSpace(map, point, star.radius)) continue;
      context.globalAlpha = star.opacity * intensity;
      context.fillStyle = star.warm ? "#f9d8b4" : "#d9e8ff";
      context.beginPath(); context.arc(point.x, point.y, star.radius, 0, Math.PI * 2); context.fill();
      if (star.radius > 1) {
        context.globalAlpha = star.opacity * intensity * 0.16;
        context.beginPath(); context.arc(point.x, point.y, star.radius * 3, 0, Math.PI * 2); context.fill();
      }
    }
    context.globalAlpha = 1;
    lastOutline = outline(width, height);
    lastDraw = now();
    canvas.hidden = false;
  }
  function onMove() {
    if (disposed || !visible || !context || outlineChangedDuringMove) return;
    if (map.getZoom() >= 2.5) { canvas.hidden = true; return; }
    const { width, height } = dimensions();
    const currentOutline = outline(width, height);
    // Rotation usually preserves the silhouette. If zoom/pitch changes it,
    // hide until moveend rather than leave stale stars drawn over new land.
    if (lastOutline.length && currentOutline.some((value, index) => !Number.isFinite(value) || Math.abs(value - lastOutline[index]) > 2)) {
      outlineChangedDuringMove = true;
      canvas.hidden = true;
      return;
    }
    if (now() - lastDraw >= DRAW_INTERVAL) draw();
  }
  function onMoveEnd() { outlineChangedDuringMove = false; draw(); }
  map.on("move", onMove);
  map.on("moveend", onMoveEnd);
  map.on("resize", onMoveEnd);
  return {
    setVisible(next: boolean) {
      if (disposed || next === visible) return;
      visible = next;
      outlineChangedDuringMove = false;
      if (visible) draw(); else canvas.hidden = true;
    },
    setMode(next: EarthLightingMode) { if (!disposed && next !== mode) { mode = next; draw(); } },
    dispose() {
      if (disposed) return;
      disposed = true;
      map.off("move", onMove);
      map.off("moveend", onMoveEnd);
      map.off("resize", onMoveEnd);
      canvas.remove();
    },
  };
}
