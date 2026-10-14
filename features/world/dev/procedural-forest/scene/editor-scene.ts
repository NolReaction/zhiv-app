import { forestObjects, initialProps, INITIAL_SEED, INITIAL_WIDTH, MAX_WIDTH, OVERSCAN_EDIT_MARGIN, WORLD_HEIGHT, type ForestObject } from "./objects";
import { MAX_IMAGE_ASSETS, sceneAssetsWithinLimits, validateImageAsset, type ImageAsset } from "@/features/world/dev/procedural-forest/assets/image-assets";
import { MAX_SCENE_LAYERS, MAX_STACK_VALUE, defaultLayers, validStackKey, type SceneLayer } from "./stacking";
import { MAX_SCENE_FOLDERS, defaultFolders, folderAncestors, type SceneFolder } from "./folders";
import { cloneTerrain, initialTerrain, validateTerrain, type TerrainState } from "@/features/world/dev/procedural-forest/terrain/terrain-data";

/** This namespace never reads or writes the actual game's saves. */
export const SCENE_STORAGE_KEY = "zhiv:prototype:procedural-forest:scene:v1";
export const MAX_SCENE_BYTES = 32 * 1024 * 1024;
const MAX_OBJECTS = 5_000;
const MAX_EDITS = 10_000;
const kinds = new Set(["tree", "shrub", "rock", "ruins", "bridge", "jetty", "image"]);
const metadataKeys = ["layerId", "hidden", "locked", "name", "stackOrder"] as const;
const objectKeys = new Set(["id", "kind", "x", "y", "scale", "variant", "rotation", "assetId", "imageWidth", "imageHeight", "folderId", ...metadataKeys]);
const scalarObjectKeys = [...objectKeys].filter(key => key !== "stackOrder") as (keyof ForestObject)[];
const sceneKeys = new Set(["version", "seed", "width", "planted", "removed", "modified", "assets", "layers", "folders", "terrain"]);
const layerKeys = new Set(["id", "name", "visible", "locked"]);
const folderKeys = new Set(["id", "name", "parentId", "visible", "locked"]);

export type ForestScene = {
  version: 4;
  seed: number;
  width: number;
  planted: ForestObject[];
  removed: string[];
  modified: ForestObject[];
  assets: ImageAsset[];
  layers: SceneLayer[];
  folders: SceneFolder[];
  terrain: TerrainState;
};

export function initialScene(): ForestScene {
  return { version: 4, seed: INITIAL_SEED, width: INITIAL_WIDTH, planted: [], removed: [], modified: [], assets: [], layers: defaultLayers(), folders: defaultFolders(), terrain: initialTerrain() };
}

export function cloneScene(scene: ForestScene): ForestScene {
  const cloneObject = (object: ForestObject) => ({ ...object, ...(object.stackOrder ? { stackOrder: [...object.stackOrder] } : {}) });
  return { ...scene, planted: scene.planted.map(cloneObject), removed: [...scene.removed], modified: scene.modified.map(cloneObject),
    assets: scene.assets.map(asset => ({ ...asset })), layers: scene.layers.map(layer => ({ ...layer })),
    folders: scene.folders.map(folder => ({ ...folder })), terrain: cloneTerrain(scene.terrain) };
}

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function finite(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= min && value <= max;
}

function validId(value: unknown): value is string {
  return typeof value === "string" && value.length <= 128 && /^[a-zA-Z0-9:_.-]+$/.test(value)
    && !["__proto__", "constructor", "prototype"].includes(value);
}

function validName(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 100 && value === value.trim() && !/[\u0000-\u001f\u007f]/.test(value);
}

function readLayers(value: unknown): SceneLayer[] | null {
  if (!Array.isArray(value) || !value.length || value.length > MAX_SCENE_LAYERS) return null;
  const layers: SceneLayer[] = [], ids = new Set<string>();
  for (const entry of value) {
    if (!record(entry) || Object.keys(entry).some(key => !layerKeys.has(key)) || !validId(entry.id) || ids.has(entry.id)
      || !validName(entry.name) || typeof entry.visible !== "boolean" || typeof entry.locked !== "boolean") return null;
    ids.add(entry.id); layers.push({ id: entry.id, name: entry.name, visible: entry.visible, locked: entry.locked });
  }
  return ids.has("world") ? layers : null;
}

