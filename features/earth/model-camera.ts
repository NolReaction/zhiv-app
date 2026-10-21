import { getEarthModelDefinition } from "./landmark-model-registry";
import type { EarthModelPlacement } from "./model-placement";
import type { PaddingOptions } from "maplibre-gl";

export type EarthModelCameraViewport = {
  width: number; height: number; verticalFieldOfView: number;
  available: { left: number; top: number; right: number; bottom: number };
  padding?: Partial<PaddingOptions>;
};

/** Frame the complete raised silhouette in the available map area.
 * Ground-only fitBounds cannot account for an imported model's height. */
export function earthModelCamera(placement: EarthModelPlacement, viewport: EarthModelCameraViewport,
  options: { minZoom?: number; maxZoom?: number; pitches?: readonly number[]; radialSegments?: number; marginRatio?: number } = {}) {
  const { width, height, available } = viewport;
  const usableWidth = Math.max(80, available.right - available.left);
  const usableHeight = Math.max(100, available.bottom - available.top);
  const definition = getEarthModelDefinition(placement.id), normalized = definition?.normalizedBounds;
  const radius = normalized ? Math.hypot(Math.max(Math.abs(normalized.min[0]), Math.abs(normalized.max[0])),
    Math.max(Math.abs(normalized.min[1]), Math.abs(normalized.max[1]))) * placement.heightMeters : placement.heightMeters * .35;
  // A radial envelope keeps every heading and current camera bearing inside
  // the fit. Its front ground corners need space below the base as well as the
  // roof above it; fitting height alone crops wide pyramids and low buildings.
  const envelope = definition?.framingBands ?? [{ minZ: 0, maxZ: 1, radius: radius / placement.heightMeters }];
  const segments = options.radialSegments ?? 4;
  const corners = envelope.flatMap(band => {
    const bandRadius = band.radius * placement.heightMeters;
    // Preserve the editor's exactly symmetric square. Computing its four
    // corners with sin/cos introduces a tiny horizontal drift in a centred fit.
    if (segments === 4) return [-bandRadius, bandRadius].flatMap(x => [-bandRadius, bandRadius].flatMap(y =>
      [band.minZ, band.maxZ].map(z => [x, y, placement.elevationMeters + z * placement.heightMeters] as const)));
    // Circumscribe the radial band, never inscribe it: every heading and any
    // triangle crossing that slab remain inside the envelope. More sides keep
    // an atlas close-up from wasting space on the old square's empty corners.
    const radius = bandRadius / Math.cos(Math.PI / segments);
    return Array.from({ length: segments }, (_, index) => (index + .5) * 2 * Math.PI / segments)
      .flatMap(angle => [band.minZ, band.maxZ].map(z => [Math.cos(angle) * radius, Math.sin(angle) * radius,
        placement.elevationMeters + z * placement.heightMeters] as const));
  });
  const fieldOfView = Math.max(20, Math.min(60, viewport.verticalFieldOfView)) * Math.PI / 180;
  const cameraDistancePixels = height / (2 * Math.tan(fieldOfView / 2));
  const metresAtZoomZero = 40_030_228.884 * Math.cos(placement.latitude * Math.PI / 180) / 512;
  const target = [(available.left + available.right) / 2, (available.top + available.bottom) / 2];
  // Public MapLibre padding changes the principal point of its perspective
  // matrix. flyTo offset is measured from that point, not the full canvas.
  const origin = [(width + (viewport.padding?.left ?? 0) - (viewport.padding?.right ?? 0)) / 2,
    (height + (viewport.padding?.top ?? 0) - (viewport.padding?.bottom ?? 0)) / 2];
  const horizontalMargin = Math.max(10, usableWidth * (options.marginRatio ?? .07));
  const verticalMargin = Math.max(10, usableHeight * (options.marginRatio ?? .07));
  function frame(zoom: number, angle: number) {
    const radians = angle * Math.PI / 180, sine = Math.sin(radians), cosine = Math.cos(radians);
    const metresPerPixel = metresAtZoomZero / 2 ** zoom, distance = cameraDistancePixels * metresPerPixel;
    const offset: [number, number] = [target[0] - origin[0], target[1] - origin[1]];
    let bounds = { left: 0, right: 0, top: 0, bottom: 0 };
    // MapLibre positions the ground anchor at centerPoint + offset. Reproject
    // the whole envelope after each offset correction: at a high pitch the
    // offset also changes perspective, so translating a height estimate fails.
    for (let pass = 0; pass < 12; pass++) {
      const denominator = cameraDistancePixels * cosine + offset[1] * sine;
      if (denominator <= 0) return null;
      const anchorY = -offset[1] * distance / denominator;
      const anchorX = offset[0] * distance * cosine / denominator;
      const points = corners.map(([x, y, z]) => {
        const depth = distance + (y + anchorY) * sine - z * cosine;
        // MapLibre's near plane is height/50 world pixels. Keep a further
        // margin here so a fully framed roof cannot be clipped by that plane.
        return depth > height / 40 * metresPerPixel ? [origin[0] + cameraDistancePixels * (x + anchorX) / depth,
          origin[1] - cameraDistancePixels * ((y + anchorY) * cosine + z * sine) / depth] : null;
      });
      if (points.some(point => point === null)) return null;
      const visible = points as number[][];
      bounds = { left: Math.min(...visible.map(point => point[0])), right: Math.max(...visible.map(point => point[0])),
        top: Math.min(...visible.map(point => point[1])), bottom: Math.max(...visible.map(point => point[1])) };
      const dx = target[0] - (bounds.left + bounds.right) / 2, dy = target[1] - (bounds.top + bounds.bottom) / 2;
      if (Math.max(Math.abs(dx), Math.abs(dy)) < .01) break;
      offset[0] += dx; offset[1] += dy;
    }
    return { zoom, pitch: angle, offset, fits: bounds.left >= available.left + horizontalMargin
      && bounds.right <= available.right - horizontalMargin && bounds.top >= available.top + verticalMargin
      && bounds.bottom <= available.bottom - verticalMargin };
  }
  const minZoom = options.minZoom ?? 15.6;
  let result = frame(minZoom, 30) ?? { zoom: minZoom, pitch: 30,
    offset: [target[0] - origin[0], target[1] - origin[1]] as [number, number], fits: false };
  // Choose the steepest useful angle, then the closest zoom that fits the
  // complete envelope. The ordinary editor keeps the full street-model LOD;
  // an explicit atlas inspection may opt into a wider selected-model view.
  for (const angle of options.pitches ?? [55, 45, 35, 30]) {
    const minimum = frame(minZoom, angle);
    if (!minimum?.fits) continue;
    let lower = minZoom, upper = options.maxZoom ?? 19;
    for (let step = 0; step < 22; step++) {
      const middle = (lower + upper) / 2;
      if (frame(middle, angle)?.fits) lower = middle; else upper = middle;
    }
    result = frame(lower, angle)!;
    break;
  }
  return {
    center: [placement.longitude, placement.latitude] as [number, number],
    zoom: result.zoom, pitch: result.pitch, offset: result.offset, fits: result.fits,
  };
}
