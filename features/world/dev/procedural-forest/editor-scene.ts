import { forestObjects, initialProps, INITIAL_SEED, INITIAL_WIDTH, MAX_WIDTH, WORLD_HEIGHT, type ForestObject } from "./objects";

/** This namespace never reads or writes the actual game's saves. */
export const SCENE_STORAGE_KEY = "zhiv:prototype:procedural-forest:scene:v1";
export const MAX_SCENE_BYTES = 2_000_000;
const MAX_OBJECTS = 5_000;
const MAX_EDITS = 10_000;
const kinds = new Set(["tree", "shrub", "rock", "ruins", "bridge", "jetty"]);
const objectKeys = new Set(["id", "kind", "x", "y", "scale", "variant", "rotation"]);
const sceneKeys = new Set(["version", "seed", "width", "planted", "removed", "modified"]);

export type ForestScene = {
  version: 1;
  seed: number;
  width: number;
  planted: ForestObject[];
  removed: string[];
  modified: ForestObject[];
};

export function initialScene(): ForestScene {
  return { version: 1, seed: INITIAL_SEED, width: INITIAL_WIDTH, planted: [], removed: [], modified: [] };
}

export function cloneScene(scene: ForestScene): ForestScene {
  return { ...scene, planted: scene.planted.map(object => ({ ...object })), removed: [...scene.removed], modified: scene.modified.map(object => ({ ...object })) };
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
function readObject(value: unknown, width: number): ForestObject | null {
  if (!record(value) || Object.keys(value).some(key => !objectKeys.has(key))) return null;
  if (!validId(value.id) || typeof value.kind !== "string" || !kinds.has(value.kind)
    || !finite(value.x, 0, width) || !finite(value.y, 0, WORLD_HEIGHT)
    || !finite(value.scale, .4, 2.4) || !finite(value.variant, 0, 23) || !Number.isInteger(value.variant)
    || (value.rotation !== undefined && !finite(value.rotation, -180, 180))) return null;
  return { id: value.id, kind: value.kind as ForestObject["kind"], x: value.x, y: value.y,
    scale: value.scale, variant: value.variant, rotation: value.rotation === undefined ? 0 : value.rotation as number };
}

export function validateScene(value: unknown): ForestScene | null {
  if (!record(value) || Object.keys(value).some(key => !sceneKeys.has(key)) || value.version !== 1
    || !finite(value.seed, 0, 2_147_483_647) || !Number.isInteger(value.seed)
    || !finite(value.width, INITIAL_WIDTH, MAX_WIDTH) || (value.width - INITIAL_WIDTH) % 800 !== 0
    || !Array.isArray(value.planted) || !Array.isArray(value.removed) || !Array.isArray(value.modified)
    || value.planted.length > MAX_OBJECTS || value.removed.length > MAX_EDITS || value.modified.length > MAX_EDITS) return null;
  const baseObjects = [...forestObjects(value.seed, { x: 0, y: 0, width: value.width, height: WORLD_HEIGHT }), ...initialProps()];
  const known = new Map(baseObjects.map(object => [object.id, object]));
  const planted: ForestObject[] = [];
  for (const entry of value.planted) {
    const object = readObject(entry, value.width);
    if (!object || !object.id.startsWith("planted:") || known.has(object.id)) return null;
    planted.push(object); known.set(object.id, object);
  }
  const removed = new Set<string>();
  for (const id of value.removed) {
    if (!validId(id) || !known.has(id) || removed.has(id)) return null;
    removed.add(id);
  }
  const modified: ForestObject[] = [];
  const modifiedIds = new Set<string>();
  for (const entry of value.modified) {
    const object = readObject(entry, value.width);
    const original = object && known.get(object.id);
    if (!object || !original || original.kind !== object.kind || removed.has(object.id) || modifiedIds.has(object.id)) return null;
    modified.push(object); modifiedIds.add(object.id);
  }
  return { version: 1, seed: value.seed, width: value.width, planted, removed: [...removed], modified };
}

export function parseScene(json: string): ForestScene | null {
  if (typeof json !== "string" || json.length > MAX_SCENE_BYTES) return null;
  try { return validateScene(JSON.parse(json)); } catch { return null; }
}

export function serializeScene(scene: ForestScene): string { return JSON.stringify(scene, null, 2); }

/** Only completed commands enter history; a pointer-drag preview remains outside it. */
export function createSceneHistory(initial: ForestScene, limit = 60) {
  let current = cloneScene(initial);
  const before: ForestScene[] = [], after: ForestScene[] = [];
  return {
    getScene() { return cloneScene(current); },
    get canUndo() { return before.length > 0; },
    get canRedo() { return after.length > 0; },
    commit(scene: ForestScene) {
      if (JSON.stringify(current) === JSON.stringify(scene)) return false;
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
