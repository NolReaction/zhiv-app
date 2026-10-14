import { MAX_IMAGE_ASSETS, sceneAssetsWithinLimits, validateImageAsset, type ImageAsset } from "../assets/image-assets.ts";
import { cloneLighting, validateLighting, type LightingState } from "../lighting/lighting-data.ts";
import { cloneTerrain, validateTerrain, type TerrainState } from "../terrain/terrain-data.ts";
import { MAX_SCENE_DIMENSION, validateSceneSize, type EngineObject, type ObjectCatalog } from "./contracts.ts";
import { MAX_SCENE_FOLDERS, folderAncestors, type SceneFolder } from "./folders.ts";
import { MAX_SCENE_LAYERS, validStackKey, type SceneLayer } from "./stacking.ts";

export const SCENE_DOCUMENT_VERSION = 6;
export const MAX_PROJECT_DOCUMENT_BYTES = 32 * 1024 * 1024;
export const MAX_BASE_OBJECTS = 25_000;
export const MAX_PLANTED_OBJECTS = 5_000;
export const MAX_DOCUMENT_EDITS = MAX_BASE_OBJECTS + MAX_PLANTED_OBJECTS;

/** A portable project owns its content snapshot. Generators are used only when creating content. */
export type SceneDocument = {
  version: 6;
  id: string;
  name: string;
  presetId: string;
  presetVersion: number;
  seed: number;
  width: number;
  height: number;
  baseObjects: EngineObject[];
  planted: EngineObject[];
  removed: string[];
  modified: EngineObject[];
  assets: ImageAsset[];
  layers: SceneLayer[];
  folders: SceneFolder[];
  terrain: TerrainState;
  lighting: LightingState;
};

export type SceneDocumentValidationOptions = {
  /** Optional host catalog rejects unresolved kinds without importing host content. */
  catalog?: ObjectCatalog;
  /** Authored content can sit outside the visible extent. The finite bound remains explicit. */
  baseObjectMargin?: number;
  /** A host may permit editing its baseline in a bounded overscan area. New objects stay on-map. */
  editMargin?: number;
};

const documentKeys = new Set(["version", "id", "name", "presetId", "presetVersion", "seed", "width", "height", "baseObjects", "planted", "removed", "modified", "assets", "layers", "folders", "terrain", "lighting"]);
const objectKeys = new Set(["id", "kind", "x", "y", "scale", "variant", "rotation", "assetId", "imageWidth", "imageHeight", "layerId", "folderId", "hidden", "locked", "name", "stackOrder", "shadowHeight"]);
const layerKeys = new Set(["id", "name", "visible", "locked"]);
const folderKeys = new Set(["id", "name", "parentId", "visible", "locked"]);
const assetKeys = new Set(["id", "name", "dataUrl", "width", "height"]);
const own = (value: object, key: string) => Object.prototype.hasOwnProperty.call(value, key);
function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}
function allowedKeys(value: object, keys: ReadonlySet<string>): boolean {
  return Reflect.ownKeys(value).every(key => typeof key === "string" && keys.has(key));
}
function finite(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= min && value <= max;
}
export function validProjectId(value: unknown): value is string {
  return typeof value === "string" && value.length <= 128 && /^[a-zA-Z0-9:_.-]+$/.test(value)
    && !["__proto__", "constructor", "prototype"].includes(value);
}
export function validProjectName(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 100 && value === value.trim()
    && !/[\u0000-\u001f\u007f]/.test(value);
}

function readLayers(value: unknown): SceneLayer[] | null {
  if (!Array.isArray(value) || !value.length || value.length > MAX_SCENE_LAYERS) return null;
  const layers: SceneLayer[] = [], ids = new Set<string>();
  for (const entry of value) {
    if (!record(entry) || !allowedKeys(entry, layerKeys) || !validProjectId(entry.id) || ids.has(entry.id)
      || !validProjectName(entry.name) || typeof entry.visible !== "boolean" || typeof entry.locked !== "boolean") return null;
    ids.add(entry.id); layers.push({ id: entry.id, name: entry.name, visible: entry.visible, locked: entry.locked });
  }
  return ids.has("world") ? layers : null;
}
function readFolders(value: unknown): SceneFolder[] | null {
  if (!Array.isArray(value) || value.length > MAX_SCENE_FOLDERS) return null;
  const folders: SceneFolder[] = [], ids = new Set<string>();
  for (const entry of value) {
    if (!record(entry) || !allowedKeys(entry, folderKeys) || !validProjectId(entry.id) || ids.has(entry.id)
      || !validProjectName(entry.name) || (entry.parentId !== null && !validProjectId(entry.parentId))
      || typeof entry.visible !== "boolean" || typeof entry.locked !== "boolean") return null;
    ids.add(entry.id); folders.push({ id: entry.id, name: entry.name, parentId: entry.parentId, visible: entry.visible, locked: entry.locked });
  }
  return folders.every(folder => folderAncestors(folder.id, folders) !== null) ? folders : null;
}

