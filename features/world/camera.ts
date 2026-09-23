export type Point = { x: number; y: number };
export type Camera = Point & { zoom: number };
export type Viewport = { width: number; height: number };
import { MAP_SIZE, HOME_AREA } from "./map-layout";
export { MAP_SIZE, HOME_AREA } from "./map-layout";
const legacyBounds: Viewport = { width: MAP_SIZE, height: MAP_SIZE };
export function zoomLimits(view: Viewport, bounds: Viewport = legacyBounds) {
  // Contain, rather than cover: portrait screens must be able to see both edges.
  const minimum = Math.min(view.width / bounds.width, view.height / bounds.height);
  return { minimum, maximum: Math.max(minimum * 3, 4) };
}
export function clampCamera(camera: Camera, view: Viewport, bounds: Viewport = legacyBounds): Camera {
  const limits = zoomLimits(view, bounds);
  const zoom = Math.max(limits.minimum, Math.min(limits.maximum, camera.zoom));
  const halfX = view.width / zoom / 2, halfY = view.height / zoom / 2;
  const axis = (value: number, half: number, size: number) => half >= size / 2 ? size / 2 : Math.min(size - half, Math.max(half, value));
  return { zoom, x: axis(camera.x, halfX, bounds.width), y: axis(camera.y, halfY, bounds.height) };
}
export const screenToWorld = (point: Point, camera: Camera, view: Viewport): Point => ({ x: camera.x + (point.x - view.width / 2) / camera.zoom, y: camera.y + (point.y - view.height / 2) / camera.zoom });
export const worldToScreen = (point: Point, camera: Camera, view: Viewport): Point => ({ x: (point.x - camera.x) * camera.zoom + view.width / 2, y: (point.y - camera.y) * camera.zoom + view.height / 2 });
export function zoomAt(camera: Camera, view: Viewport, anchor: Point, factor: number, bounds: Viewport = legacyBounds) {
  const before = screenToWorld(anchor, camera, view), limits = zoomLimits(view, bounds);
  const zoom = Math.max(limits.minimum, Math.min(limits.maximum, camera.zoom * factor));
  return clampCamera({ zoom, x: before.x - (anchor.x - view.width / 2) / zoom, y: before.y - (anchor.y - view.height / 2) / zoom }, view, bounds);
}
export const homeCamera = (view: Viewport) => clampCamera({ x: HOME_AREA.x + HOME_AREA.size / 2, y: HOME_AREA.y + HOME_AREA.size / 2, zoom: Math.min(view.width, view.height) / HOME_AREA.size }, view);
// The world opens five home clearings wide; the circle keeps its detailed crop.
export const worldCamera = (view: Viewport) => clampCamera({ x: HOME_AREA.x + HOME_AREA.size / 2, y: HOME_AREA.y + HOME_AREA.size / 2, zoom: Math.min(view.width, view.height) / (HOME_AREA.size * 5) }, view);
export const overviewCamera = (view: Viewport, bounds: Viewport = legacyBounds) => clampCamera({ x: bounds.width / 2, y: bounds.height / 2, zoom: zoomLimits(view, bounds).minimum }, view, bounds);
export const isMapTap = (distance: number, multiTouch: boolean, cancelled: boolean) => !cancelled && !multiTouch && distance < 8;
export const viewportPoint = (client: Point, rect: { left: number; top: number; width: number; height: number }, view: Viewport): Point => ({
  x: (client.x - rect.left) * view.width / Math.max(1, rect.width),
  y: (client.y - rect.top) * view.height / Math.max(1, rect.height),
});
