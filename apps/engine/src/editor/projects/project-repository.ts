import type { SceneDocument } from "@/packages/engine/src/scene/document";
import { assertPngDataUrl } from "@/packages/engine/src/assets/image-assets";
import { createProjectId, validateProjectDocument } from "../scene/project-document";
import { createProjectResourceCodec, restoreProjectResources, type PreparedProject, type ProjectResource, type StoredDocument } from "./project-resources";

export const PROJECT_DATABASE_NAME = "zhiv:engine:projects";
export const PROJECT_DATABASE_VERSION = 1;
export const PROJECT_STORE = "projects";
export const RESOURCE_STORE = "resources";
export const METADATA_STORE = "metadata";
export const PROJECT_REVISION_PREFIX = "revision:";

export type ProjectSummary = {
  id: string; name: string; presetId: string; presetVersion: number; width: number; height: number; updatedAt: number; assetCount: number; revision: number;
};
export type ProjectRepository = {
  list(): Promise<ProjectSummary[]>;
  load(id: string): Promise<SceneDocument | null>;
  save(document: SceneDocument, expectedRevision?: number): Promise<ProjectSummary>;
  getRevision(id: string): number | undefined;
  duplicate(id: string, name?: string): Promise<SceneDocument>;
  delete(id: string, expectedRevision?: number): Promise<void>;
  /** The marker commits atomically with the imported project, and survives its later deletion. */
  importLegacy(document: SceneDocument, sourceKey: string): Promise<{ document: SceneDocument | null; migrated: boolean }>;
  close(): Promise<void>;
};
type ProjectManifest = { id: string; updatedAt: number; revision: number; document: StoredDocument };
type MigrationMarker = { key: string; projectId: string };
type RepositoryOptions = { indexedDB?: IDBFactory | null; databaseName?: string; subtle?: SubtleCrypto; now?: () => number; createId?: () => string };

function summary(manifest: ProjectManifest): ProjectSummary {
  const { id, name, presetId, presetVersion, width, height } = manifest.document;
  return { id, name, presetId, presetVersion, width, height, updatedAt: manifest.updatedAt, assetCount: manifest.document.assets.length, revision: manifest.revision };
}

export class ProjectConflictError extends Error {
  readonly code = "PROJECT_CONFLICT";
  constructor() { super("Проект изменён или удалён в другой вкладке. Экспортируй свои изменения, затем заново открой сохранённый проект."); this.name = "ProjectConflictError"; }
}

function validDocument(document: SceneDocument): SceneDocument {
  const validated = validateProjectDocument(document);
  if (!validated) throw new Error("Проект не прошёл проверку. Экспортируй сцену и проверь её содержимое.");
  return validated;
}

function transactionCompletion(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error ?? new Error("Сохранение проекта прервано."));
    transaction.onerror = () => {}; // Abort, rather than a successful individual request, determines durability.
  });
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Не удалось прочитать хранилище проектов."));
  });
}

/** All resource writes, the manifest and resource GC belong to one transaction.
 * No asynchronous hashing or Blob reads occur inside an active transaction. */
function commitProject(database: IDBDatabase, prepared: PreparedProject, updatedAt: number, expectedRevision: number, marker?: MigrationMarker): Promise<{ existingMarker?: MigrationMarker; revision: number }> {
  const transaction = database.transaction([PROJECT_STORE, RESOURCE_STORE, METADATA_STORE], "readwrite"), completion = transactionCompletion(transaction);
  const projects = transaction.objectStore(PROJECT_STORE), resources = transaction.objectStore(RESOURCE_STORE);
  let cause: Error | undefined, existingMarker: MigrationMarker | undefined, revision = expectedRevision + 1;
  function write() {
    const request = projects.get(prepared.document.id);
    request.onsuccess = () => {
      const existing = request.result as ProjectManifest | undefined;
      if (existing && (!Number.isSafeInteger(existing.revision) || existing.revision < 1)) {
        cause = new Error("Версия сохранённого проекта повреждена."); transaction.abort(); return;
      }
      if ((existing?.revision ?? 0) !== expectedRevision) { cause = new ProjectConflictError(); transaction.abort(); return; }
      const counter = transaction.objectStore(METADATA_STORE).get(PROJECT_REVISION_PREFIX + prepared.document.id);
      counter.onsuccess = () => {
        const previous = counter.result === undefined ? 0 : counter.result.revision;
        if (!Number.isSafeInteger(previous) || previous < 0 || previous === Number.MAX_SAFE_INTEGER) {
          cause = new Error("Счётчик версий проекта повреждён."); transaction.abort(); return;
        }
        revision = Math.max(expectedRevision, previous) + 1;
        if (!Number.isSafeInteger(revision)) { cause = new Error("Исчерпан счётчик версий проекта."); transaction.abort(); return; }
        writeAccepted();
      };
    };
  }
  function writeAccepted() {
    try {
    for (const resource of prepared.resources) {
      const request = resources.get(resource.key);
      request.onsuccess = () => {
        try {
          const existing = request.result as ProjectResource | undefined;
          if (!existing) resources.put(resource);
          else if (existing.contentId !== resource.contentId || existing.byteLength !== resource.byteLength
            || !(existing.blob instanceof Blob) || existing.blob.size !== resource.byteLength || existing.blob.type !== "image/png") {
            cause = new Error("Конфликт содержимого PNG в хранилище. Исходный проект сохранён без изменений."); transaction.abort();
          }
        } catch (error) { cause = error instanceof Error ? error : new Error(String(error)); transaction.abort(); }
      };
    }
    projects.put({ id: prepared.document.id, updatedAt, revision, document: prepared.document } satisfies ProjectManifest);
    transaction.objectStore(METADATA_STORE).put({ key: PROJECT_REVISION_PREFIX + prepared.document.id, revision });
    if (marker) transaction.objectStore(METADATA_STORE).put(marker);
    collectUnusedResources(transaction);
    } catch (error) { cause = error instanceof Error ? error : new Error(String(error)); transaction.abort(); }
  }
  if (marker) {
    const request = transaction.objectStore(METADATA_STORE).get(marker.key);
    request.onsuccess = () => { existingMarker = request.result; if (!existingMarker) write(); };
  } else write();
  return completion.then(() => ({ existingMarker, revision })).catch(error => { throw cause ?? error; });
}

