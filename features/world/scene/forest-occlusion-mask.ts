import type { WorldPoint } from "@/features/world/tiled/types";

/** A narrow inward fade keeps the authored outer silhouette intact. This is
 * geometry, not animation: both cameras and reduced motion use the same edge. */
export const FOREST_OCCLUSION_FEATHER = 3;
const MASK_BUDGET = 4 * 1024 * 1024;
const MASK_MAX_SIDE = 512;
const STEPS = 12;
export type ForestOcclusionContour = {
  points: WorldPoint[];
  left: number; top: number; right: number; bottom: number;
  texture?: FeatherTexture;
};
type FeatherTexture = {
  canvas: HTMLCanvasElement; x: number; y: number; width: number; height: number;
  bytes: number; owner: ForestOcclusionContour;
};
const recent = new Set<FeatherTexture>();
let retainedBytes = 0;

/** No Canvas filter, pixel readback or background image is needed. Layered
 * round strokes remove progressively more alpha toward the polygon boundary;
 * their multiplicative alpha produces a smoothstep rather than dark bands. */
export function forestOcclusionTexture(mask: ForestOcclusionContour): FeatherTexture | null {
  if (mask.texture) { recent.delete(mask.texture); recent.add(mask.texture); return mask.texture; }
  if (typeof document === "undefined") return null;
  const padding = 1, x = mask.left - padding, y = mask.top - padding;
  const width = mask.right - mask.left + padding * 2, height = mask.bottom - mask.top + padding * 2;
  const scale = Math.min(2, MASK_MAX_SIDE / Math.max(width, height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.ceil(width * scale)); canvas.height = Math.max(1, Math.ceil(height * scale));
  const ctx = canvas.getContext("2d");
  if (!ctx || typeof ctx.setTransform !== "function" || typeof ctx.stroke !== "function") return null;
  ctx.setTransform(scale, 0, 0, scale, -x * scale, -y * scale);
  ctx.fillStyle = ctx.strokeStyle = "#000";
  ctx.beginPath(); ctx.moveTo(mask.points[0].x, mask.points[0].y);
  for (let index = 1; index < mask.points.length; index++) ctx.lineTo(mask.points[index].x, mask.points[index].y);
  ctx.closePath(); ctx.fill();
  ctx.globalCompositeOperation = "destination-out";
  ctx.lineJoin = ctx.lineCap = "round";
  let previous = 1;
  for (let step = STEPS; step >= 1; step--) {
    const distance = (step - .5) / STEPS, alpha = distance * distance * (3 - 2 * distance);
    ctx.globalAlpha = 1 - alpha / previous;
    ctx.lineWidth = FOREST_OCCLUSION_FEATHER * 2 * step / STEPS;
    ctx.stroke(); previous = alpha;
  }
  const bytes = canvas.width * canvas.height * 4;
  while (retainedBytes + bytes > MASK_BUDGET && recent.size) {
    const oldest = recent.values().next().value!;
    recent.delete(oldest); retainedBytes -= oldest.bytes; delete oldest.owner.texture;
  }
  const texture = { canvas, x, y, width: canvas.width / scale, height: canvas.height / scale, bytes, owner: mask };
  mask.texture = texture; recent.add(texture); retainedBytes += bytes;
  return texture;
}
