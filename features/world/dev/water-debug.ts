import type { FixedWorldScene, WorldWater, WorldWaterPolygon } from "../tiled/types";

type WaterPaths = { surfaces: Path2D; exclusions: Path2D };
const paths = new WeakMap<WorldWater, WaterPaths>();

function trace(target: CanvasRenderingContext2D | Path2D, polygons: WorldWaterPolygon[]) {
  for (const { points } of polygons) {
    if (points.length < 3) continue;
    target.moveTo(points[0].x, points[0].y);
    for (let index = 1; index < points.length; index++) target.lineTo(points[index].x, points[index].y);
    target.closePath();
  }
}

function cachedPaths(water: WorldWater): WaterPaths | undefined {
  if (typeof Path2D === "undefined") return undefined;
  let cached = paths.get(water);
  if (!cached) {
    cached = { surfaces: new Path2D(), exclusions: new Path2D() };
    trace(cached.surfaces, water.surfaces);
    trace(cached.exclusions, water.exclusions);
    paths.set(water, cached);
  }
  return cached;
}

/** DEV-only outline of the original Tiled polygons, independent of rain masks. */
export function drawWaterDebug(ctx: CanvasRenderingContext2D, scene: FixedWorldScene) {
  const water = scene.water;
  if (!water || (!water.surfaces.length && !water.exclusions.length)) return;
  const cached = cachedPaths(water);
  const transform = ctx.getTransform?.();
  const unit = 1 / Math.max(.25, transform ? Math.hypot(transform.a, transform.b) : 1);
  ctx.save();
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = "source-over";
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  for (const [key, color, dashed] of [["surfaces", "#58e5ff", false], ["exclusions", "#ff997e", true]] as const) {
    if (!water[key].length) continue;
    const path = cached?.[key];
    if (!path) { ctx.beginPath(); trace(ctx, water[key]); }
    ctx.setLineDash(dashed ? [5 * unit, 3 * unit] : []);
    ctx.strokeStyle = "rgba(7, 20, 20, .8)";
    ctx.lineWidth = 3.5 * unit;
    if (path) ctx.stroke(path); else ctx.stroke();
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5 * unit;
    if (path) ctx.stroke(path); else ctx.stroke();
  }
  ctx.restore();
}
