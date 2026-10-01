import type { FixedWorldScene, WorldBounds, WorldBush, WorldImage, WorldPoint } from "./tiled/types";
import { forestBushArtworkAvailable } from "./forest-bush-artwork";
import { forestBushBounds } from "./forest-bush-particles";
import { drawForestBushSoil } from "./forest-bush-soil";

type BushShadow = {
  image: HTMLImageElement; terrain: WorldImage; bounds: WorldBounds;
  contact: HTMLCanvasElement; cast: HTMLCanvasElement; fringe: HTMLCanvasElement;
};
const shadows = new WeakMap<WorldBush, BushShadow>();

/** Join ground darkness directly to the lowest opaque leaves, without an airy
 * gap left by a projected/blurred crown. Works only on the cached mask pixels. */
export function attachForestBushContact(source: Uint8ClampedArray, target: Uint8ClampedArray,
  width: number, height: number, rise: number, depth: number) {
  if (source.length !== width * height * 4 || target.length !== source.length
    || !Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0
    || !Number.isFinite(rise) || !Number.isFinite(depth) || rise <= 0 || depth <= 0) return;
  const floor = new Int32Array(width).fill(-1);
  let bottom = -1;
  for (let x = 0; x < width; x++) for (let y = height - 1; y >= 0; y--) {
    if (source[(y * width + x) * 4 + 3] < 96) continue;
    floor[x] = y; bottom = Math.max(bottom, y); break;
  }
  if (bottom < 0) return;
  for (let x = 0; x < width; x++) {
    const leaf = floor[x];
    if (leaf < 0 || leaf < bottom - rise) continue;
    const sideFade = Math.min(1, (leaf - bottom + rise) / (rise * .45));
    for (let y = leaf; y < Math.min(height, leaf + depth); y++) {
      const index = (y * width + x) * 4;
      const alpha = 235 * sideFade * Math.pow(1 - (y - leaf) / depth, 1.45);
      if (alpha <= target[index + 3]) continue;
      target[index] = 34; target[index + 1] = 44; target[index + 2] = 24;
      target[index + 3] = alpha;
    }
  }
}

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

function paintRootBase(ctx: CanvasRenderingContext2D, contacts: readonly WorldPoint[], size: number) {
  if (contacts.length < 3) return;
  const x = contacts[Math.floor(contacts.length / 2)].x;
  const y = Math.max(...contacts.map(point => point.y)) + size * .015;
  const unit = size * .018;
  // A squat woody fork reaches 3–4 world units beyond the central leaf tip.
  // Its top is later erased with the PNG alpha, so it really emerges underneath.
  const contour = [[-1.4, -3.1], [1.1, -3.3], [1.7, -.6], [4.3, .9], [7, 1.5], [7.6, 2.1],
    [4.6, 1.9], [1.8, .8], [1.4, 2.4], [2.5, 3.2], [.9, 3.0], [-.8, .9],
    [-3.8, 2.4], [-6.6, 2.7], [-7.1, 2.2], [-4.4, 1.5], [-1.6, -.4]];
  ctx.fillStyle = "#4e3520"; ctx.beginPath();
  contour.forEach(([dx, dy], index) => index ? ctx.lineTo(x + dx * unit, y + dy * unit) : ctx.moveTo(x + dx * unit, y + dy * unit));
  ctx.closePath(); ctx.fill();
  ctx.strokeStyle = "#382c1b"; ctx.lineWidth = unit * .3; ctx.lineJoin = "round"; ctx.stroke();
  ctx.strokeStyle = "#977141"; ctx.lineWidth = unit * .32; ctx.lineCap = "round";
  for (const branch of [[[-.5, -2.5], [-.35, .2], [-3.5, 1.65], [-5.8, 2.05]],
    [[.45, -1.8], [.9, .15], [3.7, 1.1], [6.1, 1.6]], [[.15, .35], [.75, 2.2], [1.65, 2.7]]]) {
    ctx.beginPath(); branch.forEach(([dx, dy], index) => index ? ctx.lineTo(x + dx * unit, y + dy * unit) : ctx.moveTo(x + dx * unit, y + dy * unit)); ctx.stroke();
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

  let alphaMask: Uint8ClampedArray | null = null;
  try {
    alphaMask = maskCtx.getImageData(0, 0, mask.width, mask.height).data;
    const contacts = forestBushRootContacts(alphaMask, mask.width, mask.height, bounds);
    fringeCtx.save(); fringeCtx.scale(scale, scale); fringeCtx.translate(-bounds.x, -bounds.y);
    paintRootBase(fringeCtx, contacts, size); fringeCtx.restore();
    // Foreground ownership does not put wood over leaves: retain only the part
    // outside the original cutout. The foliage remains free to sway above it.
    fringeCtx.globalCompositeOperation = "destination-out";
    fringeCtx.drawImage(mask, 0, 0); fringeCtx.globalCompositeOperation = "source-over";
    // Darken only the last few pixels inside the low opaque leaves. The same
    // alpha mask joins the contact below to the foliage above, avoiding a lit rim.
    try {
      const shade = fringeCtx.getImageData(0, 0, mask.width, mask.height), floor = new Int32Array(mask.width).fill(-1);
      let bottom = -1;
      for (let x = 0; x < mask.width; x++) for (let y = mask.height - 1; y >= 0; y--) {
        if (alphaMask[(y * mask.width + x) * 4 + 3] < 96) continue;
        floor[x] = y; bottom = Math.max(bottom, y); break;
      }
      const depth = size * .049 * scale, rise = size * .15 * scale;
      for (let x = 0; x < mask.width; x++) for (let y = 0; y < mask.height; y++) {
        const index = (y * mask.width + x) * 4, distance = floor[x] - y;
        const fade = Math.max(0, Math.min(1, (floor[x] - bottom + rise) / rise));
        const alpha = distance >= 0 && distance < depth ? alphaMask[index + 3] * .32 * (1 - distance / depth) * fade : 0;
        if (alpha <= 0) continue;
        shade.data[index] = 26; shade.data[index + 1] = 43; shade.data[index + 2] = 20;
        shade.data[index + 3] = alpha;
      }
      fringeCtx.putImageData(shade, 0, 0);
    } catch { /* Low foliage retains its original shading when readback is unavailable. */ }
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
  if (alphaMask) {
    try {
      const pixels = contactCtx.getImageData(0, 0, mask.width, mask.height);
      attachForestBushContact(alphaMask, pixels.data, mask.width, mask.height, size * .14 * scale, size * .033 * scale);
      contactCtx.putImageData(pixels, 0, 0);
    } catch { /* Keep the projected contact if pixel readback is unavailable. */ }
  }
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
  ctx.globalAlpha = alpha * .57 * (1 - darkness * .18);
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
  ctx.save();
  ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = "high";
  ctx.drawImage(shadow.fringe, bounds.x, bounds.y, bounds.width, bounds.height);
  ctx.restore();
}
