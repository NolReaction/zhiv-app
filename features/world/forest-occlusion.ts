import type { FixedWorldScene, WorldBounds, WorldPoint } from "./tiled/types";
import { previewPointInPolygon } from "./tiled/preview-state";
import { forestOcclusionTexture, type ForestOcclusionContour } from "./forest-occlusion-mask";

type Actor = WorldPoint & { size: number };
type Mask = ForestOcclusionContour & {
  frontY: number;
  path?: Path2D;
};
type Geometry = { masks: Mask[]; margin: number; width: number; height: number };
const geometry = new WeakMap<FixedWorldScene, Geometry>();

function compiled(scene: FixedWorldScene): Geometry {
  let cached = geometry.get(scene);
  if (cached) return cached;
  const masks: Mask[] = [];
  for (const mask of scene.occluders ?? []) {
    if (!Number.isFinite(mask.frontY) || mask.points.length < 3
      || mask.points.some(point => !Number.isFinite(point.x) || !Number.isFinite(point.y))) continue;
    let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
    for (const point of mask.points) {
      left = Math.min(left, point.x); top = Math.min(top, point.y);
      right = Math.max(right, point.x); bottom = Math.max(bottom, point.y);
    }
    masks.push({ points: mask.points, frontY: mask.frontY, left, top, right, bottom });
  }
  // Include sprite overhang at the map edges without an unbounded canvas path.
  const width = scene.width, height = scene.height, margin = Math.max(width, height, 1);
  cached = { masks, margin, width, height };
  geometry.set(scene, cached);
  return cached;
}

function traceInverse(target: CanvasRenderingContext2D | Path2D, mask: Mask, area: Geometry) {
  target.rect(-area.margin, -area.margin, area.width + area.margin * 2, area.height + area.margin * 2);
  target.moveTo(mask.points[0].x, mask.points[0].y);
  for (let index = 1; index < mask.points.length; index++) target.lineTo(mask.points[index].x, mask.points[index].y);
  target.closePath();
}

type Layer = { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D; busy: boolean };
const layers = new WeakMap<CanvasRenderingContext2D, Layer>();

/** Composite just the actor, at physical screen resolution. Its original pixels
 * never pass through a blur or a resized texture. One scratch surface is reused
 * per camera; even long fishing props are clipped to the visible viewport. */
function feathered(ctx: CanvasRenderingContext2D, masks: Mask[], bounds: WorldBounds,
  draw: (target: CanvasRenderingContext2D) => void): boolean {
  if (typeof document === "undefined" || typeof ctx.getTransform !== "function"
    || typeof ctx.setTransform !== "function" || typeof ctx.drawImage !== "function" || !ctx.canvas
    || ctx.globalCompositeOperation !== "source-over") return false;
  const t = ctx.getTransform();
  if (![t.a, t.b, t.c, t.d, t.e, t.f, ctx.canvas.width, ctx.canvas.height].every(Number.isFinite)) return false;
  const corners = [[bounds.x, bounds.y], [bounds.x + bounds.width, bounds.y],
    [bounds.x, bounds.y + bounds.height], [bounds.x + bounds.width, bounds.y + bounds.height]]
    .map(([x, y]) => ({ x: t.a * x + t.c * y + t.e, y: t.b * x + t.d * y + t.f }));
  const x = Math.max(0, Math.floor(Math.min(...corners.map(point => point.x))) - 2);
  const y = Math.max(0, Math.floor(Math.min(...corners.map(point => point.y))) - 2);
  const right = Math.min(ctx.canvas.width, Math.ceil(Math.max(...corners.map(point => point.x))) + 2);
  const bottom = Math.min(ctx.canvas.height, Math.ceil(Math.max(...corners.map(point => point.y))) + 2);
  const width = Math.ceil((right - x) / 32) * 32, height = Math.ceil((bottom - y) / 32) * 32;
  if (width <= 0 || height <= 0) return true;
  // Bound transient GPU memory on mobile; an unusually large DEV scale uses
  // the original vector clip instead of allocating a full-screen extra layer.
  if (width > 2048 || height > 2048 || width * height > 1024 * 1024) return false;
  let layer = layers.get(ctx);
  if (layer?.busy) return false;
  if (!layer) {
    const canvas = document.createElement("canvas"), target = canvas.getContext("2d");
    if (!target || typeof target.setTransform !== "function" || typeof target.drawImage !== "function") return false;
    layer = { canvas, ctx: target, busy: false }; layers.set(ctx, layer);
  }
  const textures = masks.map(forestOcclusionTexture);
  if (textures.some(texture => !texture)) return false;
  if (layer.canvas.width !== width) layer.canvas.width = width;
  if (layer.canvas.height !== height) layer.canvas.height = height;
  const target = layer.ctx;
  target.setTransform(1, 0, 0, 1, 0, 0); target.clearRect(0, 0, width, height);
  target.save(); layer.busy = true;
  try {
    target.setTransform(t.a, t.b, t.c, t.d, t.e - x, t.f - y);
    target.globalAlpha = ctx.globalAlpha; target.globalCompositeOperation = "source-over";
    target.imageSmoothingEnabled = ctx.imageSmoothingEnabled;
    target.fillStyle = ctx.fillStyle; target.strokeStyle = ctx.strokeStyle;
    target.lineWidth = ctx.lineWidth; target.lineJoin = ctx.lineJoin; target.lineCap = ctx.lineCap;
    target.font = ctx.font; target.textAlign = ctx.textAlign; target.textBaseline = ctx.textBaseline;
    draw(target);
    target.setTransform(t.a, t.b, t.c, t.d, t.e - x, t.f - y);
    target.globalCompositeOperation = "destination-out"; target.globalAlpha = 1;
    target.imageSmoothingEnabled = true;
    for (const texture of textures) {
      target.drawImage(texture!.canvas, texture!.x, texture!.y, texture!.width, texture!.height);
    }
    ctx.save();
    try {
      ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.globalAlpha = 1;
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(layer.canvas, x, y);
    } finally { ctx.restore(); }
  } finally { target.restore(); layer.busy = false; }
  return true;
}

