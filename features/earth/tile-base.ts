import { splitEarthBuildingTileGeometry } from "./building-tile-geometry";

/** Private MVT layer name: never reused for a provider layer. */
export const EARTH_TILE_BASE_LAYER = "__zhiv_earth_tile_base_v1";

// MVT 2.1, extent 4096: clockwise exterior ring (0,0)→(4096,0)→(4096,4096)→(0,4096).
// Tile.layers=3; Layer.version=15, name=1, extent=5, features=2;
// Feature.type=3 (POLYGON), geometry=4 (packed MoveTo / LineTo / ClosePath).
// https://github.com/mapbox/vector-tile-spec/blob/master/2.1/vector_tile.proto
const name = new TextEncoder().encode(EARTH_TILE_BASE_LAYER);
const geometry = [9, 0, 0, 26, 128, 64, 0, 0, 128, 64, 255, 63, 0, 15];
const feature = [24, 3, 34, geometry.length, ...geometry];
const layer = [120, 2, 10, name.length, ...name, 40, 128, 32, 18, feature.length, ...feature];
const tileBase = new Uint8Array([26, layer.length, ...layer]);

/**
 * Add one small tile-sized polygon to a validated, undecorated provider MVT.
 * Loaded detail tiles can then cover the coarse local land silhouette, including
 * their accurate water/coastline, while missing tiles keep that silhouette visible.
 * This is applied only to the worker-bound copy; provider bytes on disk stay intact.
 */
export function appendEarthTileBase(data: ArrayBuffer): ArrayBuffer {
  const buildings = splitEarthBuildingTileGeometry(data);
  const result = new Uint8Array(buildings.byteLength + tileBase.byteLength);
  result.set(new Uint8Array(buildings));
  result.set(tileBase, buildings.byteLength);
  return result.buffer;
}

/** Advertise the worker-only layer before MapLibre validates style source-layer names. */
export function prepareEarthTileIndex<T>(value: T): T | object {
  if (!value || typeof value !== "object" || !("tiles" in value) || !Array.isArray(value.tiles)) return value;
  const index = value as { tiles: unknown[]; vector_layers?: { id?: string }[]; maxzoom?: number };
  // An omitted layer inventory means no schema restriction. Inventing an
  // inventory containing only our layer would hide valid provider layers.
  if (!Array.isArray(index.vector_layers)) return value;
  const layers = index.vector_layers;
  if (layers.some(layer => layer?.id === EARTH_TILE_BASE_LAYER)) return value;
  return { ...index, vector_layers: [...layers, { id: EARTH_TILE_BASE_LAYER, fields: {}, minzoom: 0,
    maxzoom: Number.isFinite(index.maxzoom) ? index.maxzoom : 14 }] };
}

export function isEarthTileIndexUrl(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.protocol === "earth-cache:") return isEarthTileIndexUrl(url.searchParams.get("url") ?? "");
    return url.protocol === "https:" && url.hostname === "tiles.openfreemap.org"
      && !url.username && !url.password && /^\/planet\/?$/.test(url.pathname);
  } catch { return false; }
}

/** Only OpenFreeMap planet vector tiles use the injected layer; never SDK/glyph/image data. */
export function isEarthVectorTileUrl(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.protocol === "earth-cache:") return isEarthVectorTileUrl(url.searchParams.get("url") ?? "");
    return url.protocol === "https:" && url.hostname === "tiles.openfreemap.org"
      && !url.username && !url.password
      && /^\/planet\/[^/]+\/\d+\/\d+\/\d+\.pbf$/.test(url.pathname);
  } catch { return false; }
}
