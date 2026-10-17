import type { FixedWorldScene, WorldBounds, WorldImage } from "@/features/world/tiled/types";
import type { ForestWaterDynamics } from "./forest-water-dynamics";
import { sampleForestWater } from "./forest-water-dynamics";
import { dynamicsFootprintFits, type WaterDynamicsGeometry } from "./water-dynamics-geometry";
import { clipForestWaterRenderMask, createForestWaterBoundsVisibility, getForestWaterRenderMask } from "./forest-water-render-mask";

type Patch = WorldBounds & { centerX: number; centerY: number };
const patches = new WeakMap<WaterDynamicsGeometry, Patch[]>();

function waterPatches(state: ForestWaterDynamics) {
  const previous = patches.get(state.geometry); if (previous) return previous;
  // At most 48×48 patches even on future maps; only fully wet interiors survive.
  // This also fences the shifted source footprint, so rocks cannot leak into water.
  const stride = Math.max(4, Math.ceil(Math.max(state.columns, state.rows) / 48));
  const size = state.cellSize * stride, radius = size * Math.SQRT1_2 + 1.5 * state.scale;
  const result: Patch[] = [];
  for (let row = 0; row < state.rows; row += stride) for (let column = 0; column < state.columns; column += stride) {
    const x = state.origin.x + column * state.cellSize, y = state.origin.y + row * state.cellSize;
    const centerX = x + size / 2, centerY = y + size / 2;
    if (dynamicsFootprintFits(state.geometry, { x: centerX, y: centerY }, radius)) {
      result.push({ x, y, width: size, height: size, centerX, centerY });
    }
  }
  patches.set(state.geometry, result); return result;
}

/** A bounded set of tiny source offsets bends the existing water drawing. Called
 * directly after the backdrop, before terrain cutouts and buildings. No canvas
 * readback, full-map copies or simulation writes; both cameras share geometry. */
export function drawForestWaterRefraction(ctx: CanvasRenderingContext2D, scene: FixedWorldScene,
  state: ForestWaterDynamics | undefined, image: HTMLImageElement | HTMLCanvasElement, terrain: WorldImage,
  options: { reducedMotion?: boolean }) {
  const imageWidth = "naturalWidth" in image ? image.naturalWidth : image.width;
  const imageHeight = "naturalHeight" in image ? image.naturalHeight : image.height;
  if (!state?.active.length || options.reducedMotion || !imageWidth || !imageHeight
    || terrain.imagePlacement && terrain.imagePlacement.rotation % 360 !== 0) return;
  const mask = getForestWaterRenderMask(scene); if (!mask) return;
  const visible = createForestWaterBoundsVisibility(ctx); if (!visible(mask.bounds)) return;
  const source = terrain.imagePlacement ?? terrain.bounds;
  if (source.width <= 0 || source.height <= 0) return;
  const sx = imageWidth / source.width, sy = imageHeight / source.height;
  ctx.save(); clipForestWaterRenderMask(ctx, mask, visible);
  ctx.imageSmoothingEnabled = true; ctx.globalAlpha *= .72;
  for (const patch of waterPatches(state)) {
    if (!visible(patch)) continue;
    const x = patch.centerX / state.scale, y = patch.centerY / state.scale;
    const wave = sampleForestWater(state, { x: patch.centerX, y: patch.centerY });
    const dx = Math.max(-1.2, Math.min(1.2, Math.sin(x * .026 + y * .035 - state.elapsed * .72) * .42
      + wave.slopeX * state.scale * 8)) * state.scale;
    const dy = Math.max(-.7, Math.min(.7, Math.sin(x * .041 - y * .021 + state.elapsed * .48) * .22
      + wave.slopeY * state.scale * 5)) * state.scale;
    const sampleX = patch.x + dx - source.x, sampleY = patch.y + dy - source.y;
    if (sampleX < 0 || sampleY < 0 || sampleX + patch.width > source.width || sampleY + patch.height > source.height) continue;
    ctx.drawImage(image, sampleX * sx, sampleY * sy, patch.width * sx, patch.height * sy,
      patch.x, patch.y, patch.width, patch.height);
  }
  ctx.restore();
}
