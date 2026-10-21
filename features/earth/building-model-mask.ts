import type { FilterSpecification, Map as LibreMap } from "maplibre-gl";
import { EARTH_BUILDINGS_3D_LAYER } from "./building-style";
import type { EarthModelPlacement } from "./model-placement";

type BuildingMaskMap = Pick<LibreMap, "getLayer" | "getFilter" | "setFilter">;

function maskDistance(placement: EarthModelPlacement) {
  const { longitude, latitude, exclusionRadiusMeters } = placement;
  const longitudes = [longitude];
  // Vector tiles on the other side of the date line use canonical longitudes.
  // `distance` itself does not wrap its GeoJSON input, so mirror only masks that
  // can reach the seam. Ordinary city models keep a single distance expression.
  const longitudeSpan = exclusionRadiusMeters / (111_000 * Math.max(0.000001, Math.cos(latitude * Math.PI / 180)));
  if (longitude + longitudeSpan >= 180) longitudes.push(longitude - 360);
  if (longitude - longitudeSpan <= -180) longitudes.push(longitude + 360);
  const distances = longitudes.map(value => ["distance", { type: "Point", coordinates: [value, latitude] }]);
  return distances.length === 1 ? distances[0] : ["min", ...distances];
}

/** Distance supports polygon features, unlike `within`, which only evaluates
 * points and lines. Keep the provider's complete filter and omit only building
 * features whose actual footprint intersects a small circle around the model.
 * The vector source and the separate 2D building layer remain untouched. */
export function earthBuildingModelFilter(
  original: FilterSpecification | undefined,
  placements: readonly EarthModelPlacement[],
  activeIds: ReadonlySet<string>,
): FilterSpecification | undefined {
  const masks = placements.filter(placement => activeIds.has(placement.id) && placement.excludeBuildings
    && Number.isFinite(placement.longitude) && Math.abs(placement.longitude) <= 180
    && Number.isFinite(placement.latitude) && Math.abs(placement.latitude) <= 90
    && Number.isFinite(placement.exclusionRadiusMeters) && placement.exclusionRadiusMeters > 0)
    .slice().sort((left, right) => left.id.localeCompare(right.id));
  if (!masks.length) return original;
  return ["all", ...(original ? [original] : []), ...masks.map(placement => [
    ">", maskDistance(placement), placement.exclusionRadiusMeters,
  ])] as FilterSpecification;
}

/** Install masks only while their imported models can actually render. Changing
 * position/radius replaces the previous mask, rather than accumulating holes.
 * Layer identity handles a style reload without reusing an obsolete filter. */
export function createEarthBuildingModelMask(map: BuildingMaskMap) {
  const supported = typeof map.getLayer === "function" && typeof map.getFilter === "function" && typeof map.setFilter === "function";
  let disposed = false;
  let layer: ReturnType<LibreMap["getLayer"]>;
  let original: FilterSpecification | undefined;
  let appliedKey: string | null = null;
  const key = (filter: FilterSpecification | void) => JSON.stringify(filter ?? null);

  return {
    setPlacements(placements: readonly EarthModelPlacement[], activeIds: ReadonlySet<string>) {
      if (disposed || !supported) return;
      const current = map.getLayer(EARTH_BUILDINGS_3D_LAYER);
      if (!current || current.type !== "fill-extrusion" || current.sourceLayer !== "building") return;
      if (layer !== current) {
        layer = current;
        const filter = map.getFilter(EARTH_BUILDINGS_3D_LAYER);
        original = filter ? JSON.parse(JSON.stringify(filter)) as FilterSpecification : undefined;
        appliedKey = null;
      }
      const next = earthBuildingModelFilter(original, placements, activeIds);
      const nextKey = key(next);
      if (nextKey === appliedKey || (appliedKey === null && nextKey === key(original))) return;
      map.setFilter(EARTH_BUILDINGS_3D_LAYER, next ?? null);
      appliedKey = nextKey;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      if (layer && map.getLayer(EARTH_BUILDINGS_3D_LAYER) === layer
        && appliedKey !== null && appliedKey !== key(original)
        && key(map.getFilter(EARTH_BUILDINGS_3D_LAYER)) === appliedKey) {
        map.setFilter(EARTH_BUILDINGS_3D_LAYER, original ?? null);
      }
      layer = undefined;
      original = undefined;
      appliedKey = null;
    },
  };
}
