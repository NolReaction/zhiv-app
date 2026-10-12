import { worldToScreen, type Camera, type VerticalCameraInsets, type Viewport } from "./camera";
import type { MapInteractiveObject, MapObjectPlace } from "./site-interactions";

export type MapObjectScreenAnchor = {
  objectId: string;
  place: MapObjectPlace;
  x: number;
  y: number;
  pointerOffset: number;
};

/** Screen-pixel dimensions keep a timer readable at every map zoom. */
export const CONSTRUCTION_MARKER = { width: 124, height: 44, gap: 10, margin: 8 } as const;

const constructionPlaces: Readonly<Record<string, MapObjectPlace>> = {
  home: "house", warehouse: "house", workshop: "workshop", kiln: "workshop",
  garden: "garden", woodlot: "woodlot", quarry: "quarry", dryer: "campfire",
};

/** Interior stations belong to their real map host; no invented coordinates. */
export function constructionMapPlace(stationId: string): MapObjectPlace | null {
  return Object.hasOwn(constructionPlaces, stationId) ? constructionPlaces[stationId] : null;
}

/** The active Tiled contour follows rotations and selected artwork levels. */
export function projectConstructionAnchor(object: MapInteractiveObject, camera: Camera, view: Viewport,
  insets: VerticalCameraInsets = { top: 0, bottom: 0 }): MapObjectScreenAnchor | null {
  if (!object.hitArea.length) return null;
  const xs = object.hitArea.map(point => point.x), ys = object.hitArea.map(point => point.y);
  const roof = worldToScreen({ x: (Math.min(...xs) + Math.max(...xs)) / 2, y: Math.min(...ys) }, camera, view);
  const { width, height, gap, margin } = CONSTRUCTION_MARKER;
  const y = Math.round(roof.y - gap);
  // Do not pin an offscreen building's timer to the HUD or to another building.
  if (![roof.x, roof.y, view.width, view.height].every(Number.isFinite) || view.width < width + margin * 2
    || roof.x < 0 || roof.x > view.width || y - height < insets.top + margin
    || roof.y > view.height - insets.bottom - margin) return null;
  const x = Math.round(Math.max(width / 2 + margin, Math.min(view.width - width / 2 - margin, roof.x)));
  return { objectId: object.id, place: object.place, x, y, pointerOffset: Math.round(roof.x - x) || 0 };
}
