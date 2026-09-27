import type { FixedWorldScene, WorldBounds, WorldBush, WorldImage } from "./tiled/types";
import { forestBushArtworkAvailable } from "./forest-bush-artwork";
import { forestBushBounds } from "./forest-bush-particles";
import { drawForestBushSoil } from "./forest-bush-soil";

type BushShadow = {
  image: HTMLImageElement; terrain: WorldImage; bounds: WorldBounds;
  contact: HTMLCanvasElement; cast: HTMLCanvasElement;
};
const shadows = new WeakMap<WorldBush, BushShadow>();

/** Bake only the cutout's alpha, compressed onto the ground under the lower leaves. */
function shadowFor(bush: WorldBush, terrain: WorldImage, image: HTMLImageElement): BushShadow | null {
  const previous = shadows.get(bush);
  if (previous?.image === image && previous.terrain === terrain) return previous;
  const crown = forestBushBounds(bush);
  if (!crown || !image.naturalWidth || !image.naturalHeight || typeof document === "undefined") return null;
  const size = Math.min(crown.width, crown.height), padding = size * .22;
  const bounds = { x: crown.x - padding, y: crown.y - padding,
    width: crown.width + padding * 2, height: crown.height + padding * 2 };
  const scale = Math.min(3, 384 / Math.max(bounds.width, bounds.height));
  const surface = () => {
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.ceil(bounds.width * scale));
    canvas.height = Math.max(1, Math.ceil(bounds.height * scale));
    return canvas;
  };
  const mask = surface(), contact = surface(), cast = surface();
  const maskCtx = mask.getContext("2d"), contactCtx = contact.getContext("2d"), castCtx = cast.getContext("2d");
  if (!maskCtx || !contactCtx || !castCtx) return null;
  maskCtx.scale(scale, scale); maskCtx.translate(-bounds.x, -bounds.y);
  maskCtx.beginPath();
  bush.points.forEach((point, index) => index ? maskCtx.lineTo(point.x, point.y) : maskCtx.moveTo(point.x, point.y));
  maskCtx.closePath(); maskCtx.clip();
  maskCtx.drawImage(image, terrain.bounds.x, terrain.bounds.y, terrain.bounds.width, terrain.bounds.height);
  maskCtx.globalCompositeOperation = "source-in"; maskCtx.fillStyle = "#26341c";
  maskCtx.fillRect(bounds.x, bounds.y, bounds.width, bounds.height);

  const bottom = crown.y + crown.height - bounds.y;
  const project = (ctx: CanvasRenderingContext2D, squash: number, dx: number, dy: number, blur: number) => {
    ctx.filter = `blur(${blur * scale}px)`;
    ctx.drawImage(mask, dx * scale, (bottom * (1 - squash) + dy) * scale,
      mask.width, mask.height * squash);
  };
  // A short cast to the lower right matches the painted upper-left daylight.
  // Contact stays immediately beneath the foliage, even when daylight fades.
  project(castCtx, .20, size * .055, -size * .025, size * .027);
  project(contactCtx, .085, 0, -size * .022, size * .009);
  const shadow = { image, terrain, bounds, contact, cast };
  shadows.set(bush, shadow);
  return shadow;
}

/** Called directly before the matching terrain cutout; baked legacy bushes keep their own shading. */
export function drawForestBushGrounding(ctx: CanvasRenderingContext2D, scene: FixedWorldScene,
  terrain: WorldImage, image: HTMLImageElement, night = 0, moisture = .32) {
  const bush = scene.bushes?.find(item => item.imageId === terrain.id);
  if (!bush || !forestBushArtworkAvailable(scene, bush)) return;
  const shadow = shadowFor(bush, terrain, image);
  if (!shadow) return;
  drawForestBushSoil(ctx, bush.points, moisture);
  const darkness = Number.isFinite(night) ? Math.max(0, Math.min(1, night)) : 0;
  const { bounds } = shadow;
  ctx.save();
  const alpha = ctx.globalAlpha;
  ctx.globalAlpha = alpha * .14 * (1 - darkness * .68);
  ctx.drawImage(shadow.cast, bounds.x, bounds.y, bounds.width, bounds.height);
  ctx.globalAlpha = alpha * .42 * (1 - darkness * .18);
  ctx.drawImage(shadow.contact, bounds.x, bounds.y, bounds.width, bounds.height);
  ctx.restore();
}
