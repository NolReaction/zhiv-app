import type { WorldBounds } from "@/features/world/tiled/types";

/** Conservative world-space viewport. Camera movement changes only this small
 * rectangle; immutable terrain and building artwork remain in their own caches. */
export function canvasWorldViewport(ctx: CanvasRenderingContext2D): WorldBounds | null {
  const t = ctx.getTransform?.(), canvas = ctx.canvas;
  if (!t || !canvas) return null;
  const determinant = t.a * t.d - t.b * t.c;
  if (!Number.isFinite(determinant) || Math.abs(determinant) < 1e-12
    || !Number.isFinite(t.e) || !Number.isFinite(t.f)
    || !Number.isFinite(canvas.width) || !Number.isFinite(canvas.height)) return null;
  // An inverse affine rectangle is a parallelogram. Its two edge vectors give
  // the same conservative envelope as four inverse points, without temporary
  // arrays/points in every world paint (including high-rate camera gestures).
  const originX = (t.c * t.f - t.d * t.e) / determinant;
  const originY = (t.b * t.e - t.a * t.f) / determinant;
  const horizontalX = t.d * canvas.width / determinant, horizontalY = -t.b * canvas.width / determinant;
  const verticalX = -t.c * canvas.height / determinant, verticalY = t.a * canvas.height / determinant;
  const x = originX + Math.min(0, horizontalX) + Math.min(0, verticalX);
  const y = originY + Math.min(0, horizontalY) + Math.min(0, verticalY);
  const width = Math.abs(horizontalX) + Math.abs(verticalX), height = Math.abs(horizontalY) + Math.abs(verticalY);
  return Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(width) && Number.isFinite(height)
    ? { x, y, width, height } : null;
}

/** Bounds already include Tiled's image rotation. Padding retains soft shadows
 * when an object's artwork has just moved outside the screen. */
export function boundsInCanvas(view: WorldBounds | null, bounds: WorldBounds, padding = 0) {
  return !view || bounds.x - padding <= view.x + view.width && bounds.x + bounds.width + padding >= view.x
    && bounds.y - padding <= view.y + view.height && bounds.y + bounds.height + padding >= view.y;
}
