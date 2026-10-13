import { forestObjects, initialProps, INITIAL_SEED, INITIAL_WIDTH, MAX_WIDTH, WORLD_HEIGHT, type ForestObject } from "./objects";
import { MAX_IMAGE_ASSETS, sceneAssetsWithinLimits, validateImageAsset, type ImageAsset } from "./image-assets";

/** This namespace never reads or writes the actual game's saves. */
export const SCENE_STORAGE_KEY = "zhiv:prototype:procedural-forest:scene:v1";
export const MAX_SCENE_BYTES = 24 * 1024 * 1024;
const MAX_OBJECTS = 5_000;
const MAX_EDITS = 10_000;
const kinds = new Set(["tree", "shrub", "rock", "ruins", "bridge", "jetty", "image"]);
const objectKeys = new Set(["id", "kind", "x", "y", "scale", "variant", "rotation", "assetId", "imageWidth", "imageHeight"]);
const sceneKeys = new Set(["version", "seed", "width", "planted", "removed", "modified", "assets"]);

export type ForestScene = {
  version: 2;
  seed: number;
  width: number;
  planted: ForestObject[];
  removed: string[];
  modified: ForestObject[];
  assets: ImageAsset[];
};

export function initialScene(): ForestScene {
  return { version: 2, seed: INITIAL_SEED, width: INITIAL_WIDTH, planted: [], removed: [], modified: [], assets: [] };
}

export function cloneScene(scene: ForestScene): ForestScene {
  return { ...scene, planted: scene.planted.map(object => ({ ...object })), removed: [...scene.removed], modified: scene.modified.map(object => ({ ...object })), assets: scene.assets.map(asset => ({ ...asset })) };
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

/** Imported values are copied field by field; none are merged into live objects. */
type SceneObject = ForestObject | (Omit<ForestObject, "kind"> & { kind: "stump-house" });
function readObject(value: unknown, width: number, assets: ReadonlyMap<string, ImageAsset>, legacy: boolean): SceneObject | null {
  if (!record(value) || Object.keys(value).some(key => !objectKeys.has(key))) return null;
  if (!validId(value.id) || typeof value.kind !== "string" || (!kinds.has(value.kind) && !(legacy && value.kind === "stump-house"))
    || (legacy && value.kind === "image")
    || !finite(value.x, 0, width) || !finite(value.y, 0, WORLD_HEIGHT)
    || !finite(value.scale, .1, 8) || !finite(value.variant, 0, 23) || !Number.isInteger(value.variant)
    || (value.rotation !== undefined && !finite(value.rotation, -180, 180))) return null;
  const object: SceneObject = { id: value.id, kind: value.kind as SceneObject["kind"], x: value.x, y: value.y,
    scale: value.scale, variant: value.variant, rotation: value.rotation === undefined ? 0 : value.rotation as number };
  if (object.kind === "image") {
    const asset = typeof value.assetId === "string" && assets.get(value.assetId);
    if (!asset || !finite(value.imageWidth, 0, 4096) || !finite(value.imageHeight, 0, 4096) || !value.imageWidth || !value.imageHeight) return null;
    const a = value.imageWidth * asset.height, b = value.imageHeight * asset.width;
    if (Math.abs(a - b) > Math.max(a, b) * 1e-6) return null;
    object.assetId = asset.id; object.imageWidth = value.imageWidth; object.imageHeight = value.imageHeight;
  } else if (["assetId", "imageWidth", "imageHeight"].some(key => key in value)) return null;
  return object;
}

export function validateScene(value: unknown): ForestScene | null {
  if (!record(value) || Object.keys(value).some(key => !sceneKeys.has(key)) || (value.version !== 1 && value.version !== 2)
    || (value.version === 1 && "assets" in value) || (value.version === 2 && (!Array.isArray(value.assets) || value.assets.length > MAX_IMAGE_ASSETS))
    || !finite(value.seed, 0, 2_147_483_647) || !Number.isInteger(value.seed)
    || !finite(value.width, INITIAL_WIDTH, MAX_WIDTH) || (value.width - INITIAL_WIDTH) % 800 !== 0
    || !Array.isArray(value.planted) || !Array.isArray(value.removed) || !Array.isArray(value.modified)
    || value.planted.length > MAX_OBJECTS || value.removed.length > MAX_EDITS || value.modified.length > MAX_EDITS) return null;
  const assets: ImageAsset[] = [];
  const byAssetId = new Map<string, ImageAsset>();
  if (value.version === 2) {
    for (const entry of value.assets as unknown[]) {
      const asset = validateImageAsset(entry);
      if (!asset || byAssetId.has(asset.id)) return null;
      assets.push(asset); byAssetId.set(asset.id, asset);
      if (!sceneAssetsWithinLimits(assets)) return null;
    }
  }
  const legacy = value.version === 1;
  const baseObjects = [...forestObjects(value.seed, { x: 0, y: 0, width: value.width, height: WORLD_HEIGHT }), ...initialProps()];
  const known = new Map<string, SceneObject>(baseObjects.map(object => [object.id, object]));
  const planted: ForestObject[] = [];
  for (const entry of value.planted) {
    const object = readObject(entry, value.width, byAssetId, legacy);
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
    const object = readObject(entry, value.width, byAssetId, legacy);
    const original = object && known.get(object.id);
    if (!object || !original || original.kind !== object.kind || removed.has(object.id) || modifiedIds.has(object.id)) return null;
    if (object.kind !== "stump-house") modified.push(object);
    modifiedIds.add(object.id);
  }
  return { version: 2, seed: value.seed, width: value.width, planted,
    removed: [...removed].filter(id => known.get(id)?.kind !== "stump-house"), modified, assets };
}

export function parseScene(json: string): ForestScene | null {
  if (typeof json !== "string" || json.length > MAX_SCENE_BYTES || new TextEncoder().encode(json).length > MAX_SCENE_BYTES) return null;
  try { return validateScene(JSON.parse(json)); } catch { return null; }
}

export function serializeScene(scene: ForestScene): string { return JSON.stringify(scene, null, 2); }

function sameScene(a: ForestScene, b: ForestScene): boolean {
  const equalObjects = (left: readonly ForestObject[], right: readonly ForestObject[]) => left.length === right.length
    && left.every((object, index) => [...objectKeys].every(key => object[key as keyof ForestObject] === right[index][key as keyof ForestObject]));
  return a.version === b.version && a.seed === b.seed && a.width === b.width
    && equalObjects(a.planted, b.planted) && equalObjects(a.modified, b.modified)
    && a.removed.length === b.removed.length && a.removed.every((id, index) => id === b.removed[index])
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
  try { storage.setItem(SCENE_STORAGE_KEY, serializeScene(scene)); return true; } catch { return false; }
}
