import type { ExpressionSpecification, FillLayerSpecification, Map as LibreMap } from "maplibre-gl";

const BUILDING_PAINT = [
  { id: "earth-buildings", opacity: "fill-opacity", transition: "fill-opacity-transition" },
  { id: "earth-buildings-3d", opacity: "fill-extrusion-opacity", transition: "fill-extrusion-opacity-transition" },
] as const;
const SHADE = "earth-evening-shade";
const INSTANT = { duration: 0, delay: 0 };
type VisualMap = Pick<LibreMap, "on" | "off" | "getLayer" | "getPaintProperty" | "setPaintProperty" | "getLayoutProperty" | "setLayoutProperty">;
type Opacity = NonNullable<FillLayerSpecification["paint"]>["fill-opacity"];
type Transition = NonNullable<FillLayerSpecification["paint"]>["fill-opacity-transition"];
type SavedPaint = { layer: unknown; opacity: Opacity; transition: Transition };
type SavedShade = { layer: unknown; visibility: "visible" | "none" | ExpressionSpecification | undefined };
function instant(value: Transition) { return value?.duration === 0 && (value.delay ?? 0) === 0; }

/** Buildings own their visibility preference; satellite only borrows their paint.
 * Preserve expressions/transitions and unrelated seasonal/model-mask updates.
 * Materials/relief already sit below the raster and require no extra overrides.
 */
export function createEarthSatelliteVisuals(map: VisualMap, rasterLayerId: string) {
  const saved = new Map<string, SavedPaint>();
  let shade: SavedShade | null = null;
  let requested = false, synchronizing = false, disposed = false;
  function synchronize() {
    if (disposed || synchronizing) return;
    synchronizing = true;
    try {
      const active = requested && !!map.getLayer(rasterLayerId);
      for (const { id, opacity, transition } of BUILDING_PAINT) {
        const layer = map.getLayer(id);
        let previous = saved.get(id);
        if (previous && previous.layer !== layer) { saved.delete(id); previous = undefined; }
        if (!layer) continue;
        if (active) {
          const currentOpacity = map.getPaintProperty(id, opacity);
          const currentTransition = map.getPaintProperty(id, transition);
          if (!previous) {
            previous = { layer, opacity: currentOpacity, transition: currentTransition };
            saved.set(id, previous);
          } else {
            // A new paint choice while imagery is open becomes the restoration
            // value, rather than being silently discarded by the old snapshot.
            if (currentOpacity !== 0) previous.opacity = currentOpacity;
            if (!instant(currentTransition)) previous.transition = currentTransition;
          }
          if (!instant(currentTransition)) map.setPaintProperty(id, transition, INSTANT);
          if (currentOpacity !== 0) map.setPaintProperty(id, opacity, 0);
        } else if (previous) {
          saved.delete(id);
          if (instant(map.getPaintProperty(id, transition))) map.setPaintProperty(id, transition, previous.transition);
          if (map.getPaintProperty(id, opacity) === 0) map.setPaintProperty(id, opacity, previous.opacity);
        }
      }
      const layer = map.getLayer(SHADE);
      if (shade && shade.layer !== layer) shade = null;
      if (layer && active) {
        const visibility = map.getLayoutProperty(SHADE, "visibility");
        if (!shade) shade = { layer, visibility };
        else if (visibility !== "none") shade.visibility = visibility;
        if (visibility !== "none") map.setLayoutProperty(SHADE, "visibility", "none");
      } else if (layer && shade) {
        const previous = shade; shade = null;
        if (map.getLayoutProperty(SHADE, "visibility") === "none") map.setLayoutProperty(SHADE, "visibility", previous.visibility);
      }
    } finally { synchronizing = false; }
  }
  map.on("styledata", synchronize);
  return {
    setActive(value: boolean) { if (!disposed) { requested = value; synchronize(); } },
    dispose() {
      if (disposed) return;
      requested = false;
      try { synchronize(); } finally {
        disposed = true; saved.clear(); shade = null;
        map.off("styledata", synchronize);
      }
    },
  };
}
