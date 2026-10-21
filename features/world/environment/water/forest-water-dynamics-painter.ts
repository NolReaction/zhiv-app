import type { FixedWorldScene } from "@/features/world/tiled/types";
import type { ForestWaterDynamics } from "./forest-water-dynamics";
import { clipForestWaterRenderMask, getForestWaterRenderMask, isWaterBoundsVisible } from "./forest-water-render-mask";
import { drawForestWaterLeaf } from "./forest-water-leaf-painter";
import { drawForestWaterTouches } from "./forest-water-touch-painter";

type WaterDynamicsOptions = { dusk: number; reducedMotion?: boolean };
type Texture = { canvas: HTMLCanvasElement | OffscreenCanvas;
  context: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
  pixels: ImageData; phases: Float64Array; revision: number; dusk: number };
const textures = new WeakMap<ForestWaterDynamics, Texture>();
const clamp = (value: number, low: number, high: number) => Number.isFinite(value) ? Math.max(low, Math.min(high, value)) : low;

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
  // Grid coordinates are immutable for this solver's lifetime. Keep their two
  // spatial phases at full JS precision; only the live clock and normals change
  // during a paint. This remains bounded by two doubles per active grid cell.
  const phases = new Float64Array(state.active.length * 2);
  for (let cell = 0; cell < state.active.length; cell++) {
    const index = state.active[cell];
    const x = state.origin.x + (index % state.columns + .5) * state.cellSize;
    const y = state.origin.y + (Math.floor(index / state.columns) + .5) * state.cellSize;
    phases[cell * 2] = (x * .047 + y * .094) / state.scale;
    phases[cell * 2 + 1] = (x * .081 - y * .037) / state.scale;
  }
  const texture = { canvas, context, pixels: context.createImageData(state.columns, state.rows), phases, revision: -1, dusk: -1 };
  textures.set(state, texture); return texture;
}

/** Shade simulated normals, not the map image. A pair of translucent crest/trough
 * colours adds depth while the original river, bridge and plants stay still.
 * The only pixel work is on the bounded simulation grid: no canvas readback. */
function surfaceTexture(state: ForestWaterDynamics, dusk: number) {
  const texture = textures.get(state) ?? createTexture(state); if (!texture) return undefined;
  if (texture.revision === state.revision && texture.dusk === dusk) return texture.canvas;
  const { data } = texture.pixels, { phases } = texture, { heights, neighbours, active } = state;
  const light = [Math.round(233 - dusk * 71), Math.round(244 - dusk * 42), Math.round(214 + dusk * 18)];
  const dark = [15, Math.round(92 - dusk * 47), Math.round(113 - dusk * 36)];
  for (let cell = 0; cell < active.length; cell++) {
    const index = active[cell];
    const offset = index * 4, edge = index * 4;
    const slopeX = (heights[neighbours[edge + 1]] - heights[neighbours[edge]]) * .5;
    const slopeY = (heights[neighbours[edge + 3]] - heights[neighbours[edge + 2]]) * .5;
    const along = phases[cell * 2] - state.elapsed * .63;
    const across = phases[cell * 2 + 1] + state.elapsed * .22;
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

/** Drawing never advances the shared solver. Exact vector clipping is deliberately
 * applied after texture upscaling, so even sub-grid WaterExclusions remain dry.
 * The compiled wet boundary subtracts the UNION of exclusions; unsupported
 * geometry retains separate complement clips so overlapping holes stay dry. */
export function drawForestWaterDynamics(ctx: CanvasRenderingContext2D, scene: FixedWorldScene,
  state: ForestWaterDynamics | null | undefined, options: WaterDynamicsOptions) {
  if (!state || options.reducedMotion || !state.active.length) return;
  const box = { ...state.origin, width: state.columns * state.cellSize, height: state.rows * state.cellSize };
  if (!isWaterBoundsVisible(ctx, box)) return;
  const mask = getForestWaterRenderMask(scene); if (!mask || !isWaterBoundsVisible(ctx, mask.bounds)) return;
  const dusk = Math.round(clamp(options.dusk, 0, 1) * 64) / 64;
  const texture = surfaceTexture(state, dusk); if (!texture) return;
  ctx.save(); clipForestWaterRenderMask(ctx, mask);
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(texture, box.x, box.y, box.width, box.height);
  drawForestWaterTouches(ctx, state, dusk);
  for (const leaf of state.leaves) if (leaf.opacity > .001 && isWaterBoundsVisible(ctx, {
    x: leaf.x - leaf.size * 1.4, y: leaf.y - leaf.size * 1.4 - Math.abs(leaf.bob), width: leaf.size * 2.8, height: leaf.size * 2.8 + Math.abs(leaf.bob),
  })) drawForestWaterLeaf(ctx, leaf, dusk);
  ctx.restore();
}