/** Match visual masking when deciding whether a tap can reach the hero. */
export function forestPointOccluded(scene: FixedWorldScene, feetY: number, point: WorldPoint): boolean {
  if (!scene.occluders?.length || !Number.isFinite(feetY) || !Number.isFinite(point.x) || !Number.isFinite(point.y)) return false;
  return compiled(scene).masks.some(mask => feetY < mask.frontY
    && point.x >= mask.left && point.x <= mask.right && point.y >= mask.top && point.y <= mask.bottom
    && previewPointInPolygon(point, mask.points));
}

/**
 * Hide only the actor's pixels under authored foreground contours. Coordinates
 * are world-space; y is the actor's feet. Pass the effective preview scene so
 * level-specific masks have already been filtered with their site artwork.
 * Paint into the supplied target (it may be an isolated actor layer). Ground,
 * buildings and other actors must be painted outside this callback.
 */
export function withForestOcclusion(ctx: CanvasRenderingContext2D, scene: FixedWorldScene, actor: Actor, draw: (target: CanvasRenderingContext2D) => void,
  renderBounds?: WorldBounds): void {
  if (!scene.occluders?.length || !Number.isFinite(actor.x) || !Number.isFinite(actor.y)
    || !Number.isFinite(actor.size) || actor.size <= 0) { draw(ctx); return; }
  const area = compiled(scene);
  // Conservative envelope also covers held props, extended arms and a lifted
  // sprite. Only nearby masks reach the canvas; geometry is shared by cameras.
  const bounds = renderBounds && Object.values(renderBounds).every(Number.isFinite)
    && renderBounds.width > 0 && renderBounds.height > 0 ? renderBounds : null;
  const left = bounds?.x ?? actor.x - actor.size * 2, right = bounds ? bounds.x + bounds.width : actor.x + actor.size * 2;
  const top = bounds?.y ?? actor.y - actor.size * 2.5, bottom = bounds ? bounds.y + bounds.height : actor.y + actor.size;
  const masks = area.masks.filter(mask => actor.y < mask.frontY && right >= mask.left
    && left <= mask.right && bottom >= mask.top && top <= mask.bottom);
  if (!masks.length) { draw(ctx); return; }
  if (feathered(ctx, masks, { x: left, y: top, width: right - left, height: bottom - top }, draw)) return;
  let saved = false;
  try {
    for (const mask of masks) {
      if (!saved) { ctx.save(); saved = true; }
      if (typeof Path2D !== "undefined") {
        if (!mask.path) { mask.path = new Path2D(); traceInverse(mask.path, mask, area); }
        ctx.clip(mask.path, "evenodd");
      } else {
        ctx.beginPath(); traceInverse(ctx, mask, area); ctx.clip("evenodd");
      }
      // Each clip intersects the previous complement: overlapping crowns stay
      // hidden. A single evenodd path containing every crown would reopen them.
    }
    draw(ctx);
  } finally {
    if (saved) ctx.restore();
  }
}
