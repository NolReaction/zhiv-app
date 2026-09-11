import { FOREST_MAP } from "@/features/world/map-manifest";
import { HOME_AREA } from "@/features/world/map-layout";
import { WORLD_ART } from "@/features/world/art";
import { loadHabitatImage } from "./assets";

// Texture pixels are independent of the unchanged 256-unit animation space.
export const HOME_TEXTURE_SIZE = 1024;
let prepared: Promise<HTMLCanvasElement> | null = null;

/** The same detailed tile is used by both views. Its outer rim is the original
 * map, so the border cannot introduce a rectangular seam in the open world. */
export function loadHomeDetail(map: HTMLImageElement): Promise<HTMLCanvasElement> {
  if (prepared) return prepared;
  prepared = loadHabitatImage(WORLD_ART.homeDetail, "low").then(detail => {
    if (detail.naturalWidth < HOME_TEXTURE_SIZE || detail.naturalHeight !== detail.naturalWidth)
      throw new Error("Home detail must be a high-resolution square");
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
    ctx.globalCompositeOperation = "destination-over";
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(map, HOME_AREA.x, HOME_AREA.y, HOME_AREA.size, HOME_AREA.size, 0, 0, HOME_TEXTURE_SIZE, HOME_TEXTURE_SIZE);
    ctx.globalCompositeOperation = "source-over";
    return tile;
  }).catch(error => { prepared = null; throw error; });
  return prepared;
}

export function homeBackingSize(cssWidth: number, devicePixelRatio: number, offscreen = false) {
  if (offscreen) return HOME_TEXTURE_SIZE;
  const size = Number.isFinite(cssWidth) && cssWidth > 0 ? cssWidth : HOME_AREA.size;
  const ratio = Number.isFinite(devicePixelRatio) && devicePixelRatio > 0 ? Math.min(3, devicePixelRatio) : 1;
  return Math.min(HOME_TEXTURE_SIZE, Math.max(HOME_AREA.size, Math.round(size * ratio)));
}
