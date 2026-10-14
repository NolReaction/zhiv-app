import { type TerrainDefinition } from "./layout.ts";
import { CELL_SIZE, TERRAIN_DIRTY_HALO, readTerrainMaterial, terrainAppearance, type TerrainMaterial, type TerrainPreview, type TerrainState } from "./terrain-data.ts";
import { createWaterContourCache, type WaterContour } from "./contours.ts";
import type { Bounds, SceneSize } from "../scene/contracts.ts";
export type TerrainPainter = {
  drawBase: (ctx: CanvasRenderingContext2D, seed: number, bounds: Bounds, baseTrails: boolean) => void;
  drawMaterial: (ctx: CanvasRenderingContext2D, seed: number, bounds: Bounds, material: TerrainMaterial, baseTrails: boolean) => void;
  drawWater?: (ctx: CanvasRenderingContext2D, seed: number, bounds: Bounds, contours: readonly WaterContour[], state: TerrainState) => void;
};
const colors = { grass: "#657d50", path: "#b6a381", sand: "#d0bd8a", water: "#398fa3" };
export const SOLID_TERRAIN_PAINTER: TerrainPainter = {
  drawBase(ctx, _seed, bounds) { ctx.fillStyle = colors.grass; ctx.fillRect(bounds.x, bounds.y, bounds.width, bounds.height); },
  drawMaterial(ctx, _seed, bounds, material) { ctx.fillStyle = colors[material]; ctx.fillRect(bounds.x, bounds.y, bounds.width, bounds.height); },
  drawWater(ctx, _seed, _bounds, contours) { ctx.beginPath(); for (const contour of contours) { contour.points.forEach(([x, y], i) => { if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y); }); ctx.closePath(); } ctx.fillStyle = colors.water; ctx.fill("evenodd"); },
};
type CanvasFactory = (width: number, height: number) => HTMLCanvasElement;
const MASK_STEP = 4;

