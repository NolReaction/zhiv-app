import type { FixedWorldScene, WorldBounds, WorldPoint } from "@/features/world/tiled/types";
import type { ForestWaterDynamics } from "./forest-water-dynamics";

type WaterDynamicsOptions = { dusk: number; reducedMotion?: boolean };
type Texture = { canvas: HTMLCanvasElement | OffscreenCanvas;
  context: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
  pixels: ImageData; revision: number; dusk: number };
type Mask = { water: Path2D; exclusions: Array<{ outside: Path2D; bounds: WorldBounds }>; bounds: WorldBounds };

const textures = new WeakMap<ForestWaterDynamics, Texture>();
const masks = new WeakMap<FixedWorldScene, Mask>();
const clamp = (value: number, low: number, high: number) => Number.isFinite(value) ? Math.max(low, Math.min(high, value)) : low;

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

function waterMask(scene: FixedWorldScene): Mask | undefined {
  const previous = masks.get(scene); if (previous) return previous;
  if (typeof Path2D === "undefined" || !scene.water?.surfaces.length) return undefined;
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
  const result = { water, exclusions, bounds: area }; masks.set(scene, result); return result;
}

function visible(ctx: CanvasRenderingContext2D, box: WorldBounds) {
  const transform = ctx.getTransform?.();
  if (!transform || transform.b || transform.c) return true;
  const x1 = box.x * transform.a + transform.e, x2 = (box.x + box.width) * transform.a + transform.e;
  const y1 = box.y * transform.d + transform.f, y2 = (box.y + box.height) * transform.d + transform.f;
  return Math.max(x1, x2) >= 0 && Math.min(x1, x2) <= ctx.canvas.width
    && Math.max(y1, y2) >= 0 && Math.min(y1, y2) <= ctx.canvas.height;
}

function createTexture(state: ForestWaterDynamics): Texture | undefined {
  // Allocation occurs only on the first visible draw, never during module import
  // or server rendering. One small grid texture serves both world cameras.
  let canvas: HTMLCanvasElement | OffscreenCanvas;
  if (typeof OffscreenCanvas !== "undefined") canvas = new OffscreenCanvas(state.columns, state.rows);
  else if (typeof document !== "undefined") {
    canvas = document.createElement("canvas"); canvas.width = state.columns; canvas.height = state.rows;
  } else return undefined;
  const context = canvas.getContext("2d") as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
  if (!context?.createImageData || !context.putImageData) return undefined;
  const texture = { canvas, context, pixels: context.createImageData(state.columns, state.rows), revision: -1, dusk: -1 };
  textures.set(state, texture); return texture;
}

/** Shade simulated normals, not the map image. A pair of translucent crest/trough
 * colours adds depth while the original river, bridge and plants stay still.
 * The only pixel work is on the bounded simulation grid: no canvas readback. */
function surfaceTexture(state: ForestWaterDynamics, dusk: number) {
  const texture = textures.get(state) ?? createTexture(state); if (!texture) return undefined;
  if (texture.revision === state.revision && texture.dusk === dusk) return texture.canvas;
  const { data } = texture.pixels, { heights, neighbours, columns, cellSize, origin } = state;
  const light = [Math.round(233 - dusk * 71), Math.round(244 - dusk * 42), Math.round(214 + dusk * 18)];
  const dark = [15, Math.round(92 - dusk * 47), Math.round(113 - dusk * 36)];
  for (const index of state.active) {
    const offset = index * 4, edge = index * 4;
    const slopeX = (heights[neighbours[edge + 1]] - heights[neighbours[edge]]) * .5;
    const slopeY = (heights[neighbours[edge + 3]] - heights[neighbours[edge + 2]]) * .5;
    const x = origin.x + (index % columns + .5) * cellSize;
    const y = origin.y + (Math.floor(index / columns) + .5) * cellSize;
    const along = (x * .047 + y * .094) / state.scale - state.elapsed * .63;
    const across = (x * .081 - y * .037) / state.scale + state.elapsed * .22;
    const shimmer = Math.sin(along) * Math.sin(across) * .008;
    const normal = slopeX * .55 - slopeY * .95;
    const reflection = normal * .52 + shimmer;
    const colour = reflection >= 0 ? light : dark;
    data[offset] = colour[0]; data[offset + 1] = colour[1]; data[offset + 2] = colour[2];
    data[offset + 3] = Math.round(Math.min(.3, Math.abs(reflection)) * 255 * (1 - dusk * .38));
  }
  texture.context.putImageData(texture.pixels, 0, 0);
  texture.revision = state.revision; texture.dusk = dusk; return texture.canvas;
}

function drawLeaf(ctx: CanvasRenderingContext2D, leaf: ForestWaterDynamics["leaves"][number], dusk: number) {
  const size = leaf.size;
  ctx.save(); ctx.translate(leaf.x, leaf.y); ctx.rotate(leaf.rotation);
  ctx.globalAlpha *= leaf.opacity * (1 - dusk * .32);
  ctx.fillStyle = "#244e48";
  ctx.beginPath(); ctx.ellipse(.15 * size, .24 * size, size * .94, size * .4, 0, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = leaf.id % 3 === 0 ? "#b3ac61" : leaf.id % 3 === 1 ? "#9fb768" : "#b1a56f";
  ctx.beginPath(); ctx.moveTo(-size, 0);
  ctx.quadraticCurveTo(-size * .16, -size * .79, size, 0);
  ctx.quadraticCurveTo(size * .06, size * .62, -size, 0); ctx.fill();
  ctx.strokeStyle = "#637943"; ctx.lineWidth = size * .13; ctx.lineCap = "round";
  ctx.beginPath(); ctx.moveTo(-size * .68, .02 * size); ctx.lineTo(size * .66, -.02 * size); ctx.stroke();
  ctx.restore();
}

/** Drawing never advances the shared solver. Exact vector clipping is deliberately
 * applied after texture upscaling, so even sub-grid WaterExclusions remain dry.
 * Separate outside clips subtract the UNION of exclusions; one evenodd compound
 * path would wrongly paint their overlaps back in. */
export function drawForestWaterDynamics(ctx: CanvasRenderingContext2D, scene: FixedWorldScene,
  state: ForestWaterDynamics | null | undefined, options: WaterDynamicsOptions) {
  if (!state || options.reducedMotion || !state.active.length) return;
  const box = { ...state.origin, width: state.columns * state.cellSize, height: state.rows * state.cellSize };
  if (!visible(ctx, box)) return;
  const mask = waterMask(scene); if (!mask || !visible(ctx, mask.bounds)) return;
  const dusk = Math.round(clamp(options.dusk, 0, 1) * 64) / 64;
  const texture = surfaceTexture(state, dusk); if (!texture) return;
  ctx.save(); ctx.clip(mask.water, "nonzero");
  for (const exclusion of mask.exclusions) if (visible(ctx, exclusion.bounds)) ctx.clip(exclusion.outside, "evenodd");
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(texture, box.x, box.y, box.width, box.height);
  for (const leaf of state.leaves) if (leaf.opacity > .001 && visible(ctx, {
    x: leaf.x - leaf.size * 1.2, y: leaf.y - leaf.size * 1.2, width: leaf.size * 2.4, height: leaf.size * 2.4,
  })) drawLeaf(ctx, leaf, dusk);
  ctx.restore();
}
