/** World coordinates. Changing the camera must never move gameplay anchors. */
export const MAP_SIZE = 1536;
export const HOME_AREA = { x: 576, y: 576, size: 384 } as const;

type Point = { x: number; y: number };
type Bounds = { left: number; right: number; top: number; bottom: number };
export const MAP_PLACES = {
  house: {
    marker: { x: 847, y: 730 },
    // Normalized coordinates inside HOME_AREA, not world pixels.
    homeBounds: { left: .60, right: .93, top: .12, bottom: .49 },
  },
  workshop: {
    marker: { x: 414, y: 1020 },
    worldBounds: { left: 335, right: 500, top: 950, bottom: 1090 },
  },
  river: { marker: { x: 1090, y: 492 } },
  trail: { marker: { x: 1112, y: 1020 } },
} as const;

export const containsPoint = (point: Point, bounds: Bounds) =>
  point.x > bounds.left && point.x < bounds.right && point.y > bounds.top && point.y < bounds.bottom;

export const worldToHome = (point: Point): Point => ({
  x: (point.x - HOME_AREA.x) / HOME_AREA.size,
  y: (point.y - HOME_AREA.y) / HOME_AREA.size,
});
export const homeToWorld = (point: Point): Point => ({
  x: HOME_AREA.x + point.x * HOME_AREA.size,
  y: HOME_AREA.y + point.y * HOME_AREA.size,
});
