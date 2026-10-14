import * as core from "@/packages/engine/src/scene/objects";
import type { EngineObject, Bounds } from "@/packages/engine/src/scene/contracts";
import { FOREST_CATALOG } from "../forest-catalog";
import { hash, sampleGround } from "../terrain/layout";
import { sampleEditedGround, type TerrainPreview, type TerrainState } from "../terrain/terrain-data";
import { DEFAULT_LAYERS, type SceneLayer } from "./stacking";
import { DEFAULT_FOLDERS, type SceneFolder } from "./folders";
export { objectDepth } from "./stacking";
export type { Bounds } from "@/packages/engine/src/scene/contracts";
export type ObjectKind = "tree" | "shrub" | "rock" | "ruins" | "bridge" | "jetty" | "image";
export type ForestObject = EngineObject<ObjectKind>;
export const objectLocalBounds = (object: ForestObject) => core.objectLocalBounds(object, FOREST_CATALOG);
export const objectAngle = (object: ForestObject) => core.objectAngle(object, FOREST_CATALOG);
export const objectCorners = (object: ForestObject) => core.objectCorners(object, FOREST_CATALOG);
export const objectBounds = (object: ForestObject) => core.objectBounds(object, FOREST_CATALOG);
export const getObjectShadowHeight = (object: ForestObject) => core.getObjectShadowHeight(object, FOREST_CATALOG);
export const compareObjects = (a: ForestObject, b: ForestObject, layers: readonly SceneLayer[] = DEFAULT_LAYERS) => core.compareObjects(a, b, layers, FOREST_CATALOG);
export const pickObject = (objects: readonly ForestObject[], x: number, y: number, layers: readonly SceneLayer[] = DEFAULT_LAYERS, folders: readonly SceneFolder[] = DEFAULT_FOLDERS) => core.pickObject(objects, x, y, layers, folders, FOREST_CATALOG);
export const INITIAL_WIDTH = 1600;
export const WORLD_HEIGHT = 1600;
export const MAX_WIDTH = 3200;
export const INITIAL_SEED = 7391;
export const OVERSCAN_EDIT_MARGIN = 320;

/** Props use the same scene records as vegetation, with their original ground anchors. */
export function initialProps(): ForestObject[] {
  return [
    { id: "prop:ruins", kind: "ruins", x: 780, y: 420, scale: 1, variant: 0 },
    { id: "prop:jetty", kind: "jetty", x: 1330, y: 1070, scale: 1, variant: 0 },
    { id: "prop:bridge", kind: "bridge", x: 749, y: 1249, scale: 1, variant: 0 },
  ];
}

function reservedForProp(x: number, y: number): boolean {
  return (Math.abs(x - 780) < 100 && Math.abs(y - 420) < 100)
    || (x > 1300 && x < 1480 && y > 1020 && y < 1170)
    || (x > 675 && x < 830 && y > 1200 && y < 1300);
}

/** Grid IDs and absolute coordinates deliberately never depend on world size. */
export function forestObjects(seed: number, bounds: Bounds): ForestObject[] {
  const result: ForestObject[] = [];
  const cell = 62;
  for (let gy = Math.floor((bounds.y - 190) / cell); gy <= Math.ceil((bounds.y + bounds.height + 190) / cell); gy++) {
    for (let gx = Math.floor((bounds.x - 190) / cell); gx <= Math.ceil((bounds.x + bounds.width + 190) / cell); gx++) {
      const x = (gx + .18 + hash(gx, gy, seed) * .64) * cell;
      const y = (gy + .18 + hash(gx, gy, seed + 1) * .64) * cell;
      const ground = sampleGround(x, y);
      if (ground.water > -24 || ground.path > .12) continue;
      // Keep the authored ruin, quay and central buildable meadow readable.
      if (reservedForProp(x, y)) continue;
      const choice = hash(gx, gy, seed + 2);
      const treeProbability = .94 * (1 - ground.clearing);
      const kind = choice < treeProbability ? "tree" : choice > .955 ? "rock" : choice > .81 ? "shrub" : null;
      if (!kind) continue;
      result.push({ id: `${gx}:${gy}`, x, y, scale: .7 + hash(gx, gy, seed + 3) * .42,
        variant: Math.floor(hash(gx, gy, seed + 4) * 24), kind });
    }
  }
  return result.sort((a, b) => a.y - b.y || a.x - b.x);
}

export function canPlant(x: number, y: number, width: number, terrain?: TerrainState, preview?: TerrainPreview): boolean {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
  if (x < 0 || y < 0 || x > width || y > WORLD_HEIGHT) return false;
  if (reservedForProp(x, y)) return false;
  const ground = terrain ? sampleEditedGround(x, y, terrain, preview) : sampleGround(x, y);
  return ground.water < -28 && ground.path < .2;
}
