type Viewport = { x: number; y: number; width: number; height: number };
type Expansion = { viewport: Viewport; compatible: boolean };
const expansions = new WeakMap<CanvasRenderingContext2D, Expansion>();

/** An expanded pan surface must not change the renderer's bounded soft-mask
 * choice as the normal viewport moves anywhere inside it. The caller discards an incompatible
 * attempt and paints the normal surface before presenting that browser frame. */
export function withExpandedCanvasViewport(ctx: CanvasRenderingContext2D, viewport: Viewport,
  paint: () => void): boolean {
  const previous = expansions.get(ctx);
  const expansion: Expansion = { viewport, compatible:
    [viewport.x, viewport.y, viewport.width, viewport.height].every(Number.isFinite)
    && viewport.x >= 0 && viewport.y >= 0 && viewport.width > 0 && viewport.height > 0
    && viewport.x + viewport.width <= ctx.canvas.width && viewport.y + viewport.height <= ctx.canvas.height };
  expansions.set(ctx, expansion);
  try { paint(); return expansion.compatible; }
  finally {
    if (previous) expansions.set(ctx, previous);
    else expansions.delete(ctx);
  }
}

/** Bounds already include the renderer's integer physical-pixel feather guard.
 * A fitting expanded subject fits every smaller crop. For a hard-clipped subject,
 * even the smallest possible crop must require that same fallback: overlap of
 * two intervals is concave in their offset, so its minimum lies at an endpoint.
 * This also protects subjects entering from the spare border during CSS reuse. */
export function checkExpandedCanvasMask(ctx: CanvasRenderingContext2D,
  left: number, top: number, right: number, bottom: number,
  quantum: number, maxSide: number, maxPixels: number): void {
  const expansion = expansions.get(ctx);
  if (!expansion || !expansion.compatible) return;
  const width = Math.ceil((Math.min(ctx.canvas.width, right) - Math.max(0, left)) / quantum) * quantum;
  const height = Math.ceil((Math.min(ctx.canvas.height, bottom) - Math.max(0, top)) / quantum) * quantum;
  if (width <= 0 || height <= 0) return;
  const fits = (w: number, h: number) => w <= maxSide && h <= maxSide && w * h <= maxPixels;
  if (fits(width, height)) return;
  const minimumOverlap = (start: number, end: number, visible: number, surface: number) => {
    const atStart = Math.min(visible, end) - Math.max(0, start);
    const offset = surface - visible;
    const atEnd = Math.min(surface, end) - Math.max(offset, start);
    return Math.ceil(Math.max(0, Math.min(atStart, atEnd)) / quantum) * quantum;
  };
  const minimumWidth = minimumOverlap(left, right, expansion.viewport.width, ctx.canvas.width);
  const minimumHeight = minimumOverlap(top, bottom, expansion.viewport.height, ctx.canvas.height);
  if (minimumWidth <= 0 || minimumHeight <= 0 || fits(minimumWidth, minimumHeight)) expansion.compatible = false;
}
