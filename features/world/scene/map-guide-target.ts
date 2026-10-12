import { clampCamera, worldToScreen, type Camera, type VerticalCameraInsets, type Viewport } from "./camera";
import type { MapInteractiveObject } from "./site-interactions";

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
  camera: Camera, view: Viewport) {
  if (object.hitArea.length < 3) return;
  const points = object.hitArea.map(point => worldToScreen(point, camera, view));
  context.save();
  context.beginPath();
  points.forEach((point, index) => index ? context.lineTo(point.x, point.y) : context.moveTo(point.x, point.y));
  context.closePath();
  context.lineJoin = "round";
  context.strokeStyle = "#183d27"; context.lineWidth = 9; context.stroke();
  context.strokeStyle = "#f7ffcb"; context.lineWidth = 5; context.stroke();
  context.strokeStyle = "#72ab4c"; context.lineWidth = 2; context.stroke();
  context.restore();
}
