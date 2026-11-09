import { worldToScreen, type Camera, type Point, type VerticalCameraInsets, type Viewport } from "./camera";
import type { MapInteractiveObject, MapObjectPlace } from "./site-interactions";

export type MapObjectScreenAnchor = {
  objectId: string;
  place: MapObjectPlace;
  x: number;
  y: number;
  pointerOffset: number;
  below?: boolean;
  belowY?: number;
  sideX?: readonly [number, number];
  facadeY?: number;
};

/** The compact 80px pill sits within a real 98 × 44px touch target.
 * Project/cull the touch target, so invisible padding cannot cover the HUD. */
export const CONSTRUCTION_MARKER = { width: 98, height: 44, gap: 10, margin: 8 } as const;

const constructionPlaces: Readonly<Record<string, MapObjectPlace>> = {
  home: "house", warehouse: "house", workshop: "workshop", kiln: "workshop",
  garden: "garden", woodlot: "lopukh-home", quarry: "quarry", dryer: "campfire",
  bridge: "bridge", lighthouse: "lighthouse",
};
// Cache immutable authored geometry; panning and zooming only reproject it.
type Contour = { roof: Point; baseY: number };
const contours = new WeakMap<MapInteractiveObject["hitArea"], Contour>();

function markerContour(points: MapInteractiveObject["hitArea"]): Contour {
  const cached = contours.get(points);
  if (cached) return cached;
  let left = Infinity, right = -Infinity, top = Infinity, bottom = -Infinity;
  for (const { x, y } of points) {
    left = Math.min(left, x); right = Math.max(right, x);
    top = Math.min(top, y); bottom = Math.max(bottom, y);
  }
  const contour = { roof: { x: (left + right) / 2, y: top }, baseY: bottom };
  contours.set(points, contour);
  return contour;
}

/** Interior stations belong to their real map host; no invented coordinates. */
export function constructionMapPlace(stationId: string): MapObjectPlace | null {
  return Object.hasOwn(constructionPlaces, stationId) ? constructionPlaces[stationId] : null;
}

/** The active Tiled contour follows rotations and selected artwork levels. */
export function projectConstructionAnchor(object: MapInteractiveObject, camera: Camera, view: Viewport,
  insets: VerticalCameraInsets = { top: 0, bottom: 0 }, productionHeight?: number): MapObjectScreenAnchor | null {
  if (!object.hitArea.length) return null;
  const contour = markerContour(object.hitArea);
  const roof = worldToScreen(contour.roof, camera, view);
  const { width, gap, margin, height: minHeight } = CONSTRUCTION_MARKER;
  const requestedHeight = productionHeight ?? minHeight;
  const height = Number.isFinite(requestedHeight) ? Math.max(minHeight, requestedHeight) : minHeight;
  const safeTop = insets.top + margin, safeBottom = view.height - insets.bottom - margin;
  if (![roof.x, roof.y, view.width, view.height].every(Number.isFinite) || view.width < width + margin * 2
    || roof.x < 0 || roof.x > view.width || roof.y > safeBottom || Math.ceil(safeTop + height) > safeBottom) return null;
  const clampX = (center: number) => Math.round(Math.max(width / 2 + margin, Math.min(view.width - width / 2 - margin, center)));
  const x = clampX(roof.x);
  const anchor = { objectId: object.id, place: object.place, x, pointerOffset: Math.round(roof.x - x) || 0 };
  const y = Math.max(Math.round(roof.y - gap), Math.ceil(safeTop + height));
  if (productionHeight === undefined) return roof.y < safeTop ? null : { ...anchor, y };
  // The northern buildings can have their roofs behind the HUD while the entrance is on screen.
  // A running station can also use the clear space under its own facade when two roofs are close.
  const baseY = roof.y + (contour.baseY - contour.roof.y) * camera.zoom;
  const belowY = Math.ceil(baseY + gap + height);
  const fitsBelow = baseY >= safeTop + margin && belowY <= safeBottom;
  if (roof.y < safeTop && !fitsBelow) return null;
  // Side placements keep the pointer on the 80px pill and the full button on screen.
  const sideX: [number, number] = [clampX(roof.x - 30), clampX(roof.x + 30)];
  if (roof.y < safeTop) return { ...anchor, y: belowY, below: true, sideX, facadeY: Math.round(baseY) };
  return fitsBelow ? { ...anchor, y, belowY, sideX } : { ...anchor, y, sideX };
}
