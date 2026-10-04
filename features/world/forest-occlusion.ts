import type { FixedWorldScene, WorldBounds, WorldPoint } from "./tiled/types";
import { previewPointInPolygon } from "./tiled/preview-state";

type Actor = WorldPoint & { size: number };
type Mask = {
  points: WorldPoint[];
  frontY: number;
  left: number; top: number; right: number; bottom: number;
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
 * Ground, buildings and other actors must be painted outside this callback.
 */
export function withForestOcclusion(ctx: CanvasRenderingContext2D, scene: FixedWorldScene, actor: Actor, draw: () => void,
  renderBounds?: WorldBounds): void {
  if (!scene.occluders?.length || !Number.isFinite(actor.x) || !Number.isFinite(actor.y)
    || !Number.isFinite(actor.size) || actor.size <= 0) { draw(); return; }
  const area = compiled(scene);
  // Conservative envelope also covers held props, extended arms and a lifted
  // sprite. Only nearby masks reach the canvas; geometry is shared by cameras.
  const bounds = renderBounds && Object.values(renderBounds).every(Number.isFinite)
    && renderBounds.width > 0 && renderBounds.height > 0 ? renderBounds : null;
  const left = bounds?.x ?? actor.x - actor.size * 2, right = bounds ? bounds.x + bounds.width : actor.x + actor.size * 2;
  const top = bounds?.y ?? actor.y - actor.size * 2.5, bottom = bounds ? bounds.y + bounds.height : actor.y + actor.size;
  let saved = false;
  try {
    for (const mask of area.masks) {
      if (actor.y >= mask.frontY || right < mask.left || left > mask.right || bottom < mask.top || top > mask.bottom) continue;
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
    draw();
  } finally {
    if (saved) ctx.restore();
  }
}
