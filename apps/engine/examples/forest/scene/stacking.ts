import * as core from "@/packages/engine/src/scene/stacking";
import type { ForestObject, ObjectKind } from "./objects";
import { FOREST_CATALOG } from "../forest-catalog";
import { DEFAULT_FOLDERS, folderForKind, type SceneFolder } from "./folders";
import type { SceneLayer } from "@/packages/engine/src/scene/stacking";
export type { SceneLayer } from "@/packages/engine/src/scene/stacking";
export { MAX_SCENE_LAYERS, MAX_STACK_COMPONENTS, MAX_STACK_VALUE, DEFAULT_LAYERS, defaultLayers, objectLayerId, compareStackKeys, validStackKey, stackKeyBetween } from "@/packages/engine/src/scene/stacking";
export function objectDepth(object: ForestObject): number { return core.objectDepth(object, FOREST_CATALOG[object.kind]?.depthOffset); }
export function stackKey(object: ForestObject): readonly number[] { return core.stackKey(object, objectDepth(object)); }
export function isObjectVisible(object: ForestObject, layers: readonly SceneLayer[] = core.DEFAULT_LAYERS, folders: readonly SceneFolder[] = DEFAULT_FOLDERS): boolean {
  return core.isObjectVisible(object, layers, folders, kind => folderForKind(kind as ObjectKind));
}
export function isObjectLocked(object: ForestObject, layers: readonly SceneLayer[] = core.DEFAULT_LAYERS, folders: readonly SceneFolder[] = DEFAULT_FOLDERS): boolean {
  return core.isObjectLocked(object, layers, folders, kind => folderForKind(kind as ObjectKind));
}
