import type { FixedWorldScene, WorldBounds, WorldBush, WorldImage, WorldPoint } from "./tiled/types";
import { forestBushArtworkAvailable } from "./forest-bush-artwork";
import { forestBushBounds } from "./forest-bush-particles";
import { drawForestBushSoil } from "./forest-bush-soil";

type BushShadow = {
  image: HTMLImageElement; terrain: WorldImage; bounds: WorldBounds;
  contact: HTMLCanvasElement; cast: HTMLCanvasElement; fringe: HTMLCanvasElement;
};
const shadows = new WeakMap<WorldBush, BushShadow>();

/** Find the lowest opaque leaf tips, never the navigation polygon or PNG padding.
 * Sampling is performed once while baking the grounding, not during animation. */
export function forestBushRootContacts(pixels: Uint8ClampedArray, width: number, height: number,
  bounds: WorldBounds): WorldPoint[] {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1
    || pixels.length !== width * height * 4 || ![bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isFinite)
    || bounds.width <= 0 || bounds.height <= 0) return [];
  const floor = new Int32Array(width).fill(-1);
  let left = width, right = -1, top = height, bottom = -1;
  for (let x = 0; x < width; x++) {
    for (let y = 0; y < height; y++) {
      if (pixels[(y * width + x) * 4 + 3] < 96) continue;
      left = Math.min(left, x); right = Math.max(right, x); top = Math.min(top, y);
      bottom = Math.max(bottom, y); floor[x] = y;
    }
  }
  if (bottom <= top || right <= left) return [];
  const contacts: WorldPoint[] = [];
  for (let i = 0; i < 7; i++) {
    const x = Math.round(left + (right - left) * (.18 + i * .105));
    if (floor[x] < top + (bottom - top) * .84) continue;
    contacts.push({ x: bounds.x + (x + .5) / width * bounds.width,
      y: bounds.y + (floor[x] + .5) / height * bounds.height });
  }
  return contacts;
}

function paintRootFringe(ctx: CanvasRenderingContext2D, contacts: readonly WorldPoint[], size: number) {
  for (let i = 0; i < contacts.length; i++) {
    const { x, y } = contacts[i], height = size * (.031 + i % 3 * .007);
    // A few blades cross the lowest leaf tips. Their dark bases remain at the
    // true alpha contact; no continuous bright outline or duplicate leaf sprite.
    for (let blade = 0; blade < 3; blade++) {
      const lean = (blade - 1) * height * (.43 + i % 2 * .12);
      const tipY = y - height * (blade === 1 ? 1 : .73);
      ctx.fillStyle = ["#4d652d", "#738439", "#607330"][(i + blade) % 3];
      ctx.beginPath(); ctx.moveTo(x - height * .12, y + height * .16);
      ctx.quadraticCurveTo(x + lean * .2, y - height * .4, x + lean, tipY);
      ctx.quadraticCurveTo(x + lean * .4 + height * .13, y - height * .25, x + height * .13, y + height * .16);
      ctx.closePath(); ctx.fill();
    }
  }
}

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
  const mask = surface(), contact = surface(), cast = surface(), fringe = surface();
  const maskCtx = mask.getContext("2d"), contactCtx = contact.getContext("2d"), castCtx = cast.getContext("2d"), fringeCtx = fringe.getContext("2d");
  if (!maskCtx || !contactCtx || !castCtx || !fringeCtx) return null;
  maskCtx.save(); maskCtx.scale(scale, scale); maskCtx.translate(-bounds.x, -bounds.y);
  // The actual cutout supplies the silhouette; interaction vertices must never
  // imprint an angular edge on contact shadows or appear when hiding inside it.
  maskCtx.drawImage(image, terrain.bounds.x, terrain.bounds.y, terrain.bounds.width, terrain.bounds.height);
  maskCtx.restore();
  maskCtx.globalCompositeOperation = "source-in"; maskCtx.fillStyle = "#26341c";
  maskCtx.fillRect(0, 0, mask.width, mask.height);

  try {
    const contacts = forestBushRootContacts(maskCtx.getImageData(0, 0, mask.width, mask.height).data,
      mask.width, mask.height, bounds);
    fringeCtx.scale(scale, scale); fringeCtx.translate(-bounds.x, -bounds.y);
    paintRootFringe(fringeCtx, contacts, size);
  } catch { /* Cross-origin artwork keeps its original alpha shadow without fringe. */ }

  const bottom = crown.y + crown.height - bounds.y;
  const project = (ctx: CanvasRenderingContext2D, squash: number, narrow: number, dx: number, dy: number, blur: number) => {
    ctx.filter = `blur(${blur * scale}px)`;
    ctx.drawImage(mask, dx * scale + mask.width * (1 - narrow) * .5, (bottom * (1 - squash) + dy) * scale,
      mask.width * narrow, mask.height * squash);
    // Explicit alpha feathering also works in renderers without Canvas blur.
    // The compact footprint has no long, sharply flattened silhouette ends.
    try {
      const pixels = ctx.getImageData(0, 0, mask.width, mask.height);
      const centerX = mask.width * .5 + dx * scale;
      const centerY = (bottom - crown.height * squash * .47 + dy) * scale;
      const radiusX = crown.width * narrow * .52 * scale, radiusY = crown.height * squash * .63 * scale;
      for (let y = 0; y < mask.height; y++) for (let x = 0; x < mask.width; x++) {
        const distance = Math.hypot((x + .5 - centerX) / radiusX, (y + .5 - centerY) / radiusY);
        pixels.data[(y * mask.width + x) * 4 + 3] *= Math.max(0, Math.min(1, (1 - distance) / .48));
      }
      ctx.putImageData(pixels, 0, 0);
    } catch { /* Browser without pixel access retains the short native blurred silhouette. */ }
  };
  // A short cast to the lower right matches the painted upper-left daylight.
  // Contact stays immediately beneath the foliage, even when daylight fades.
  project(castCtx, .18, .82, size * .037, size * .025, size * .023);
  project(contactCtx, .14, .74, 0, size * .02, size * .009);
  const shadow = { image, terrain, bounds, contact, cast, fringe };
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
  ctx.globalAlpha = alpha * .12 * (1 - darkness * .68);
  ctx.drawImage(shadow.cast, bounds.x, bounds.y, bounds.width, bounds.height);
  ctx.globalAlpha = alpha * .49 * (1 - darkness * .18);
  ctx.drawImage(shadow.contact, bounds.x, bounds.y, bounds.width, bounds.height);
  ctx.restore();
}

/** Called by whichever pass owns the PNG; the roots stay fixed while leaves rustle. */
export function drawForestBushRootFringe(ctx: CanvasRenderingContext2D, scene: FixedWorldScene,
  terrain: WorldImage, image: HTMLImageElement) {
  const bush = scene.bushes?.find(item => item.imageId === terrain.id);
  if (!bush || !forestBushArtworkAvailable(scene, bush)) return;
  const shadow = shadowFor(bush, terrain, image);
  if (!shadow) return;
  const { bounds } = shadow;
  ctx.drawImage(shadow.fringe, bounds.x, bounds.y, bounds.width, bounds.height);
}
