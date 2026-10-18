import { clampCamera, worldToScreen, type Camera, type VerticalCameraInsets, type Viewport } from "./camera";
import type { MapInteractiveObject } from "./site-interactions";

/** Camera framing follows the resident's full body, including his helmet. */
export function minerArrivalGuideTarget(point: { x: number; y: number; size: number }): MapInteractiveObject | undefined {
  if (![point.x, point.y, point.size].every(Number.isFinite) || point.size <= 0) return;
  const radius = point.size * .7, top = point.y - point.size * 1.1, bottom = point.y + point.size * .12;
  return { id: "kamneshmyg-arrival", place: "quarry", kind: "site", label: "Камнешмыг",
    anchor: { x: point.x, y: point.y - point.size * .5 }, hitArea: [
      { x: point.x - radius, y: top }, { x: point.x + radius, y: top },
      { x: point.x + radius, y: bottom }, { x: point.x - radius, y: bottom },
    ] };
}

export function leaftailArrivalGuideTarget(point: { x: number; y: number; size: number }): MapInteractiveObject | undefined {
  const target = minerArrivalGuideTarget(point);
  return target ? { ...target, id: "leaftail-arrival", place: "leaftail-caravan", label: "Листохвост" } : undefined;
}

/** Frame the current artwork's authored contour without selecting or opening it. */
export function mapGuideCamera(object: MapInteractiveObject, view: Viewport, bounds: Viewport,
  insets: VerticalCameraInsets): Camera {
  const points = object.hitArea.length ? object.hitArea : [object.anchor];
  const xs = points.map(point => point.x), ys = points.map(point => point.y);
  const left = Math.min(...xs), right = Math.max(...xs), top = Math.min(...ys), bottom = Math.max(...ys);
  const availableHeight = Math.max(64, view.height - insets.top - insets.bottom);
  const zoom = Math.min(3, view.width * .65 / Math.max(44, right - left), availableHeight * .65 / Math.max(44, bottom - top));
  const visibleCenterY = insets.top + availableHeight / 2;
  return clampCamera({ x: (left + right) / 2, y: (top + bottom) / 2 - (visibleCenterY - view.height / 2) / zoom, zoom }, view, bounds, insets);
}

/** Paint in screen pixels so the contour stays legible while the player pans or pinches. */
export function drawMapGuideTarget(context: CanvasRenderingContext2D, object: MapInteractiveObject,
  camera: Camera, view: Viewport, elapsedSeconds = 0, reducedMotion = false) {
  // Arrival geometry remains available to the camera and hit handling; a box
  // around a living neighbour is deliberately not painted.
  if (["kamneshmyg-arrival", "leaftail-arrival"].includes(object.id) || object.hitArea.length < 3) return;
  const points = object.hitArea.map(point => worldToScreen(point, camera, view));
  context.save();
  context.beginPath();
  points.forEach((point, index) => index ? context.lineTo(point.x, point.y) : context.moveTo(point.x, point.y));
  context.closePath();
  context.lineJoin = "round";
  context.strokeStyle = "#183d27"; context.lineWidth = 9; context.stroke();
  // Reuse the scene's active clock and paint loop. The authored path and its
  // dark backing remain stable; only the two bright strokes gently pulse.
  if (!reducedMotion) context.globalAlpha *= .775 + .225 * Math.cos((Number.isFinite(elapsedSeconds) ? elapsedSeconds : 0) * Math.PI * 2 / 1.8);
  context.strokeStyle = "#f7ffcb"; context.lineWidth = 5; context.stroke();
  context.strokeStyle = "#72ab4c"; context.lineWidth = 2; context.stroke();
  context.restore();
}
