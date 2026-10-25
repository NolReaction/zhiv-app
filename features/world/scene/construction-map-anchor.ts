import { worldToScreen, type Camera, type Point, type VerticalCameraInsets, type Viewport } from "./camera";
import type { MapInteractiveObject, MapObjectPlace } from "./site-interactions";

export type MapObjectScreenAnchor = {
  objectId: string;
  place: MapObjectPlace;
  x: number;
  y: number;
  pointerOffset: number;
};

/** The compact 80px pill sits within a real 98 × 44px touch target.
 * Project/cull the touch target, so invisible padding cannot cover the HUD. */
export const CONSTRUCTION_MARKER = { width: 98, height: 44, gap: 10, margin: 8 } as const;

const constructionPlaces: Readonly<Record<string, MapObjectPlace>> = {
  home: "house", warehouse: "house", workshop: "workshop", kiln: "workshop",
  garden: "garden", woodlot: "lopukh-home", quarry: "quarry", dryer: "campfire",
  bridge: "bridge", lighthouse: "lighthouse",
};
// Tiled/preview contours are immutable: selecting a different building level or
// applying a studio draft replaces the contour. Camera motion changes only its
// screen projection, so retain its world-space roof without rescanning points.
const contourRoofs = new WeakMap<MapInteractiveObject["hitArea"], Point>();

function contourRoof(points: MapInteractiveObject["hitArea"]): Point {
  let roof = contourRoofs.get(points);
  if (!roof) {
    let left = Infinity, right = -Infinity, top = Infinity;
    for (const point of points) {
      left = Math.min(left, point.x); right = Math.max(right, point.x); top = Math.min(top, point.y);
    }
    roof = { x: (left + right) / 2, y: top };
    contourRoofs.set(points, roof);
  }
  return roof;
}

/** Interior stations belong to their real map host; no invented coordinates. */
export function constructionMapPlace(stationId: string): MapObjectPlace | null {
  return Object.hasOwn(constructionPlaces, stationId) ? constructionPlaces[stationId] : null;
}

/** The active Tiled contour follows rotations and selected artwork levels. */
export function projectConstructionAnchor(object: MapInteractiveObject, camera: Camera, view: Viewport,
  insets: VerticalCameraInsets = { top: 0, bottom: 0 }, markerHeight: number = CONSTRUCTION_MARKER.height): MapObjectScreenAnchor | null {
  if (!object.hitArea.length) return null;
  const roof = worldToScreen(contourRoof(object.hitArea), camera, view);
  const { width, gap, margin } = CONSTRUCTION_MARKER;
  const height = Number.isFinite(markerHeight) ? Math.max(CONSTRUCTION_MARKER.height, markerHeight) : CONSTRUCTION_MARKER.height;
  const safeTop = insets.top + margin, safeBottom = view.height - insets.bottom - margin;
  // Do not pin an offscreen building's timer to the HUD or to another building.
  if (![roof.x, roof.y, view.width, view.height].every(Number.isFinite) || view.width < width + margin * 2
    || roof.x < 0 || roof.x > view.width || roof.y < safeTop || roof.y > safeBottom) return null;
  // In the overview, northern roofs can remain visible with less than a pill's
  // height above them. Keep their full touch target in the map instead of
  // dropping the timer; a roof behind the HUD still never receives a marker.
  const y = Math.max(Math.round(roof.y - gap), Math.ceil(safeTop + height));
  if (y > safeBottom) return null;
  const x = Math.round(Math.max(width / 2 + margin, Math.min(view.width - width / 2 - margin, roof.x)));
  return { objectId: object.id, place: object.place, x, y, pointerOffset: Math.round(roof.x - x) || 0 };
}