function readFolders(value: unknown): SceneFolder[] | null {
  if (!Array.isArray(value) || value.length > MAX_SCENE_FOLDERS) return null;
  const folders: SceneFolder[] = [], ids = new Set<string>();
  for (const entry of value) {
    if (!record(entry) || Object.keys(entry).some(key => !folderKeys.has(key)) || !validId(entry.id) || ids.has(entry.id)
      || !validName(entry.name) || (entry.parentId !== null && !validId(entry.parentId))
      || typeof entry.visible !== "boolean" || typeof entry.locked !== "boolean") return null;
    ids.add(entry.id); folders.push({ id: entry.id, name: entry.name, parentId: entry.parentId, visible: entry.visible, locked: entry.locked });
  }
  return folders.every(folder => folderAncestors(folder.id, folders) !== null) ? folders : null;
}

/** Imported values are copied field by field; none are merged into live objects. */
type SceneObject = ForestObject | (Omit<ForestObject, "kind"> & { kind: "stump-house" });
function readObject(value: unknown, width: number, assets: ReadonlyMap<string, ImageAsset>, layerIds: ReadonlySet<string>, folderIds: ReadonlySet<string>, version: number, original?: SceneObject): SceneObject | null {
  if (!record(value) || Object.keys(value).some(key => !objectKeys.has(key))) return null;
  const legacy = version === 1;
  if (!validId(value.id) || typeof value.kind !== "string" || (!kinds.has(value.kind) && !(legacy && value.kind === "stump-house"))
    || (legacy && value.kind === "image")
    || !finite(value.x, -MAX_STACK_VALUE, MAX_STACK_VALUE) || !finite(value.y, -MAX_STACK_VALUE, MAX_STACK_VALUE)
    || !finite(value.scale, .1, 8) || !finite(value.variant, 0, 23) || !Number.isInteger(value.variant)
    || (value.rotation !== undefined && !finite(value.rotation, -180, 180))) return null;
  const onMap = value.x >= 0 && value.x <= width && value.y >= 0 && value.y <= WORLD_HEIGHT;
  const originalAnchor = !!original && value.x === original.x && value.y === original.y;
  const generated = !!original && !original.id.startsWith("planted:") && (original.kind === "tree" || original.kind === "shrub" || original.kind === "rock");
  const buffered = version === 4 && generated && value.x >= -OVERSCAN_EDIT_MARGIN && value.x <= width + OVERSCAN_EDIT_MARGIN
    && value.y >= -OVERSCAN_EDIT_MARGIN && value.y <= WORLD_HEIGHT + OVERSCAN_EDIT_MARGIN;
  if (!onMap && !originalAnchor && !buffered) return null;
  if ((version < 3 && metadataKeys.some(key => key in value)) || (version < 4 && "folderId" in value)) return null;
  if ((value.layerId !== undefined && (!validId(value.layerId) || !layerIds.has(value.layerId)))
    || (value.folderId !== undefined && value.folderId !== null && (!validId(value.folderId) || !folderIds.has(value.folderId)))
    || (value.hidden !== undefined && typeof value.hidden !== "boolean") || (value.locked !== undefined && typeof value.locked !== "boolean")
    || (value.name !== undefined && !validName(value.name)) || (value.stackOrder !== undefined && !validStackKey(value.stackOrder))) return null;
  const object: SceneObject = { id: value.id, kind: value.kind as SceneObject["kind"], x: value.x, y: value.y,
    scale: value.scale, variant: value.variant, rotation: value.rotation === undefined ? 0 : value.rotation as number };
  if (object.kind === "image") {
    const asset = typeof value.assetId === "string" && assets.get(value.assetId);
    if (!asset || !finite(value.imageWidth, 0, 4096) || !finite(value.imageHeight, 0, 4096) || !value.imageWidth || !value.imageHeight) return null;
    const a = value.imageWidth * asset.height, b = value.imageHeight * asset.width;
    if (Math.abs(a - b) > Math.max(a, b) * 1e-6) return null;
    object.assetId = asset.id; object.imageWidth = value.imageWidth; object.imageHeight = value.imageHeight;
  } else if (["assetId", "imageWidth", "imageHeight"].some(key => key in value)) return null;
  if (value.layerId !== undefined) object.layerId = value.layerId as string;
  if (value.folderId !== undefined) object.folderId = value.folderId as string | null;
  if (value.hidden !== undefined) object.hidden = value.hidden as boolean;
  if (value.locked !== undefined) object.locked = value.locked as boolean;
  if (value.name !== undefined) object.name = value.name as string;
  if (value.stackOrder !== undefined) object.stackOrder = [...value.stackOrder as number[]];
  return object;
}

