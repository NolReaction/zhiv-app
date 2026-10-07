import type { WorldBounds } from "./tiled/types";

/** Conservative world-space viewport. Camera movement changes only this small
 * rectangle; immutable terrain and building artwork remain in their own caches. */
export function canvasWorldViewport(ctx: CanvasRenderingContext2D): WorldBounds | null {
  const t = ctx.getTransform?.(), canvas = ctx.canvas;
  if (!t || !canvas) return null;
  const determinant = t.a * t.d - t.b * t.c;
  if (!Number.isFinite(determinant) || Math.abs(determinant) < 1e-12
    || ![t.e, t.f, canvas.width, canvas.height].every(Number.isFinite)) return null;
  const points = [[0, 0], [canvas.width, 0], [0, canvas.height], [canvas.width, canvas.height]].map(([x, y]) => ({
    x: (t.d * (x - t.e) - t.c * (y - t.f)) / determinant,
    y: (-t.b * (x - t.e) + t.a * (y - t.f)) / determinant,
  }));
  const x = Math.min(...points.map(point => point.x)), y = Math.min(...points.map(point => point.y));
  return { x, y, width: Math.max(...points.map(point => point.x)) - x,
    height: Math.max(...points.map(point => point.y)) - y };
}

/** Bounds already include Tiled's image rotation. Padding retains soft shadows
 * when an object's artwork has just moved outside the screen. */
export function boundsInCanvas(view: WorldBounds | null, bounds: WorldBounds, padding = 0) {
  return !view || bounds.x - padding <= view.x + view.width && bounds.x + bounds.width + padding >= view.x
    && bounds.y - padding <= view.y + view.height && bounds.y + bounds.height + padding >= view.y;
}