/** World-addressed soft masks and one connected water field serve every chunk. */
export function createTerrainComposer(makeCanvas: CanvasFactory, definition: TerrainDefinition, painter: TerrainPainter, extent: SceneSize) {
  const coast = createWaterContourCache(extent, definition.sampleWaterSignedDistance);
  let mask: HTMLCanvasElement | undefined, scratch: HTMLCanvasElement | undefined;
  function compose(base: HTMLCanvasElement, bounds: Bounds, state: TerrainState, preview: TerrainPreview | undefined,
    materialTile: (material: TerrainMaterial) => HTMLCanvasElement, reuse?: HTMLCanvasElement, seed = 0, width = extent.width): HTMLCanvasElement {
    if (!Number.isFinite(width) || width <= 0 || width > extent.width) throw new Error("Неверная ширина карты.");
    const target = reuse && reuse !== base ? reuse : makeCanvas(base.width, base.height), targetCtx = target.getContext("2d");
    if (!targetCtx) throw new Error("Не удалось подготовить землю.");
    const contours = coast.read(state, preview), appearance = terrainAppearance(state);
    targetCtx.save(); targetCtx.setTransform(1, 0, 0, 1, 0, 0); targetCtx.globalCompositeOperation = "source-over";
    targetCtx.clearRect(0, 0, base.width, base.height); targetCtx.drawImage(base, 0, 0);
    const minX = Math.floor((bounds.x - TERRAIN_DIRTY_HALO) / CELL_SIZE), minY = Math.floor((bounds.y - TERRAIN_DIRTY_HALO) / CELL_SIZE);
    const maxX = Math.ceil((bounds.x + bounds.width + TERRAIN_DIRTY_HALO) / CELL_SIZE), maxY = Math.ceil((bounds.y + bounds.height + TERRAIN_DIRTY_HALO) / CELL_SIZE);
    const columns = maxX - minX + 1, rows = maxY - minY + 1, cells = new Uint8Array(columns * rows), groups = new Set<number>();
    const materialNames: TerrainMaterial[] = ["grass", "path", "sand"];
    for (let y = minY; y <= maxY; y++) for (let x = minX; x <= maxX; x++) {
      const material = readTerrainMaterial((x + .5) * CELL_SIZE, (y + .5) * CELL_SIZE, state, preview);
      const index = material ? materialNames.indexOf(material) + 1 : 0;
      cells[(y - minY) * columns + x - minX] = index; if (index) groups.add(index);
    }
    if (groups.size) {
      const ox = Math.floor((bounds.x - TERRAIN_DIRTY_HALO) / MASK_STEP) * MASK_STEP, oy = Math.floor((bounds.y - TERRAIN_DIRTY_HALO) / MASK_STEP) * MASK_STEP;
      const width = Math.ceil((bounds.x + bounds.width + TERRAIN_DIRTY_HALO - ox) / MASK_STEP), height = Math.ceil((bounds.y + bounds.height + TERRAIN_DIRTY_HALO - oy) / MASK_STEP);
      if (!mask || mask.width !== width || mask.height !== height) mask = makeCanvas(width, height);
      if (!scratch || scratch.width !== base.width || scratch.height !== base.height) scratch = makeCanvas(base.width, base.height);
      const maskCtx = mask.getContext("2d"), scratchCtx = scratch.getContext("2d");
      if (!maskCtx || !scratchCtx) throw new Error("Не удалось подготовить кисть местности.");
      const alphas = new Map<number, Uint8ClampedArray>([...groups].map(group => [group, new Uint8ClampedArray(width * height)]));
      const total = new Uint8ClampedArray(width * height);
      const weights = [0, 0, 0, 0], groupList = [...groups];
      for (let py = 0; py < height; py++) for (let px = 0; px < width; px++) {
        const x = ox + (px + .5) * MASK_STEP, y = oy + (py + .5) * MASK_STEP;
        const gx = x / CELL_SIZE - .5, gy = y / CELL_SIZE - .5, ix = Math.floor(gx), iy = Math.floor(gy), fx = gx - ix, fy = gy - iy;
        weights.fill(0);
        const index = (iy - minY) * columns + ix - minX;
        weights[cells[index] ?? 0] += (1 - fx) * (1 - fy);
        weights[cells[index + 1] ?? 0] += fx * (1 - fy);
        weights[cells[index + columns] ?? 0] += (1 - fx) * fy;
        weights[cells[index + columns + 1] ?? 0] += fx * fy;
        if (appearance.blendWidth < 16) {
          let normalizer = 0;
          for (let i = 0; i < weights.length; i++) { weights[i] **= 16 / appearance.blendWidth; normalizer += weights[i]; }
          for (let i = 0; i < weights.length; i++) weights[i] /= normalizer || 1;
        }
        let sum = 0;
        for (const group of groups) {
          const w = weights[group], variation = w > 0 && w < 1 && appearance.scatter
            ? (Math.sin(x * .117 + y * .071 + seed) + Math.sin(x * .047 - y * .139 + seed * .5)) * .5 : 0;
          weights[group] = Math.max(0, Math.min(1, w + variation * appearance.scatter * w * (1 - w) * .8)); sum += weights[group];
        }
        for (const group of groups) alphas.get(group)![py * width + px] = Math.round(weights[group] / Math.max(1, sum) * 255);
        total[py * width + px] = Math.min(255, groupList.reduce((sum, group) => sum + alphas.get(group)![py * width + px], 0));
      }
      const writeMask = (alpha: Uint8ClampedArray) => {
        maskCtx!.clearRect(0, 0, width, height);
        if (typeof maskCtx!.createImageData === "function" && typeof maskCtx!.putImageData === "function") {
          const pixels = maskCtx!.createImageData(width, height);
          for (let i = 0; i < alpha.length; i++) { pixels.data[i * 4] = 255; pixels.data[i * 4 + 1] = 255; pixels.data[i * 4 + 2] = 255; pixels.data[i * 4 + 3] = alpha[i]; }
          maskCtx!.putImageData(pixels, 0, 0);
        } else for (let i = 0; i < alpha.length; i++) if (alpha[i]) { maskCtx!.fillStyle = `rgba(255,255,255,${alpha[i] / 255})`; maskCtx!.fillRect(i % width, Math.floor(i / width), 1, 1); }
      };
      const drawMask = (ctx: CanvasRenderingContext2D) => {
        ctx.save(); ctx.imageSmoothingEnabled = true; ctx.filter = `blur(${Math.max(0, (appearance.blendWidth - 16) / 3)}px)`;
        ctx.drawImage(mask!, ox - bounds.x, oy - bounds.y, width * MASK_STEP, height * MASK_STEP); ctx.restore();
      };
      writeMask(total); targetCtx.globalCompositeOperation = "destination-out"; drawMask(targetCtx);
      for (const group of groups) {
        writeMask(alphas.get(group)!); scratchCtx.save(); scratchCtx.setTransform(1, 0, 0, 1, 0, 0); scratchCtx.globalCompositeOperation = "source-over";
        scratchCtx.clearRect(0, 0, base.width, base.height); scratchCtx.drawImage(materialTile(materialNames[group - 1]), 0, 0);
        scratchCtx.globalCompositeOperation = "destination-in"; drawMask(scratchCtx); scratchCtx.restore();
        targetCtx.globalCompositeOperation = "lighter"; targetCtx.drawImage(scratch, 0, 0);
      }
    }
    targetCtx.globalCompositeOperation = "source-over"; targetCtx.translate(-bounds.x, -bounds.y);
    painter.drawWater?.(targetCtx, seed, bounds, contours, state); targetCtx.restore(); return target;
  }
  return { compose, diagnostics: coast.diagnostics, dispose() { mask = undefined; scratch = undefined; coast.dispose(); } };
}
