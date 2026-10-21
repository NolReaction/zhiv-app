import type { Map as LibreMap } from "maplibre-gl";

/**
 * MapLibre 6.15's click/tap zoom and gesture inertia call easeTo({ around }),
 * which its globe easing does not support. Live wheel/pinch controls already
 * use the supported globe path and are left alone.
 */
export function installEarthGlobeCamera(map: LibreMap): () => void {
  const originalEaseTo = map.easeTo;
  const previousDescriptor = Object.getOwnPropertyDescriptor(map, "easeTo");
  const easeTo: LibreMap["easeTo"] = function (options, eventData) {
    if (!options.around || map.getProjection()?.type !== "globe") {
      return originalEaseTo.call(map, options, eventData);
    }

    const { around, ...supportedOptions } = options;
    // The anchored API calculates zoom/center only. Combined pan/rotation
    // inertia retains its explicit destination and eases around the center.
    if (options.zoom !== undefined && options.center === undefined &&
      options.bearing === undefined && options.pitch === undefined &&
      options.roll === undefined && options.padding === undefined && options.offset === undefined) {
      const anchored = map.calculateAnchoredCameraOptions({
        anchorLocation: around,
        anchorScreenPoint: map.project(around),
        zoom: options.zoom,
      });
      return originalEaseTo.call(map, { ...supportedOptions, ...anchored }, eventData);
    }
    return originalEaseTo.call(map, supportedOptions, eventData);
  };
  map.easeTo = easeTo;

  return () => {
    if (map.easeTo !== easeTo) return;
    if (previousDescriptor) Object.defineProperty(map, "easeTo", previousDescriptor);
    else Reflect.deleteProperty(map, "easeTo");
  };
}
