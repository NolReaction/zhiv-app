export type Point = { x: number; y: number };
export type Camera = Point & { zoom: number };
export type Viewport = { width: number; height: number };
export const MAP_SIZE = 768;
export const HOME_AREA = { x: 192, y: 192, size: 384 };
export function zoomLimits(view: Viewport) {
  const minimum = Math.max(view.width, view.height) / MAP_SIZE;
  return { minimum, maximum: Math.max(minimum * 3, 4) };
}
export function clampCamera(camera: Camera, view: Viewport): Camera {
  const limits = zoomLimits(view);
  const zoom = Math.max(limits.minimum, Math.min(limits.maximum, camera.zoom));
  const halfX = view.width / zoom / 2, halfY = view.height / zoom / 2;
  return { zoom, x: Math.min(MAP_SIZE - halfX, Math.max(halfX, camera.x)), y: Math.min(MAP_SIZE - halfY, Math.max(halfY, camera.y)) };
}
export const screenToWorld = (point: Point, camera: Camera, view: Viewport): Point => ({ x: camera.x + (point.x - view.width / 2) / camera.zoom, y: camera.y + (point.y - view.height / 2) / camera.zoom });
export const worldToScreen = (point: Point, camera: Camera, view: Viewport): Point => ({ x: (point.x - camera.x) * camera.zoom + view.width / 2, y: (point.y - camera.y) * camera.zoom + view.height / 2 });
export function zoomAt(camera: Camera, view: Viewport, anchor: Point, factor: number) {
  const before = screenToWorld(anchor, camera, view), limits = zoomLimits(view);
  const zoom = Math.max(limits.minimum, Math.min(limits.maximum, camera.zoom * factor));
  return clampCamera({ zoom, x: before.x - (anchor.x - view.width / 2) / zoom, y: before.y - (anchor.y - view.height / 2) / zoom }, view);
}
export const homeCamera = (view: Viewport) => clampCamera({ x: 384, y: 382, zoom: Math.min(view.width, view.height) / 330 }, view);
export const isMapTap = (distance: number, multiTouch: boolean, cancelled: boolean) => !cancelled && !multiTouch && distance < 8;