type ObjectReader = { width: number; height: number; assets: ReadonlyMap<string, ImageAsset>; layerIds: ReadonlySet<string>; folderIds: ReadonlySet<string>; options: SceneDocumentValidationOptions };
function readObject(value: unknown, reader: ObjectReader, mode: "base" | "planted" | "modified", original?: EngineObject): EngineObject | null {
  if (!record(value) || !allowedKeys(value, objectKeys) || !validProjectId(value.id) || !validProjectId(value.kind)
    || (reader.options.catalog && !own(reader.options.catalog, value.kind))
    || !finite(value.scale, .1, 8) || !finite(value.variant, 0, 65_535) || !Number.isInteger(value.variant)
    || (value.rotation !== undefined && !finite(value.rotation, -180, 180))) return null;
  const { width, height, assets, layerIds, folderIds, options } = reader;
  const margin = mode === "base" ? options.baseObjectMargin ?? MAX_SCENE_DIMENSION : mode === "modified" && original ? options.editMargin ?? 0 : 0;
  if (!finite(value.x, -MAX_SCENE_DIMENSION, width + MAX_SCENE_DIMENSION) || !finite(value.y, -MAX_SCENE_DIMENSION, height + MAX_SCENE_DIMENSION)) return null;
  const inBounds = value.x >= -margin && value.x <= width + margin && value.y >= -margin && value.y <= height + margin;
  const originalAnchor = !!original && value.x === original.x && value.y === original.y;
  if (!inBounds && !originalAnchor) return null;
  if ((value.layerId !== undefined && (!validProjectId(value.layerId) || !layerIds.has(value.layerId)))
    || (value.folderId !== undefined && value.folderId !== null && (!validProjectId(value.folderId) || !folderIds.has(value.folderId)))
    || (value.hidden !== undefined && typeof value.hidden !== "boolean") || (value.locked !== undefined && typeof value.locked !== "boolean")
    || (value.name !== undefined && !validProjectName(value.name)) || (value.stackOrder !== undefined && !validStackKey(value.stackOrder))
    || (value.shadowHeight !== undefined && !finite(value.shadowHeight, 0, 480))) return null;
  const object: EngineObject = { id: value.id, kind: value.kind, x: value.x, y: value.y, scale: value.scale, variant: value.variant };
  if (value.rotation !== undefined) object.rotation = value.rotation as number;
  if (value.kind === "image") {
    const asset = typeof value.assetId === "string" ? assets.get(value.assetId) : undefined;
    if (!asset || !finite(value.imageWidth, Number.MIN_VALUE, 4096) || !finite(value.imageHeight, Number.MIN_VALUE, 4096)) return null;
    const a = value.imageWidth * asset.height, b = value.imageHeight * asset.width;
    if (Math.abs(a - b) > Math.max(a, b) * 1e-6) return null;
    object.assetId = asset.id; object.imageWidth = value.imageWidth; object.imageHeight = value.imageHeight;
  } else if (["assetId", "imageWidth", "imageHeight"].some(key => own(value, key))) return null;
  if (value.layerId !== undefined) object.layerId = value.layerId as string;
  if (value.folderId !== undefined) object.folderId = value.folderId as string | null;
  if (value.hidden !== undefined) object.hidden = value.hidden as boolean;
  if (value.locked !== undefined) object.locked = value.locked as boolean;
  if (value.name !== undefined) object.name = value.name as string;
  if (value.stackOrder !== undefined) object.stackOrder = [...value.stackOrder as number[]];
  if (value.shadowHeight !== undefined) object.shadowHeight = value.shadowHeight as number;
  return object;
}