function collectUnusedResources(transaction: IDBTransaction) {
  const projects = transaction.objectStore(PROJECT_STORE), resources = transaction.objectStore(RESOURCE_STORE);
  const manifests = projects.getAll();
  manifests.onsuccess = () => {
    const referenced = new Set<string>();
    for (const manifest of manifests.result as ProjectManifest[]) {
      if (!Array.isArray(manifest.document?.assets)) { transaction.abort(); return; }
      for (const asset of manifest.document.assets) {
        if (typeof asset.resourceKey !== "string") { transaction.abort(); return; }
        referenced.add(asset.resourceKey);
      }
    }
    const keys = resources.getAllKeys();
    keys.onsuccess = () => { for (const key of keys.result) if (typeof key === "string" && !referenced.has(key)) resources.delete(key); };
  };
}

export function createIndexedDbProjectRepository(options: RepositoryOptions = {}): ProjectRepository {
  let databasePromise: Promise<IDBDatabase> | undefined, currentDatabase: IDBDatabase | undefined;
  let queue: Promise<unknown> = Promise.resolve(), closing = false;
  const codec = createProjectResourceCodec(options.subtle), now = options.now ?? Date.now;
  const knownRevisions = new Map<string, number>();
  const createId = options.createId ?? createProjectId;

  function openDatabase(): Promise<IDBDatabase> {
    if (databasePromise) return databasePromise;
    databasePromise = new Promise<IDBDatabase>((resolve, reject) => {
      let abandoned = false;
      try {
        const factory = options.indexedDB === undefined ? globalThis.indexedDB : options.indexedDB;
        if (!factory) throw new Error("IndexedDB недоступен. Сцена остаётся доступна для редактирования и экспорта.");
        const request = factory.open(options.databaseName ?? PROJECT_DATABASE_NAME, PROJECT_DATABASE_VERSION);
        request.onupgradeneeded = () => {
          const database = request.result;
          if (!database.objectStoreNames.contains(PROJECT_STORE)) database.createObjectStore(PROJECT_STORE, { keyPath: "id" });
          if (!database.objectStoreNames.contains(RESOURCE_STORE)) database.createObjectStore(RESOURCE_STORE, { keyPath: "key" });
          if (!database.objectStoreNames.contains(METADATA_STORE)) database.createObjectStore(METADATA_STORE, { keyPath: "key" });
        };
        request.onblocked = () => { abandoned = true; reject(new Error("Хранилище занято другой вкладкой. Закрой старую вкладку редактора и повтори сохранение.")); };
        request.onerror = () => reject(request.error ?? new Error("Не удалось открыть хранилище проектов."));
        request.onsuccess = () => {
          const database = request.result;
          if (abandoned) { database.close(); reject(new Error("Хранилище проектов закрыто.")); return; }
          currentDatabase = database;
          database.onversionchange = () => { database.close(); if (currentDatabase === database) { currentDatabase = undefined; databasePromise = undefined; } };
          resolve(database);
        };
      } catch (error) { reject(error); }
    }).catch(error => { databasePromise = undefined; throw error; });
    return databasePromise;
  }

  function enqueue<T>(operation: () => Promise<T>): Promise<T> {
    if (closing) return Promise.reject(new Error("Хранилище проектов закрыто."));
    const result = queue.then(operation);
    queue = result.then(() => undefined, () => undefined);
    return result;
  }

  async function readManifest(id: string): Promise<{ manifest: ProjectManifest | undefined; resources: Map<string, ProjectResource> }> {
    const database = await openDatabase(), transaction = database.transaction([PROJECT_STORE, RESOURCE_STORE], "readonly"), completion = transactionCompletion(transaction);
    let manifest: ProjectManifest | undefined, cause: Error | undefined;
    const resources = new Map<string, ProjectResource>(), request = transaction.objectStore(PROJECT_STORE).get(id);
    request.onsuccess = () => {
      try {
        manifest = request.result;
        if (!manifest) return;
        if (!Array.isArray(manifest.document?.assets)) throw new Error("Список ресурсов сохранённого проекта повреждён.");
        for (const asset of manifest.document.assets) {
          if (!asset || typeof asset.resourceKey !== "string") throw new Error("Ссылка на ресурс сохранённого проекта повреждена.");
          const resource = transaction.objectStore(RESOURCE_STORE).get(asset.resourceKey);
          resource.onsuccess = () => { if (resource.result) resources.set(asset.resourceKey, resource.result); };
        }
      } catch (error) { cause = error instanceof Error ? error : new Error(String(error)); transaction.abort(); }
    };
    await completion.catch(error => { throw cause ?? error; });
    return { manifest, resources };
  }

  async function load(id: string): Promise<SceneDocument | null> {
    const { manifest, resources } = await readManifest(id);
    if (!manifest) { knownRevisions.set(id, 0); return null; }
    const document = await restoreProjectResources(manifest.document, resources, options.subtle);
    if (manifest.id !== document.id) throw new Error("ID сохранённого проекта повреждён.");
    const validated = validDocument(document);
    if (!Number.isSafeInteger(manifest.revision) || manifest.revision < 1) throw new Error("Версия сохранённого проекта повреждена.");
    knownRevisions.set(id, manifest.revision);
    return validated;
  }

  async function save(document: SceneDocument, expectedRevision: number): Promise<ProjectSummary> {
    const validated = validDocument(document), prepared = await codec.prepare(validated), database = await openDatabase(), updatedAt = now();
    const { revision } = await commitProject(database, prepared, updatedAt, expectedRevision);
    knownRevisions.set(document.id, revision);
    return summary({ id: document.id, document: prepared.document, updatedAt, revision });
  }

  return {
    list: () => enqueue(async () => {
      const database = await openDatabase(), transaction = database.transaction(PROJECT_STORE, "readonly"), completion = transactionCompletion(transaction);
      const [result] = await Promise.all([requestResult(transaction.objectStore(PROJECT_STORE).getAll()), completion]) as [ProjectManifest[], void];
      return result.map(summary).sort((first, second) => second.updatedAt - first.updatedAt || first.name.localeCompare(second.name));
    }),
    load: id => enqueue(() => load(id)),
    save: (document, expectedRevision = knownRevisions.get(document.id) ?? 0) => {
      const snapshot = structuredClone(document);
      return enqueue(() => save(snapshot, expectedRevision));
    },
    getRevision: id => knownRevisions.get(id),
    duplicate: (id, name) => enqueue(async () => {
      const original = await load(id);
      if (!original) throw new Error("Проект для копирования не найден.");
      const suffix = " (копия)", stem = original.name.slice(0, 100 - suffix.length).replace(/[\ud800-\udbff]$/, "").trimEnd();
      const document = { ...original, id: createId(), name: name ?? stem + suffix };
      await save(document, 0);
      return document;
    }),
    delete: (id, expectedRevision = knownRevisions.get(id)) => enqueue(async () => {
      const database = await openDatabase(), transaction = database.transaction([PROJECT_STORE, RESOURCE_STORE], "readwrite"), completion = transactionCompletion(transaction);
      let cause: Error | undefined;
      const projects = transaction.objectStore(PROJECT_STORE), request = projects.get(id);
      request.onsuccess = () => {
        const existing = request.result as ProjectManifest | undefined;
        if (expectedRevision !== undefined && (existing?.revision ?? 0) !== expectedRevision) { cause = new ProjectConflictError(); transaction.abort(); return; }
        projects.delete(id); collectUnusedResources(transaction);
      };
      await completion.catch(error => { throw cause ?? error; });
      knownRevisions.set(id, 0);
    }),
    importLegacy: (document, sourceKey) => {
      const snapshot = structuredClone(document);
      return enqueue(async () => {
        const validated = validDocument(snapshot);
        // A one-time marker must never commit an unreadable legacy PNG. Verify
        // sequentially before opening the write transaction, as for JSON import.
        for (const asset of validated.assets) await assertPngDataUrl(asset.dataUrl);
        const prepared = await codec.prepare(validated), database = await openDatabase();
        const { existingMarker, revision } = await commitProject(database, prepared, now(), 0, { key: `legacy:${sourceKey}`, projectId: snapshot.id });
        if (existingMarker) return { document: await load(existingMarker.projectId), migrated: false };
        knownRevisions.set(snapshot.id, revision);
        return { document: validated, migrated: true };
      });
    },
    async close() {
      if (closing) { await queue; return; }
      closing = true;
      await queue;
      currentDatabase?.close(); currentDatabase = undefined; databasePromise = undefined;
      codec.clear();
    },
  };
}
