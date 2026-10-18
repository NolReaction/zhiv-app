import type { Map as LibreMap } from "maplibre-gl";
import type { EarthTileRecoveryTarget } from "./tile-recovery";

type RecoveryMap = Pick<LibreMap, "getSource" | "getStyle" | "getLayer" | "refreshTiles"
  | "removeLayer" | "removeSource" | "addSource" | "addLayer">;

/** Keep the camera, WebGL context and local land while resetting stalled source tile requests. */
export function refreshEarthTileSource(map: RecoveryMap, target: EarthTileRecoveryTarget): boolean {
  if (!map.getSource(target.sourceId)) return false;
  if (target.tiles) {
    if (!target.tiles.length) return false;
    map.refreshTiles(target.sourceId, target.tiles);
    return true;
  }
  const style = map.getStyle();
  const source = style?.sources[target.sourceId];
  if (!source || (source.type !== "vector" && source.type !== "raster")) return false;
  const dependent = new Set(style.layers.filter(layer => "source" in layer && layer.source === target.sourceId)
    .map(layer => layer.id));
  // MapLibre 6.15's source-wide refresh can leave errored/loading vector tiles
  // waiting on an already failed worker request. A new source has fresh tile actors.
  for (const id of dependent) if (map.getLayer(id)) map.removeLayer(id);
  map.removeSource(target.sourceId);
  map.addSource(target.sourceId, source);
  // Restore interleaved layers around their unchanged neighbors, including the
  // case where several dependent layers originally occupied the top of the map.
  let before: string | undefined;
  for (let index = style.layers.length - 1; index >= 0; index -= 1) {
    const layer = style.layers[index];
    if (dependent.has(layer.id)) map.addLayer(layer, before);
    if (map.getLayer(layer.id)) before = layer.id;
  }
  return true;
}
