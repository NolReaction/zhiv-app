import * as core from "@/packages/engine/src/scene/folders";
import type { ForestObject, ObjectKind } from "./objects";
import type { SceneFolder } from "@/packages/engine/src/scene/folders";
export type { SceneFolder } from "@/packages/engine/src/scene/folders";
export { MAX_SCENE_FOLDERS } from "@/packages/engine/src/scene/folders";
export const DEFAULT_FOLDERS: readonly SceneFolder[] = Object.freeze([
  Object.freeze({ id: "trees", name: "Деревья", parentId: null, visible: true, locked: false }),
  Object.freeze({ id: "shrubs", name: "Кусты", parentId: null, visible: true, locked: false }),
  Object.freeze({ id: "rocks", name: "Камни", parentId: null, visible: true, locked: false }),
  Object.freeze({ id: "props", name: "Постройки", parentId: null, visible: true, locked: false }),
  Object.freeze({ id: "images", name: "Изображения", parentId: null, visible: true, locked: false }),
]);

export function defaultFolders(): SceneFolder[] { return DEFAULT_FOLDERS.map(folder => ({ ...folder })); }

export function folderForKind(kind: ObjectKind): string {
  return ({ tree: "trees", shrub: "shrubs", rock: "rocks", ruins: "props", bridge: "props", jetty: "props", image: "images" })[kind];
}

export function objectFolderId(object: ForestObject, folders: readonly SceneFolder[] = DEFAULT_FOLDERS): string | null { return core.objectFolderId(object, folders, kind => folderForKind(kind as ObjectKind)); }

export const folderAncestors = (id: string | null, folders: readonly SceneFolder[] = DEFAULT_FOLDERS) => core.folderAncestors(id, folders);
export const isFolderVisible = (id: string | null, folders: readonly SceneFolder[] = DEFAULT_FOLDERS) => core.isFolderVisible(id, folders);
export const isFolderLocked = (id: string | null, folders: readonly SceneFolder[] = DEFAULT_FOLDERS) => core.isFolderLocked(id, folders);
export const folderContains = (parentId: string | null, childId: string | null, folders: readonly SceneFolder[] = DEFAULT_FOLDERS) => core.folderContains(parentId, childId, folders);
