import { objectAngle, objectCorners, objectLocalBounds } from "../scene/objects.ts";
import type { EngineObject, ObjectCatalog } from "../scene/contracts.ts";

export type ResizePoint = { x: number; y: number };
/** Clockwise: top-left, top-right, bottom-right, bottom-left in object coordinates. */
export type ResizeCorner = 0 | 1 | 2 | 3;
export const MIN_OBJECT_SCALE = .1;
export const MAX_OBJECT_SCALE = 8;
export const RESIZE_HANDLE_RADIUS = 14;

export type ResizeSession = {
  readonly object: EngineObject;
  readonly catalog?: ObjectCatalog;
  readonly corner: ResizeCorner;
  readonly fixedCorner: ResizePoint;
  readonly oppositeLocal: ResizePoint;
  /** The unscaled corner-to-corner diagonal, rotated into world coordinates. */
  readonly diagonal: ResizePoint;
  readonly angle: number;
  readonly grabOffset: ResizePoint;
};

export function resizeHandlePositions(object: EngineObject, catalog?: ObjectCatalog): ResizePoint[] {
  return objectCorners(object, catalog);
}

/** Hit areas remain the same CSS-pixel size at every camera zoom and device density. */
export function findResizeHandle(object: EngineObject, point: ResizePoint, zoom: number, radiusCss = RESIZE_HANDLE_RADIUS, catalog?: ObjectCatalog): ResizeCorner | null {
  if (!Number.isFinite(point.x) || !Number.isFinite(point.y) || !Number.isFinite(zoom) || zoom <= 0
    || !Number.isFinite(radiusCss) || radiusCss < 0) return null;
  const bounds = objectLocalBounds(object, catalog);
  if (Math.min(bounds.width, bounds.height) * object.scale * zoom < radiusCss * 2) {
    const angle = objectAngle(object, catalog), dx = (point.x - object.x) / object.scale, dy = (point.y - object.y) / object.scale;
    const localX = dx * Math.cos(angle) + dy * Math.sin(angle), localY = -dx * Math.sin(angle) + dy * Math.cos(angle);
    // Overlapping enlarged corner targets leave a central area available for moving tiny objects.
    if (localX >= bounds.x + bounds.width * .35 && localX <= bounds.x + bounds.width * .65
      && localY >= bounds.y + bounds.height * .35 && localY <= bounds.y + bounds.height * .65) return null;
  }
  let nearest: ResizeCorner | null = null, distance = (radiusCss / zoom) ** 2;
  resizeHandlePositions(object, catalog).forEach((corner, index) => {
    const squared = (point.x - corner.x) ** 2 + (point.y - corner.y) ** 2;
    if (squared <= distance && (nearest === null || squared < distance)) {
      nearest = index as ResizeCorner;
      distance = squared;
    }
  });
  return nearest;
}

function rotate(point: ResizePoint, angle: number): ResizePoint {
  const cosine = Math.cos(angle), sine = Math.sin(angle);
  return { x: point.x * cosine - point.y * sine, y: point.x * sine + point.y * cosine };
}

export function beginResize(object: EngineObject, corner: ResizeCorner, grab: ResizePoint, catalog?: ObjectCatalog): ResizeSession {
  const bounds = objectLocalBounds(object, catalog), angle = objectAngle(object, catalog);
  const local = [
    { x: bounds.x, y: bounds.y }, { x: bounds.x + bounds.width, y: bounds.y },
    { x: bounds.x + bounds.width, y: bounds.y + bounds.height }, { x: bounds.x, y: bounds.y + bounds.height },
  ];
  const oppositeLocal = local[(corner + 2) % 4], handleLocal = local[corner];
  const corners = resizeHandlePositions(object, catalog), handle = corners[corner];
  return {
    object: { ...object }, corner, angle, oppositeLocal: { ...oppositeLocal },
    fixedCorner: { ...corners[(corner + 2) % 4] },
    diagonal: rotate({ x: handleLocal.x - oppositeLocal.x, y: handleLocal.y - oppositeLocal.y }, angle),
    grabOffset: { x: grab.x - handle.x, y: grab.y - handle.y },
  };
}

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

/** Uniform resize keeps the opposite corner fixed, including when its anchor reaches a world edge. */
export function resizedObject(session: ResizeSession, pointer: ResizePoint, worldWidth: number, worldHeight: number): EngineObject {
  const { diagonal, fixedCorner, grabOffset, oppositeLocal, angle } = session;
  const lengthSquared = diagonal.x ** 2 + diagonal.y ** 2;
  if (!Number.isFinite(pointer.x) || !Number.isFinite(pointer.y) || !Number.isFinite(lengthSquared) || lengthSquared <= 0
    || !Number.isFinite(worldWidth) || !Number.isFinite(worldHeight) || worldWidth < 0 || worldHeight < 0) return { ...session.object };
  const target = { x: pointer.x - grabOffset.x - fixedCorner.x, y: pointer.y - grabOffset.y - fixedCorner.y };
  const projectedScale = (target.x * diagonal.x + target.y * diagonal.y) / lengthSquared;
  const opposite = rotate(oppositeLocal, angle);
  let minimum = MIN_OBJECT_SCALE, maximum = MAX_OBJECT_SCALE;
  for (const [anchor, local, limit] of [[session.object.x, opposite.x, worldWidth], [session.object.y, opposite.y, worldHeight]]) {
    if (local === 0) {
      if (anchor < 0 || anchor > limit) return { ...session.object };
      continue;
    }
    // Equivalent to fixed/local, but avoids cancellation in a large world coordinate.
    const atZero = session.object.scale + anchor / local, atLimit = session.object.scale + (anchor - limit) / local;
    minimum = Math.max(minimum, Math.min(atZero, atLimit));
    maximum = Math.min(maximum, Math.max(atZero, atLimit));
  }
  if (minimum > maximum) return { ...session.object };
  let scale = clamp(projectedScale, minimum, maximum);
  if (Math.abs(scale - session.object.scale) <= Number.EPSILON * Math.max(1, scale, session.object.scale) * 8) return { ...session.object };
  // Reconstruct from the original anchor to retain exact coordinates for a stationary pointer.
  const anchorAt = (candidate: number) => ({
    x: session.object.x + (session.object.scale - candidate) * opposite.x,
    y: session.object.y + (session.object.scale - candidate) * opposite.y,
  });
  let anchor = anchorAt(scale);
  if (anchor.x < 0 || anchor.x > worldWidth || anchor.y < 0 || anchor.y > worldHeight) {
    // Division/multiplication can put a boundary result a few ulps outside; nudge scale inward.
    const correction = Math.sign(session.object.scale - scale) * Number.EPSILON * Math.max(1, scale) * 8;
    scale = clamp(scale + correction, Math.min(scale, session.object.scale), Math.max(scale, session.object.scale));
    anchor = anchorAt(scale);
  }
  return {
    ...session.object, scale, ...anchor,
  };
}