export function validateScene(value: unknown): ForestScene | null {
  if (!record(value) || Object.keys(value).some(key => !sceneKeys.has(key)) || (value.version !== 1 && value.version !== 2 && value.version !== 3 && value.version !== 4)
    || (value.version === 1 && "assets" in value) || (value.version !== 1 && (!Array.isArray(value.assets) || value.assets.length > MAX_IMAGE_ASSETS))
    || (value.version < 3 && "layers" in value) || (value.version !== 4 && ("folders" in value || "terrain" in value))
    || !finite(value.seed, 0, 2_147_483_647) || !Number.isInteger(value.seed)
    || !finite(value.width, INITIAL_WIDTH, MAX_WIDTH) || (value.width - INITIAL_WIDTH) % 800 !== 0
    || !Array.isArray(value.planted) || !Array.isArray(value.removed) || !Array.isArray(value.modified)
    || value.planted.length > MAX_OBJECTS || value.removed.length > MAX_EDITS || value.modified.length > MAX_EDITS) return null;
  const layers = value.version >= 3 ? readLayers(value.layers) : defaultLayers();
  if (!layers) return null;
  const folders = value.version === 4 ? readFolders(value.folders) : defaultFolders();
  const terrain = value.version === 4 ? validateTerrain(value.terrain, value.width) : initialTerrain();
  if (!folders || !terrain) return null;
  const layerIds = new Set(layers.map(layer => layer.id));
  const folderIds = new Set(folders.map(folder => folder.id));
  const assets: ImageAsset[] = [];
  const byAssetId = new Map<string, ImageAsset>();
  if (value.version !== 1) {
    for (const entry of value.assets as unknown[]) {
      const asset = validateImageAsset(entry);
      if (!asset || byAssetId.has(asset.id)) return null;
      assets.push(asset); byAssetId.set(asset.id, asset);
      if (!sceneAssetsWithinLimits(assets)) return null;
    }
  }
  const baseObjects = [...forestObjects(value.seed, { x: 0, y: 0, width: value.width, height: WORLD_HEIGHT }), ...initialProps()];
  const known = new Map<string, SceneObject>(baseObjects.map(object => [object.id, object]));
  const planted: ForestObject[] = [];
  for (const entry of value.planted) {
    const object = readObject(entry, value.width, byAssetId, layerIds, folderIds, value.version);
    if (!object || !object.id.startsWith("planted:") || known.has(object.id)) return null;
    if (object.kind !== "stump-house") planted.push(object);
    known.set(object.id, object);
  }
  const removed = new Set<string>();
  for (const id of value.removed) {
    if (!validId(id) || !known.has(id) || removed.has(id)) return null;
    removed.add(id);
  }
  const modified: ForestObject[] = [];
  const modifiedIds = new Set<string>();
  for (const entry of value.modified) {
    const original = record(entry) && typeof entry.id === "string" ? known.get(entry.id) : undefined;
    const object = readObject(entry, value.width, byAssetId, layerIds, folderIds, value.version, original);
    if (!object || !original || original.kind !== object.kind || removed.has(object.id) || modifiedIds.has(object.id)) return null;
    if (object.kind !== "stump-house") modified.push(object);
    modifiedIds.add(object.id);
  }
  return { version: 4, seed: value.seed, width: value.width, planted,
    removed: [...removed].filter(id => known.get(id)?.kind !== "stump-house"), modified, assets, layers, folders, terrain };
}

