import type { ExpressionSpecification, FillLayerSpecification, Map as LibreMap } from "maplibre-gl";

export const EARTH_LAND_MATERIAL_IMAGE = "earth-matte-land-v2";
export const EARTH_LAND_MATERIAL_SIZE = 128;
export const EARTH_LAND_MATERIAL_MAX_ZOOM = 8;
const pixelRatio = 2;

/** Periodic integer noise; every octave wraps on the same texture boundary. */
function noise(x: number, y: number, period: number, seed: number): number {
  const wrappedX = ((x % period) + period) % period;
  const wrappedY = ((y % period) + period) % period;
  let value = Math.imul(wrappedX + seed, 374761393) ^ Math.imul(wrappedY + seed, 668265263);
  value = Math.imul(value ^ value >>> 13, 1274126177);
  return ((value ^ value >>> 16) >>> 0) / 0xffffffff * 2 - 1;
}

function softNoise(x: number, y: number, cells: number, seed: number): number {
  const sx = x / EARTH_LAND_MATERIAL_SIZE * cells;
  const sy = y / EARTH_LAND_MATERIAL_SIZE * cells;
  const ix = Math.floor(sx); const iy = Math.floor(sy);
  const fx = sx - ix; const fy = sy - iy;
  const tx = fx * fx * (3 - 2 * fx); const ty = fy * fy * (3 - 2 * fy);
  const top = noise(ix, iy, cells, seed) * (1 - tx) + noise(ix + 1, iy, cells, seed) * tx;
  const bottom = noise(ix, iy + 1, cells, seed) * (1 - tx) + noise(ix + 1, iy + 1, cells, seed) * tx;
  return top * (1 - ty) + bottom * ty;
}

let materialPixels: Uint8Array | undefined;

/**
 * Small matte paper/clay grain, generated once and copied for each map image.
 * Transparent warm highlights and olive pores preserve the actual land colour.
 * No canvas, network asset, timer, random seed or per-frame texture upload.
 */
export function createEarthLandMaterialImage(): { width: number; height: number; data: Uint8Array } {
  if (!materialPixels) {
    materialPixels = new Uint8Array(EARTH_LAND_MATERIAL_SIZE ** 2 * 4);
    for (let y = 0; y < EARTH_LAND_MATERIAL_SIZE; y += 1) {
      for (let x = 0; x < EARTH_LAND_MATERIAL_SIZE; x += 1) {
        const grain = softNoise(x, y, 4, 17) * 0.52 + softNoise(x, y, 12, 43) * 0.3
          + softNoise(x, y, 24, 89) * 0.13 + noise(x, y, EARTH_LAND_MATERIAL_SIZE, 127) * 0.05;
        const highlight = grain >= 0;
        const index = (y * EARTH_LAND_MATERIAL_SIZE + x) * 4;
        materialPixels[index] = highlight ? 248 : 87;
        materialPixels[index + 1] = highlight ? 246 : 112;
        materialPixels[index + 2] = highlight ? 209 : 66;
        materialPixels[index + 3] = Math.round(6 + Math.abs(grain) * 82);
      }
    }
  }
  // MapLibre owns its copy; cache/worker transfers can never detach our seed image.
  return { width: EARTH_LAND_MATERIAL_SIZE, height: EARTH_LAND_MATERIAL_SIZE, data: materialPixels.slice() };
}

type MaterialMap = Pick<LibreMap, "hasImage" | "addImage">;

/** Call at the start of style.load, before the initial-ready check is enabled. */
export function registerEarthMaterialImage(map: MaterialMap): void {
  if (!map.hasImage(EARTH_LAND_MATERIAL_IMAGE)) {
    map.addImage(EARTH_LAND_MATERIAL_IMAGE, createEarthLandMaterialImage(), { pixelRatio });
  }
}

/** Install immediately after map construction; resolve only our known local pattern. */
export function installEarthMaterialImages(map: MaterialMap & Pick<LibreMap, "setMissingStyleImageResolver">,
  resolveOtherImage?: (id: string) => void): void {
  map.setMissingStyleImageResolver(id => {
    if (id === EARTH_LAND_MATERIAL_IMAGE) registerEarthMaterialImage(map);
    else resolveOtherImage?.(id);
  });
}

/** Identical paint on coarse and detailed land keeps material phase/strength consistent. */
export function earthLandMaterialLayer(id: string, source: string, sourceLayer?: string): FillLayerSpecification {
  const opacity: ExpressionSpecification = ["interpolate", ["linear"], ["zoom"], 0, 0.85, 4, 0.85, 6, 0.5, EARTH_LAND_MATERIAL_MAX_ZOOM, 0];
  return {
    id, type: "fill", source, ...(sourceLayer ? { "source-layer": sourceLayer, minzoom: 4 } : {}),
    maxzoom: EARTH_LAND_MATERIAL_MAX_ZOOM,
    paint: { "fill-pattern": EARTH_LAND_MATERIAL_IMAGE, "fill-opacity": opacity, "fill-antialias": false },
  };
}