/** Strict validation copies every field and never merges untrusted records into live state. */
export function validateSceneDocument(value: unknown, options: SceneDocumentValidationOptions = {}): SceneDocument | null {
  if ((options.baseObjectMargin !== undefined && !finite(options.baseObjectMargin, 0, MAX_SCENE_DIMENSION))
    || (options.editMargin !== undefined && !finite(options.editMargin, 0, MAX_SCENE_DIMENSION))
    || !record(value) || !allowedKeys(value, documentKeys) || value.version !== SCENE_DOCUMENT_VERSION
    || !validProjectId(value.id) || !validProjectName(value.name) || !validProjectId(value.presetId)
    || !finite(value.presetVersion, 1, 2_147_483_647) || !Number.isInteger(value.presetVersion)
    || !finite(value.seed, 0, 2_147_483_647) || !Number.isInteger(value.seed)
    || typeof value.width !== "number" || typeof value.height !== "number" || !validateSceneSize({ width: value.width, height: value.height })
    || !Array.isArray(value.baseObjects) || value.baseObjects.length > MAX_BASE_OBJECTS
    || !Array.isArray(value.planted) || value.planted.length > MAX_PLANTED_OBJECTS
    || !Array.isArray(value.removed) || value.removed.length > MAX_DOCUMENT_EDITS
    || !Array.isArray(value.modified) || value.modified.length > MAX_DOCUMENT_EDITS
    || !Array.isArray(value.assets) || value.assets.length > MAX_IMAGE_ASSETS) return null;
  const layers = readLayers(value.layers), folders = readFolders(value.folders);
  const terrain = validateTerrain(value.terrain, value.width, value.height), lighting = validateLighting(value.lighting, value.width, value.height);
  if (!layers || !folders || !terrain || !lighting) return null;
  const assets: ImageAsset[] = [], byAssetId = new Map<string, ImageAsset>();
  for (const entry of value.assets) {
    if (!record(entry) || !allowedKeys(entry, assetKeys)) return null;
    const asset = validateImageAsset(entry);
    if (!asset || byAssetId.has(asset.id)) return null;
    assets.push(asset); byAssetId.set(asset.id, asset);
  }
  if (!sceneAssetsWithinLimits(assets)) return null;
  const reader: ObjectReader = { width: value.width, height: value.height, assets: byAssetId,
    layerIds: new Set(layers.map(layer => layer.id)), folderIds: new Set(folders.map(folder => folder.id)), options };
  const baseObjects: EngineObject[] = [], planted: EngineObject[] = [], known = new Map<string, EngineObject>();
  for (const [source, result, mode] of [[value.baseObjects, baseObjects, "base"], [value.planted, planted, "planted"]] as const) {
    for (const entry of source) {
      const object = readObject(entry, reader, mode);
      if (!object || known.has(object.id)) return null;
      result.push(object); known.set(object.id, object);
    }
  }
  const removed = new Set<string>();
  for (const id of value.removed) {
    if (!validProjectId(id) || !known.has(id) || removed.has(id)) return null;
    removed.add(id);
  }
  const modified: EngineObject[] = [], modifiedIds = new Set<string>(), baseIds = new Set(baseObjects.map(object => object.id));
  for (const entry of value.modified) {
    const original = record(entry) && typeof entry.id === "string" ? known.get(entry.id) : undefined;
    const object = readObject(entry, reader, original && baseIds.has(original.id) ? "modified" : "planted", original);
    if (!object || !original || original.kind !== object.kind || removed.has(object.id) || modifiedIds.has(object.id)) return null;
    modified.push(object); modifiedIds.add(object.id);
  }
  return { version: SCENE_DOCUMENT_VERSION, id: value.id, name: value.name, presetId: value.presetId, presetVersion: value.presetVersion,
    seed: value.seed, width: value.width, height: value.height, baseObjects, planted, removed: [...removed], modified, assets, layers, folders, terrain, lighting };
}

export function cloneSceneDocument(document: SceneDocument): SceneDocument {
  const cloneObject = (object: EngineObject): EngineObject => ({ ...object, ...(object.stackOrder ? { stackOrder: [...object.stackOrder] } : {}) });
  return { ...document, baseObjects: document.baseObjects.map(cloneObject), planted: document.planted.map(cloneObject), modified: document.modified.map(cloneObject),
    removed: [...document.removed], assets: document.assets.map(asset => ({ ...asset })), layers: document.layers.map(layer => ({ ...layer })),
    folders: document.folders.map(folder => ({ ...folder })), terrain: cloneTerrain(document.terrain), lighting: cloneLighting(document.lighting) };
}
