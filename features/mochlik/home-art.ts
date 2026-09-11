import { FOREST_MAP } from "@/features/world/map-manifest";
import { HOME_AREA, MAP_SIZE } from "@/features/world/map-layout";
import { WORLD_ART } from "@/features/world/art";
import { loadHabitatImage } from "./assets";

// Texture pixels are independent of the unchanged 256-unit animation space.
export const HOME_TEXTURE_SIZE = 2048;
const overlays = new WeakMap<HTMLImageElement, HTMLCanvasElement>();

/** Home details do not depend on downloading the entire forest first. */
export function loadHomeDetail(): Promise<HTMLImageElement> {
  return loadHabitatImage(WORLD_ART.homeDetail, "low").then(detail => {
    if (detail.naturalWidth < HOME_TEXTURE_SIZE || detail.naturalHeight !== detail.naturalWidth)
      throw new Error("Home detail must be a high-resolution square");
    return detail;
  });
}

/** Keep the outer world pixels live underneath this transparent feathered tile.
 * A map preview can upgrade independently without leaving a low-detail seam. */
export function prepareHomeDetail(detail: HTMLImageElement): HTMLCanvasElement {
  const cached = overlays.get(detail); if (cached) return cached;
  const tile = document.createElement("canvas");
  tile.width = tile.height = HOME_TEXTURE_SIZE;
  const ctx = tile.getContext("2d");
  if (!ctx) throw new Error("2D canvas unavailable");
  ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = "high";
  ctx.drawImage(detail, 0, 0, HOME_TEXTURE_SIZE, HOME_TEXTURE_SIZE);
  const rim = FOREST_MAP.homeDetail.originalRim / HOME_AREA.size;
  const feather = FOREST_MAP.homeDetail.feather / HOME_AREA.size;
  ctx.globalCompositeOperation = "destination-in";
  for (const [x, y] of [[HOME_TEXTURE_SIZE, 0], [0, HOME_TEXTURE_SIZE]]) {
    const mask = ctx.createLinearGradient(0, 0, x, y);
    mask.addColorStop(0, "transparent"); mask.addColorStop(rim, "transparent");
    mask.addColorStop(rim + feather, "#fff"); mask.addColorStop(1 - rim - feather, "#fff");
    mask.addColorStop(1 - rim, "transparent"); mask.addColorStop(1, "transparent");
    ctx.fillStyle = mask; ctx.fillRect(0, 0, HOME_TEXTURE_SIZE, HOME_TEXTURE_SIZE);
  }
  ctx.globalCompositeOperation = "source-over";
  overlays.set(detail, tile);
  return tile;
}

/** Logical world geometry remains 1254 units regardless of texture resolution. */
export function homeSourceCrop(image: HTMLImageElement) {
  if (!Number.isFinite(image.naturalWidth) || image.naturalWidth <= 0 || image.naturalHeight !== image.naturalWidth)
    throw new Error("Forest texture must be a square");
  const ratio = image.naturalWidth / MAP_SIZE;
  return { x: HOME_AREA.x * ratio, y: HOME_AREA.y * ratio, size: HOME_AREA.size * ratio };
}

export function homeBackingSize(cssWidth: number, devicePixelRatio: number, offscreen = false) {
  if (offscreen) return HOME_TEXTURE_SIZE;
  const size = Number.isFinite(cssWidth) && cssWidth > 0 ? cssWidth : HOME_AREA.size;
  const ratio = Number.isFinite(devicePixelRatio) && devicePixelRatio > 0 ? Math.min(3, devicePixelRatio) : 1;
  return Math.min(HOME_TEXTURE_SIZE, Math.max(HOME_AREA.size, Math.round(size * ratio)));
}
