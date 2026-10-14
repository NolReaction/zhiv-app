import { DEFAULT_LAYERS, compareStackKeys, isObjectLocked, isObjectVisible, objectDepth, objectLayerId, stackKey, type SceneLayer } from "./stacking.ts";
import { DEFAULT_FOLDERS, type SceneFolder } from "./folders.ts";
import type { Bounds, EngineObject, ObjectCatalog } from "./contracts.ts";
export type { Bounds, EngineObject, ObjectCatalog } from "./contracts.ts";

const EMPTY_CATALOG: ObjectCatalog = Object.freeze({});
const radians = (degrees = 0) => degrees * Math.PI / 180;
export function objectLocalBounds(object: EngineObject, catalog: ObjectCatalog = EMPTY_CATALOG): Bounds {
  const bounds = catalog[object.kind]?.bounds;
  if (typeof bounds === 'function') return bounds(object);
  return bounds ?? { x: -(object.imageWidth ?? 1) / 2, y: -(object.imageHeight ?? 1), width: object.imageWidth ?? 1, height: object.imageHeight ?? 1 };
}
export function getObjectShadowHeight(object: EngineObject, catalog: ObjectCatalog = EMPTY_CATALOG): number {
  return (object.shadowHeight ?? catalog[object.kind]?.shadowHeight ?? 0) * object.scale;
}
export function objectAngle(object: EngineObject, catalog: ObjectCatalog = EMPTY_CATALOG): number {
  return radians(object.rotation) + (catalog[object.kind]?.intrinsicAngle ?? 0);
}
export function objectCorners(object: EngineObject, catalog: ObjectCatalog = EMPTY_CATALOG): { x: number; y: number }[] {
  const local = objectLocalBounds(object, catalog), angle = objectAngle(object, catalog);
  const cosine = Math.cos(angle) * object.scale, sine = Math.sin(angle) * object.scale;
  return [[local.x, local.y], [local.x + local.width, local.y], [local.x + local.width, local.y + local.height], [local.x, local.y + local.height]]
    .map(([x, y]) => ({ x: object.x + x * cosine - y * sine, y: object.y + x * sine + y * cosine }));
}
export function objectBounds(object: EngineObject, catalog: ObjectCatalog = EMPTY_CATALOG): Bounds {
  const corners = objectCorners(object, catalog), x = Math.min(...corners.map(point => point.x)), y = Math.min(...corners.map(point => point.y));
  return { x, y, width: Math.max(...corners.map(point => point.x)) - x, height: Math.max(...corners.map(point => point.y)) - y };
}
export function compareObjects(a: EngineObject, b: EngineObject, layers: readonly SceneLayer[] = DEFAULT_LAYERS, catalog: ObjectCatalog = EMPTY_CATALOG): number {
  const layerA = objectLayerId(a), layerB = objectLayerId(b);
  const layerOrder = layerA === layerB ? 0 : layers.findIndex(layer => layer.id === layerA) - layers.findIndex(layer => layer.id === layerB);
  if (layerOrder) return layerOrder;
  const depthA = objectDepth(a, catalog[a.kind]?.depthOffset), depthB = objectDepth(b, catalog[b.kind]?.depthOffset);
  const order = !a.stackOrder && !b.stackOrder ? depthA - depthB || a.x - b.x : compareStackKeys(stackKey(a, depthA), stackKey(b, depthB));
  return order || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}
export function pickObject<T extends EngineObject>(objects: readonly T[], x: number, y: number, layers: readonly SceneLayer[] = DEFAULT_LAYERS,
  folders: readonly SceneFolder[] = DEFAULT_FOLDERS, catalog: ObjectCatalog = EMPTY_CATALOG): T | undefined {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return;
  const folder = (kind: string) => catalog[kind]?.folderId ?? kind;
  const ordered = objects.filter(object => isObjectVisible(object, layers, folders, folder) && !isObjectLocked(object, layers, folders, folder)).sort((a, b) => compareObjects(a, b, layers, catalog));
  for (let i = ordered.length - 1; i >= 0; i--) {
    const object = ordered[i]; if (!Number.isFinite(object.scale) || object.scale <= 0) continue;
    const angle = objectAngle(object, catalog), dx = (x - object.x) / object.scale, dy = (y - object.y) / object.scale;
    const local = { x: dx * Math.cos(angle) + dy * Math.sin(angle), y: -dx * Math.sin(angle) + dy * Math.cos(angle) };
    const hit = catalog[object.kind]?.hitTest;
    if (hit ? hit(object, local) : (() => { const bounds = objectLocalBounds(object, catalog); return local.x >= bounds.x && local.x <= bounds.x + bounds.width && local.y >= bounds.y && local.y <= bounds.y + bounds.height; })()) return object;
  }
}
