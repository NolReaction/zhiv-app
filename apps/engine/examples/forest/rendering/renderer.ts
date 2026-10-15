import { createScenePainter, type SceneRenderOptions, type CanvasFactory, type ImageLoader } from "@/packages/engine/src/rendering/renderer";
import type { EngineObject } from "@/packages/engine/src/scene/contracts";
import type { ForestObject } from "../scene/objects";
import { DEFAULT_FOLDERS } from "../scene/folders";
import { DEFAULT_FOREST_PRESET } from "../forest-preset";
export type { CanvasFactory, ImageLoader } from "@/packages/engine/src/rendering/renderer";
export type ForestOptions = Omit<SceneRenderOptions, "height" | "objectFilter" | "planted" | "modified" | "previewObjects"> & {
  trees: boolean; grid: boolean; planted: readonly ForestObject[];
  modified?: ReadonlyMap<string, ForestObject>; previewObjects?: ReadonlyMap<string, ForestObject>;
};
const withoutVegetation = (object: EngineObject) => object.kind !== "tree" && object.kind !== "shrub";
export function createForestPainter(makeCanvas: CanvasFactory, onAssetsChanged?: () => void, loadImage?: ImageLoader) {
  const painter = createScenePainter(makeCanvas, DEFAULT_FOREST_PRESET, onAssetsChanged, loadImage);
  const records = new WeakMap<ForestOptions, SceneRenderOptions>();
  const optionsFor = (options: ForestOptions) => {
    let record = records.get(options);
    if (!record) { record = { ...options, height: 1600 }; records.set(options, record); }
    Object.assign(record, options, { height: 1600, objectFilter: options.trees ? undefined : withoutVegetation, folders: options.folders ?? DEFAULT_FOLDERS });
    return record;
  };
  return { ...painter,
    paint: (ctx: CanvasRenderingContext2D, view: { x: number; y: number; width: number; height: number }, options: ForestOptions) => painter.paint(ctx, view, optionsFor(options)),
    objects: (options: ForestOptions): ForestObject[] => painter.objects(optionsFor(options)) as ForestObject[],
  };
}
