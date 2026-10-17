import type { FixedWorldScene, WorldBounds, WorldPoint } from "@/features/world/tiled/types";

export type ForestWaterRenderMask = { water: Path2D; exclusions: Array<{ outside: Path2D; bounds: WorldBounds }>; bounds: WorldBounds };

const masks = new WeakMap<NonNullable<FixedWorldScene["water"]>, ForestWaterRenderMask>();

function bounds(points: WorldPoint[]): WorldBounds {
  let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
  for (const point of points) {
    left = Math.min(left, point.x); top = Math.min(top, point.y);
    right = Math.max(right, point.x); bottom = Math.max(bottom, point.y);
  }
  return { x: left, y: top, width: right - left, height: bottom - top };
}

/** Give every Water polygon the same winding. Nonzero clipping then takes their
 * union, including overlaps, independently of how a polygon was drawn in Tiled. */
function appendPolygon(path: Path2D, points: WorldPoint[]) {
  let area = 0;
  for (let index = 0; index < points.length; index++) {
    const a = points[index], b = points[(index + 1) % points.length];
    area += a.x * b.y - b.x * a.y;
  }
  for (let index = 0; index < points.length; index++) {
    const point = points[area < 0 ? points.length - index - 1 : index];
    if (index) path.lineTo(point.x, point.y); else path.moveTo(point.x, point.y);
  }
  path.closePath();
}

export function getForestWaterRenderMask(scene: FixedWorldScene): ForestWaterRenderMask | undefined {
  if (typeof Path2D === "undefined" || !scene.water?.surfaces.length) return undefined;
  const previous = masks.get(scene.water); if (previous) return previous;
  const surfaces = scene.water.surfaces.filter(polygon => polygon.points.length >= 3);
  if (!surfaces.length) return undefined;
  const area = bounds(surfaces.flatMap(polygon => polygon.points)), water = new Path2D();
  for (const polygon of surfaces) appendPolygon(water, polygon.points);
  const exclusions = scene.water.exclusions.filter(polygon => polygon.points.length >= 3).map(polygon => {
    const outside = new Path2D();
    outside.rect(area.x - 1, area.y - 1, area.width + 2, area.height + 2);
    appendPolygon(outside, polygon.points);
    return { outside, bounds: bounds(polygon.points) };
  });
  const result = { water, exclusions, bounds: area }; masks.set(scene.water, result); return result;
}

type AxisTransform = Pick<DOMMatrix, "a" | "d" | "e" | "f">;
function axisBoundsVisible(box: WorldBounds, transform: AxisTransform, width: number, height: number) {
  const x1 = box.x * transform.a + transform.e, x2 = (box.x + box.width) * transform.a + transform.e;
  const y1 = box.y * transform.d + transform.f, y2 = (box.y + box.height) * transform.d + transform.f;
  return Math.max(x1, x2) >= 0 && Math.min(x1, x2) <= width
    && Math.max(y1, y2) >= 0 && Math.min(y1, y2) <= height;
}

export function isWaterBoundsVisible(ctx: CanvasRenderingContext2D, box: WorldBounds) {
  const transform = ctx.getTransform?.();
  return !transform || transform.b || transform.c ? true : axisBoundsVisible(box, transform, ctx.canvas.width, ctx.canvas.height);
}

/** Snapshot only for a single unchanged paint transform. Hundreds of tiny
 * refraction patches then share one browser DOMMatrix read, including clips.
 * Never retain this predicate across a camera move or a canvas resize. */
export function createForestWaterBoundsVisibility(ctx: CanvasRenderingContext2D): (box: WorldBounds) => boolean {
  const transform = ctx.getTransform?.();
  if (!transform || transform.b || transform.c) return () => true;
  const { a, d, e, f } = transform, { width, height } = ctx.canvas;
  const snapshot = { a, d, e, f };
  return box => axisBoundsVisible(box, snapshot, width, height);
}

/** Apply the exact Water union and subtract every exclusion. Caller owns save/restore. */
export function clipForestWaterRenderMask(ctx: CanvasRenderingContext2D, mask: ForestWaterRenderMask,
  visible: (box: WorldBounds) => boolean = box => isWaterBoundsVisible(ctx, box)) {
  ctx.clip(mask.water, "nonzero");
  for (const exclusion of mask.exclusions) if (visible(exclusion.bounds)) ctx.clip(exclusion.outside, "evenodd");
}