export function parseScene(json: string): ForestScene | null {
  if (typeof json !== "string" || json.length > MAX_SCENE_BYTES || new TextEncoder().encode(json).length > MAX_SCENE_BYTES) return null;
  try { return validateScene(JSON.parse(json)); } catch { return null; }
}

export function serializeScene(scene: ForestScene): string {
  const pretty = JSON.stringify(scene, null, 2);
  return new TextEncoder().encode(pretty).length > MAX_SCENE_BYTES ? JSON.stringify(scene) : pretty;
}

function sameScene(a: ForestScene, b: ForestScene): boolean {
  const equalKeys = (left?: readonly number[], right?: readonly number[]) => left === right
    || (!!left && !!right && left.length === right.length && left.every((component, index) => component === right[index]));
  const equalObjects = (left: readonly ForestObject[], right: readonly ForestObject[]) => left.length === right.length
    && left.every((object, index) => scalarObjectKeys.every(key => object[key] === right[index][key]) && equalKeys(object.stackOrder, right[index].stackOrder));
  return a.version === b.version && a.seed === b.seed && a.width === b.width
    && equalObjects(a.planted, b.planted) && equalObjects(a.modified, b.modified)
    && a.removed.length === b.removed.length && a.removed.every((id, index) => id === b.removed[index])
    && a.layers.length === b.layers.length && a.layers.every((layer, index) => {
      const other = b.layers[index];
      return layer.id === other.id && layer.name === other.name && layer.visible === other.visible && layer.locked === other.locked;
    })
    && a.folders.length === b.folders.length && a.folders.every((folder, index) => {
      const other = b.folders[index];
      return folder.id === other.id && folder.name === other.name && folder.parentId === other.parentId && folder.visible === other.visible && folder.locked === other.locked;
    })
    && a.terrain.baseTrails === b.terrain.baseTrails && Object.keys(a.terrain.cells).length === Object.keys(b.terrain.cells).length
    && Object.keys(a.terrain.cells).every(key => a.terrain.cells[key] === b.terrain.cells[key])
    && a.assets.length === b.assets.length && a.assets.every((asset, index) => {
      const other = b.assets[index];
      return asset.id === other.id && asset.name === other.name && asset.width === other.width && asset.height === other.height && asset.dataUrl === other.dataUrl;
    });
}

/** Only completed commands enter history; a pointer-drag preview remains outside it. */
export function createSceneHistory(initial: ForestScene, limit = 60) {
  let current = cloneScene(initial);
  const before: ForestScene[] = [], after: ForestScene[] = [];
  return {
    getScene() { return cloneScene(current); },
    get canUndo() { return before.length > 0; },
    get canRedo() { return after.length > 0; },
    commit(scene: ForestScene) {
      if (sameScene(current, scene)) return false;
      before.push(current); if (before.length > Math.max(1, limit)) before.shift();
      current = cloneScene(scene); after.length = 0; return true;
    },
    undo() {
      const previous = before.pop(); if (!previous) return null;
      after.push(current); current = previous; return cloneScene(current);
    },
    redo() {
      const next = after.pop(); if (!next) return null;
      before.push(current); current = next; return cloneScene(current);
    },
  };
}

export type SceneStorage = Pick<Storage, "getItem" | "setItem">;
export function readStoredScene(storage: SceneStorage | null): { scene: ForestScene; available: boolean; invalid: boolean } {
  if (!storage) return { scene: initialScene(), available: false, invalid: false };
  try {
    const json = storage.getItem(SCENE_STORAGE_KEY);
    if (json === null) return { scene: initialScene(), available: true, invalid: false };
    const scene = parseScene(json);
    return { scene: scene ?? initialScene(), available: true, invalid: !scene };
  } catch { return { scene: initialScene(), available: false, invalid: false }; }
}

export function writeStoredScene(storage: SceneStorage | null, scene: ForestScene): boolean {
  if (!storage) return false;
  try { storage.setItem(SCENE_STORAGE_KEY, JSON.stringify(scene)); return true; } catch { return false; }
}
