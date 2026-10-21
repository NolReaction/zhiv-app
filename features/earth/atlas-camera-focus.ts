import { earthAtlasEntry } from "./earth-atlas";
import { earthModelCamera, type EarthModelCameraViewport } from "./model-camera";
import { getEarthModelDefinition } from "./landmark-model-registry";
import { getEarthModelPlacements } from "./model-placement";
import { EARTH_MODEL_PREVIEW_MIN_ZOOM } from "./landmark-model-view";

export type EarthAtlasCamera = {
  center: [number, number]; zoom: number; pitch: number; bearing: number; offset: [number, number];
};
const mercatorY = (latitude: number) => (1 - Math.log(Math.tan(Math.PI / 4
  + Math.max(-85, Math.min(85, latitude)) * Math.PI / 360)) / Math.PI) / 2;

/** Resolve only public catalogue targets. A camera flight never records a discovery. */
export function earthAtlasCameraFocus(entryId: string, viewport: EarthModelCameraViewport): EarthAtlasCamera | null {
  const entry = earthAtlasEntry(entryId), { width, height, available } = viewport;
  const padding = viewport.padding ?? {};
  if (!entry?.center || !entry.focus || ![width, height, viewport.verticalFieldOfView,
    ...Object.values(available), ...Object.values(padding)].every(Number.isFinite)
    || width <= 0 || height <= 0 || available.right <= available.left || available.bottom <= available.top
    || available.left < 0 || available.top < 0 || available.right > width || available.bottom > height
    || Object.values(padding).some(value => value < 0)) return null;
  if (entry.focus.kind === "model") {
    const modelId = entry.focus.modelId;
    const placement = getEarthModelPlacements().find(item => item.id === modelId);
    if (!placement || !getEarthModelDefinition(placement.id)) return null;
    const options = { maxZoom: 18, pitches: [50, 45, 35, 30, 25, 20, 15], radialSegments: 16, marginRatio: .06 };
    const streetCamera = earthModelCamera(placement, viewport, options);
    // Very broad monuments (the Giza complex or the Wall) cannot fit a phone
    // at the ordinary street LOD. Only their explicit inspection uses a wider
    // camera while the renderer keeps that selected model in full detail.
    const camera = streetCamera.fits ? streetCamera : earthModelCamera(placement, viewport, { ...options, minZoom: EARTH_MODEL_PREVIEW_MIN_ZOOM });
    if (!camera.fits) return null;
    return { center: camera.center, zoom: camera.zoom, pitch: camera.pitch, offset: camera.offset,
      bearing: ((placement.headingDegrees - 25) % 360 + 360) % 360 };
  }
  const [west, south, east, north] = entry.focus.bounds;
  const dx = Math.max(Math.abs(west - entry.center[0]), Math.abs(east - entry.center[0])) / 360;
  const cy = mercatorY(entry.center[1]);
  const dy = Math.max(Math.abs(mercatorY(south) - cy), Math.abs(mercatorY(north) - cy));
  const zoom = Math.log2(Math.min((available.right - available.left) * .86 / (1024 * Math.max(dx, 1e-6)),
    (available.bottom - available.top) * .86 / (1024 * Math.max(dy, 1e-6))));
  const origin = [(width + (padding.left ?? 0) - (padding.right ?? 0)) / 2,
    (height + (padding.top ?? 0) - (padding.bottom ?? 0)) / 2];
  return { center: [...entry.center], zoom: Math.max(2.2, Math.min(4.8, zoom)), pitch: 0, bearing: 0,
    offset: [(available.left + available.right) / 2 - origin[0], (available.top + available.bottom) / 2 - origin[1]] };
}
