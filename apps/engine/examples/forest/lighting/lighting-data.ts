import { validateLighting as validate } from "@/packages/engine/src/lighting/lighting-data";
export { MAX_POINT_LIGHTS, initialLighting, cloneLighting } from "@/packages/engine/src/lighting/lighting-data";
export type { LightingState, ScenePointLight } from "@/packages/engine/src/lighting/lighting-data";
export const validateLighting = (value: unknown, width: number) => width <= 3200 ? validate(value, width, 1600) : null;
