import * as core from "@/packages/engine/src/lighting/lighting-renderer";
import type { CasterSource } from "@/packages/engine/src/lighting/lighting-renderer";
import { getObjectShadowHeight, type ForestObject } from "../scene/objects";
import type { LightingState, ScenePointLight } from "./lighting-data";
export type { CasterSource, ShadowProjection } from "@/packages/engine/src/lighting/lighting-renderer";
const heightFor = (object: import("@/packages/engine/src/scene/contracts").EngineObject) => getObjectShadowHeight(object as ForestObject);
export const sunShadowProjection = (object: ForestObject, source: {x:number;y:number;width:number;height:number}, light: Pick<LightingState, "sunAngle" | "sunElevation">) => core.sunShadowProjection(object, source, light, heightFor);
export const pointShadowProjection = (object: ForestObject, source: {x:number;y:number;width:number;height:number}, light: ScenePointLight) => core.pointShadowProjection(object, source, light, heightFor);
export function createLightingRenderer(makeCanvas: (width: number, height: number) => HTMLCanvasElement, sourceFor: (object: ForestObject) => CasterSource) {
  const renderer = core.createLightingRenderer(makeCanvas, object => sourceFor(object as ForestObject), heightFor);
  return { ...renderer, sync(width: number, state: LightingState, objects: readonly ForestObject[], previews: ReadonlyMap<string, ForestObject> | undefined, revision: number | undefined, visible: (object: ForestObject) => boolean) {
    return renderer.sync(width, state, objects, previews, revision, object => visible(object as ForestObject), 1600);
  } };
}
