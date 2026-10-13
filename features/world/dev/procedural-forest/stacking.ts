import type { ForestObject } from "./objects";

export type SceneLayer = { id: string; name: string; visible: boolean; locked: boolean };
export const MAX_SCENE_LAYERS = 32;
export const MAX_STACK_COMPONENTS = 256;
export const MAX_STACK_VALUE = 1_000_000_000;
export const DEFAULT_LAYERS: readonly SceneLayer[] = Object.freeze([
  Object.freeze({ id: "background", name: "Задний план", visible: true, locked: false }),
  Object.freeze({ id: "world", name: "Мир", visible: true, locked: false }),
  Object.freeze({ id: "foreground", name: "Передний план", visible: true, locked: false }),
]);

export function defaultLayers(): SceneLayer[] { return DEFAULT_LAYERS.map(layer => ({ ...layer })); }
export function objectLayerId(object: ForestObject): string { return object.layerId ?? "world"; }

export function isObjectVisible(object: ForestObject, layers: readonly SceneLayer[] = DEFAULT_LAYERS): boolean {
  return !object.hidden && layers.some(layer => layer.id === objectLayerId(object) && layer.visible);
}

export function isObjectLocked(object: ForestObject, layers: readonly SceneLayer[] = DEFAULT_LAYERS): boolean {
  const layer = layers.find(layer => layer.id === objectLayerId(object));
  return !!object.locked || !layer || layer.locked;
}

/** Props preserve their authored contact depth; manual placement can override this key. */
export function objectDepth(object: ForestObject): number {
  const offset = object.kind === "ruins" ? 20 : object.kind === "jetty" ? 70 : object.kind === "bridge" ? 31 : 0;
  return object.y + offset * object.scale * Math.cos((object.rotation ?? 0) * Math.PI / 180);
}

export function stackKey(object: ForestObject): readonly number[] {
  return object.stackOrder ?? [objectDepth(object), object.x, ...Array.from(object.id, character => character.charCodeAt(0))];
}

export function compareStackKeys(a: readonly number[], b: readonly number[]): number {
  for (let index = 0; index < Math.min(a.length, b.length); index++) {
    if (a[index] !== b[index]) return a[index] < b[index] ? -1 : 1;
  }
  return a.length - b.length;
}

export function validStackKey(value: unknown): value is number[] {
  return Array.isArray(value) && value.length > 0 && value.length <= MAX_STACK_COMPONENTS
    && Array.from(value).every(component => typeof component === "number" && Number.isFinite(component) && Math.abs(component) <= MAX_STACK_VALUE);
}

/** A dense lexicographic key keeps overlap stable without tying it to world coordinates. */
export function stackKeyBetween(lower?: readonly number[], upper?: readonly number[]): number[] {
  if ((lower && !validStackKey(lower)) || (upper && !validStackKey(upper))
    || (lower && upper && compareStackKeys(lower, upper) >= 0)) throw new RangeError("Нельзя вставить предмет между этими позициями.");
  let key: number[];
  if (!lower && !upper) key = [0];
  else if (!lower) key = [upper![0] - 1];
  else if (!upper) key = [lower[0] + 1];
  else {
    let common = 0;
    while (common < lower.length && common < upper.length && lower[common] === upper[common]) common++;
    if (common === lower.length) key = [...lower, upper[common] - 1];
    else {
      const middle = lower[common] + (upper[common] - lower[common]) / 2;
      key = middle > lower[common] && middle < upper[common] ? [...lower.slice(0, common), middle] : [...lower, 0];
    }
  }
  if (!validStackKey(key) || (lower && compareStackKeys(lower, key) >= 0) || (upper && compareStackKeys(key, upper) >= 0)) {
    throw new RangeError("Порядок предметов нужно перенумеровать.");
  }
  return key;
}
