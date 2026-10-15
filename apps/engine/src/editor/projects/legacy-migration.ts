import { createProjectId, parseProjectDocument } from "../scene/project-document";
import { SCENE_STORAGE_KEY } from "../scene/editor-scene";
import type { ProjectRepository } from "./project-repository";

type LegacyStorage = { getItem(key: string): string | null };

/** Retain the old JSON even after success. The durable IndexedDB marker prevents
 * duplicates; no failed parse, quota error or transaction abort destroys it. */
export async function migrateLegacyLocalStorage(repository: ProjectRepository, storage: LegacyStorage | null, key = SCENE_STORAGE_KEY) {
  if (!storage) return { document: null, migrated: false, alreadyMigrated: false };
  const json = storage.getItem(key);
  if (json === null) return { document: null, migrated: false, alreadyMigrated: false };
  const document = parseProjectDocument(json);
  if (!document) throw new Error("Старая сцена не прошла проверку. Она оставлена в браузере; можно импортировать исходный JSON вручную.");
  const result = await repository.importLegacy({ ...document, id: createProjectId() }, key);
  return { ...result, alreadyMigrated: !result.migrated };
}
