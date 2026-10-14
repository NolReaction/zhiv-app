import type { EngineObject } from "./contracts.ts";

export type SceneFolder = { id: string; name: string; parentId: string | null; visible: boolean; locked: boolean };
export const MAX_SCENE_FOLDERS = 128;
export const DEFAULT_FOLDERS: readonly SceneFolder[] = Object.freeze([]);

export function defaultFolders(): SceneFolder[] { return DEFAULT_FOLDERS.map(folder => ({ ...folder })); }

export function folderForKind(kind: string): string { return kind; }

/** Undefined follows the kind's default group; null is an explicit root placement. */
export function objectFolderId(object: EngineObject, folders: readonly SceneFolder[] = DEFAULT_FOLDERS, defaultFolder: (kind: string) => string = folderForKind): string | null {
  if (object.folderId !== undefined) return object.folderId;
  const id = defaultFolder(object.kind);
  return folders.some(folder => folder.id === id) ? id : null;
}

/** Self first, followed by ancestors; invalid references and cycles fail closed. */
export function folderAncestors(id: string | null, folders: readonly SceneFolder[] = DEFAULT_FOLDERS): SceneFolder[] | null {
  const ancestors: SceneFolder[] = [], seen = new Set<string>();
  let current = id;
  while (current !== null) {
    const folder = folders.find(entry => entry.id === current);
    if (!folder || seen.has(current)) return null;
    ancestors.push(folder); seen.add(current); current = folder.parentId;
  }
  return ancestors;
}

export function isFolderVisible(id: string | null, folders: readonly SceneFolder[] = DEFAULT_FOLDERS): boolean {
  const ancestors = folderAncestors(id, folders);
  return ancestors !== null && ancestors.every(folder => folder.visible);
}

export function isFolderLocked(id: string | null, folders: readonly SceneFolder[] = DEFAULT_FOLDERS): boolean {
  const ancestors = folderAncestors(id, folders);
  return ancestors === null || ancestors.some(folder => folder.locked);
}

export function folderContains(parentId: string | null, childId: string | null, folders: readonly SceneFolder[] = DEFAULT_FOLDERS): boolean {
  const ancestors = folderAncestors(childId, folders);
  return ancestors !== null && (parentId === null || ancestors.some(folder => folder.id === parentId));
}
