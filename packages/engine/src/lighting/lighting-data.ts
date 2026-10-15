export type ScenePointLight = {
  id: string; name: string; x: number; y: number; radius: number; intensity: number; color: string; enabled: boolean;
};
export type LightingState = {
  enabled: boolean; ambient: number; ambientColor: string; sunAngle: number; sunElevation: number;
  sunIntensity: number; sunColor: string; shadowOpacity: number; shadowSoftness: number; points: ScenePointLight[];
};

export const MAX_POINT_LIGHTS = 32;
import { validateSceneSize } from "../scene/contracts.ts";
const lightingKeys = new Set(["enabled", "ambient", "ambientColor", "sunAngle", "sunElevation", "sunIntensity", "sunColor", "shadowOpacity", "shadowSoftness", "points"]);
const pointKeys = new Set(["id", "name", "x", "y", "radius", "intensity", "color", "enabled"]);

export function initialLighting(): LightingState {
  return { enabled: false, ambient: 1, ambientColor: "#ffffff", sunAngle: 135, sunElevation: 45,
    sunIntensity: .4, sunColor: "#fff3d8", shadowOpacity: .3, shadowSoftness: 8, points: [] };
}

export function cloneLighting(state: LightingState): LightingState {
  return { ...state, points: state.points.map(point => ({ ...point })) };
}

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}
function finite(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= min && value <= max;
}
function color(value: unknown): value is string { return typeof value === "string" && /^#[\da-f]{6}$/i.test(value); }
function validId(value: unknown): value is string {
  return typeof value === "string" && value.length <= 128 && /^[a-zA-Z0-9:_.-]+$/.test(value)
    && !["__proto__", "constructor", "prototype"].includes(value);
}
function validName(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 100 && value === value.trim() && !/[\u0000-\u001f\u007f]/.test(value);
}

/** Strict import validation copies the small records and never changes a live scene. */
export function validateLighting(value: unknown, width: number, height = width): LightingState | null {
  if (!validateSceneSize({ width, height }) || !record(value)
    || Reflect.ownKeys(value).some(key => typeof key !== "string" || !lightingKeys.has(key))
    || typeof value.enabled !== "boolean" || !finite(value.ambient, .15, 1.5) || !color(value.ambientColor)
    || !finite(value.sunAngle, 0, 359) || !finite(value.sunElevation, 10, 85)
    || !finite(value.sunIntensity, 0, 1.5) || !color(value.sunColor)
    || !finite(value.shadowOpacity, 0, .8) || !finite(value.shadowSoftness, 0, 24)
    || !Array.isArray(value.points) || value.points.length > MAX_POINT_LIGHTS) return null;
  const points: ScenePointLight[] = [], ids = new Set<string>();
  for (const point of value.points) {
    if (!record(point) || Reflect.ownKeys(point).some(key => typeof key !== "string" || !pointKeys.has(key))
      || !validId(point.id) || ids.has(point.id) || !validName(point.name)
      || !finite(point.x, 0, width) || !finite(point.y, 0, height)
      || !finite(point.radius, 32, 800) || !finite(point.intensity, 0, 2)
      || !color(point.color) || typeof point.enabled !== "boolean") return null;
    ids.add(point.id); points.push({ id: point.id, name: point.name, x: point.x, y: point.y,
      radius: point.radius, intensity: point.intensity, color: point.color, enabled: point.enabled });
  }
  return { enabled: value.enabled, ambient: value.ambient, ambientColor: value.ambientColor,
    sunAngle: value.sunAngle, sunElevation: value.sunElevation, sunIntensity: value.sunIntensity,
    sunColor: value.sunColor, shadowOpacity: value.shadowOpacity, shadowSoftness: value.shadowSoftness, points };
}
